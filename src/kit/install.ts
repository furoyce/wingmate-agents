// src/kit/install.ts — installs the kit into a worktree at claim and re-hashes it every tick (§8.0, §13.3 e/g).
import { createHash } from "node:crypto";
import { type Stats, existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, readlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import type { Config, ProjectConfig } from "../config/schema";
import { DISPATCHER_GIT_ENV } from "../git/cli";
import { verifyGitLinks } from "../git/trust";
import { WingmateError, errorCode } from "../shared/errors";
import { run } from "../shared/exec";
import { readText, writeAtomic } from "../state/fs";
import type { WRecord } from "../state/records";
import { type BriefTicket, renderBrief } from "./brief";
import { type Launch, writeLocal } from "./local";
import { PROMPTS } from "./prompts";
import { PROTOCOL_MD } from "./protocol";
import {
  type Role,
  SPAWN_ROLES,
  type SettingsInput,
  agentEnv,
  claudeSettings,
  isSiblingDeny,
  otherWorktrees,
  roleSettingsFile,
  roleSettingsFiles,
  siblingDenies,
} from "./settings";

export interface InstallInput {
  worktreePath: string;
  kitDir: string;
  record: WRecord;
  cfg: Config;
  project: ProjectConfig;
  issue: BriefTicket & { identifier: string; url: string };
  nonce: string;
  launch: { model: string; effort: string };
  /**
   * Tier `best` per review provider, resolved at claim (`resolveTier`, §9.2); `null` = `model_unresolved`. Written to
   * `launch.json` so `spawn` can pass `--model/--effort` to a cross-provider reviewer (§8.1); the coordinator's own provider
   * always takes `launch`.
   */
  tiers?: Partial<Record<"claude" | "codex", { model: string; effort: string } | null>>;
  toolchainPaths: string[];
  /** C28 (§13.3 e): the allow-deps grant as it stands at claim — `launch.json` `allowDeps`, which the agent-side `gate security` reads. */
  allowDeps?: boolean;
  /** SEC-1: the credential-named keys of the owner's user-level Claude env (`userClaudeCredentialEnv`), blanked in every settings file. */
  blankEnv?: readonly string[];
}

export interface InstallResult {
  hashes: Record<string, string>;
  /** `skipped_tracked`: the repo tracks `.claude/settings.local.json`, so the courtesy copy was not merged into it (F15). */
  courtesySettings: "written" | "skipped_tracked";
}

/**
 * Files whose hashes are pinned at claim; any change blocks the issue with `kit_tampered` (§6.3 step 6). `.wingmate/gates.json`
 * is deliberately absent: the `gate` verb writes its verdicts there (§8.1), while the pinned commands §6.3 meant to protect live
 * in the integrity-protected `launch.json` (`pinnedGates`).
 */
export const INTEGRITY_GLOBS = [
  ".wingmate/PROTOCOL.md",
  ".wingmate/BRIEF.md",
  ".wingmate/prompts",
  ".wingmate/launch.json",
  ".claude",
  ".mcp.json",
  ".codex",
  ".cursor",
  ".gemini",
  "CLAUDE.md",
  "AGENTS.md",
  "GEMINI.md",
];

/** `.wingmate/integrity.json`: the claim-time hashes `spawn` re-checks before `worker-start` (advisory; the tick re-checks
 * against the hashes it ledgered at claim). */
export const IntegrityFileSchema = z.object({ commonDir: z.string().min(1), hashes: z.record(z.string()) });

const isMissing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";

/** Every entry under `p`, never following symlinks: a planted link to `/` must not make the tick walk the disk. */
async function walk(p: string): Promise<string[]> {
  let s: Stats;
  try {
    s = await lstat(p);
  } catch (e) {
    if (isMissing(e)) return [];
    throw e;
  }
  if (!s.isDirectory()) return [p];
  const out: string[] = [];
  for (const n of (await readdir(p)).sort()) out.push(...(await walk(join(p, n))));
  return out;
}

export async function integritySet(worktreePath: string, commonDir: string): Promise<string[]> {
  const files: string[] = [];
  for (const g of INTEGRITY_GLOBS) files.push(...(await walk(join(worktreePath, g))));
  files.push(...(await walk(join(commonDir, "config"))), ...(await walk(join(commonDir, "hooks"))));
  return files.sort();
}

/**
 * Git rewrites `[branch "<name>"]` sections of the shared config by itself — `worktree add` from a remote-tracking base and
 * `push -u` record upstreams — and those keys execute nothing, so they are left out of the hash; everything else counts.
 */
export function canonicalGitConfig(text: string): string {
  let skip = false;
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const header = /^\s*\[([^\]]*)\]/.exec(line);
    if (header) skip = /^\s*branch(\s+"[^"]*"|\.\S+)\s*$/i.test(header[1] ?? "");
    if (!skip && line.trim() !== "") out.push(line); // blank lines carry no meaning in git config
  }
  return out.join("\n");
}

/** A regular file's integrity digest from its content and executable bit (C28: what the tick writes into the kit is pinned by it). */
export const contentDigest = (content: string | Buffer, executable: boolean): string =>
  createHash("sha256")
    .update(`file\0${executable ? "x" : "-"}\0`)
    .update(content)
    .digest("hex");

/** Content (with the executable bit) for files, the target for symlinks, the mode for anything else — nothing is followed or opened blindly (a FIFO would hang the tick). */
async function digest(path: string, commonConfig: string): Promise<string> {
  const s = await lstat(path);
  if (s.isSymbolicLink())
    return createHash("sha256")
      .update(`symlink\0${await readlink(path)}`)
      .digest("hex");
  if (!s.isFile()) return createHash("sha256").update(`special\0${s.mode}`).digest("hex");
  const content =
    path === commonConfig ? canonicalGitConfig(await readFile(path, "utf8")) : await readFile(path);
  return contentDigest(content, (s.mode & 0o111) !== 0);
}

/** Hashes of the integrity set keyed by worktree-relative path (common-dir files outside the worktree keep their absolute path). */
export async function integrityHashes(
  worktreePath: string,
  commonDir: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const commonConfig = join(commonDir, "config");
  for (const f of await integritySet(worktreePath, commonDir)) {
    const key = f.startsWith(`${worktreePath}/`) ? relative(worktreePath, f) : f;
    out[key] = await digest(f, commonConfig);
  }
  return out;
}

/** `git status --porcelain -z` entries: `XY path`, and for renames/copies `XY new` followed by the original path (both reported). */
function porcelainPaths(out: string): string[] {
  const parts = out.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i] ?? "";
    if (e.length < 4) continue;
    paths.push(e.slice(3));
    if (e[0] === "R" || e[0] === "C") {
      const orig = parts[++i];
      if (orig) paths.push(orig);
    }
  }
  return paths;
}

/**
 * Changed, added or removed files of the integrity set, plus modified/untracked files under the non-kit globs per `git status`. With
 * the worktree's own `gitDir` (the dispatcher's checks, C22), its gitfile and commondir must still name that gitdir and `commonDir`
 * — otherwise `.git` is reported changed and no git runs through them — and `git status` runs with both pinned.
 */
export async function verifyIntegrity(
  worktreePath: string,
  commonDir: string,
  expected: Record<string, string>,
  gitDir?: string,
): Promise<string[]> {
  const now = await integrityHashes(worktreePath, commonDir);
  const changed = new Set<string>();
  for (const [k, v] of Object.entries(expected)) if (now[k] !== v) changed.add(k);
  for (const k of Object.keys(now)) if (!(k in expected)) changed.add(k);
  const globs = INTEGRITY_GLOBS.filter((g) => !g.startsWith(".wingmate"));
  let git = ["git", "-C", worktreePath];
  const env: Record<string, string> = { ...DISPATCHER_GIT_ENV }; // the index refresh runs no hook and no fsmonitor (D14)
  if (gitDir !== undefined) {
    if (!existsSync(worktreePath))
      throw new WingmateError("integrity_unverifiable", `the worktree ${worktreePath} is gone`);
    try {
      await verifyGitLinks({ path: worktreePath, gitDir, commonDir });
    } catch (e) {
      if (errorCode(e) !== "git_dir_tampered") throw e;
      return [...changed.add(".git")].sort();
    }
    git = [...git, `--git-dir=${gitDir}`, `--work-tree=${worktreePath}`];
    env.GIT_COMMON_DIR = commonDir;
  }
  const st = await run([...git, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...globs], {
    timeoutMs: 60_000,
    env,
  });
  if (st.code !== 0)
    throw new WingmateError(
      "integrity_unverifiable",
      `git status in ${worktreePath} failed (exit ${st.code}): ${st.stderr.trim().slice(0, 200)}`,
    );
  for (const p of porcelainPaths(st.stdout)) changed.add(p);
  return [...changed].sort();
}

const CourtesyZ = z
  .object({
    permissions: z
      .object({ deny: z.array(z.string()).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

/**
 * §5.4 step 4: the courtesy copy of the coordinator's deny list. Every Claude session started in the worktree loads it on top of its
 * own `--settings` file — the coordinator, and the verifiers, reviewers and workers `spawn` launches under their per-role kit
 * settings files (§8.1) — and a deny from either applies. The kit dir's files are authoritative; the coordinator's already deny
 * worker-start and dispatch (C4), so nothing is lost when a repo tracks this file and it is left alone (F15).
 */
const COURTESY_FILE = ".claude/settings.local.json";

/** Whether git tracks `rel` in the worktree; a failing `git ls-files` is an error, never "untracked". */
async function isTracked(wt: string, rel: string): Promise<boolean> {
  const r = await run(["git", "-C", wt, "ls-files", "-z", "--", rel], {
    timeoutMs: 30_000,
    env: { ...DISPATCHER_GIT_ENV },
  });
  if (r.code !== 0)
    throw new WingmateError(
      "kit_install_failed",
      `git ls-files in ${wt} failed (exit ${r.code}): ${r.stderr.trim().slice(0, 200)}`,
      "check the worktree's git state, then re-queue the issue",
    );
  return r.stdout.length > 0;
}

/** §5.4 step 4: the courtesy copy of the deny rules, merged into an existing `.claude/settings.local.json`. */
async function writeCourtesySettings(wt: string, deny: string[]): Promise<void> {
  const file = join(wt, ".claude", "settings.local.json");
  const cur = await readText(file);
  let existing: z.infer<typeof CourtesyZ> = {};
  if (cur !== null) {
    let raw: unknown;
    try {
      raw = JSON.parse(cur);
    } catch (e) {
      throw new WingmateError(
        "kit_install_failed",
        `.claude/settings.local.json is not valid JSON: ${(e as Error).message}`,
        "fix or remove the file, then re-queue the issue",
      );
    }
    const parsed = CourtesyZ.safeParse(raw);
    if (!parsed.success)
      throw new WingmateError(
        "kit_install_failed",
        `.claude/settings.local.json: ${parsed.error.issues[0]?.path.join(".") ?? ""} ${parsed.error.issues[0]?.message ?? ""}`,
        "fix or remove the file, then re-queue the issue",
      );
    existing = parsed.data;
  }
  const prior = existing.permissions?.deny ?? [];
  const merged = {
    ...existing,
    permissions: { ...existing.permissions, deny: [...new Set([...prior, ...deny])] },
  };
  await writeAtomic(file, JSON.stringify(merged, null, 2));
}

/** §13.3(e): `ignore-scripts=true` in every package root's `.npmrc` (an existing `false` is overridden); returns the files it created. */
async function writeInstallPolicy(wt: string, roots: string[]): Promise<string[]> {
  const created: string[] = [];
  for (const root of roots) {
    const dir = join(wt, root);
    await mkdir(dir, { recursive: true });
    const npmrc = join(dir, ".npmrc");
    const cur = await readText(npmrc);
    if (cur === null) created.push(relative(wt, npmrc));
    if (/^\s*ignore-scripts\s*=\s*true\s*$/m.test(cur ?? "")) continue;
    let replaced = false;
    const kept = (cur ?? "").replace(/^\s*ignore-scripts\s*=.*$/gm, () => {
      replaced = true;
      return "ignore-scripts=true";
    });
    await writeAtomic(
      npmrc,
      replaced ? kept : `${kept}${kept && !kept.endsWith("\n") ? "\n" : ""}ignore-scripts=true\n`,
    );
  }
  return created;
}

/** Appends to `<gitCommonDir>/info/exclude` the lines it does not already hold (shared by every worktree of the repo). */
async function appendExclude(common: string, lines: string[]): Promise<void> {
  const excl = join(common, "info", "exclude");
  const cur = (await readText(excl)) ?? "";
  const have = new Set(cur.split("\n"));
  const add = lines.filter((l) => !have.has(l));
  if (add.length)
    await writeAtomic(excl, `${cur}${cur === "" || cur.endsWith("\n") ? "" : "\n"}${add.join("\n")}\n`);
}

const KitSettingsZ = z
  .object({
    sandbox: z
      .object({ filesystem: z.object({ denyWrite: z.array(z.string()) }).passthrough() })
      .passthrough(),
  })
  .passthrough();

/** Every Claude settings file in a kit dir: the coordinator's, then one per spawned role (§8.1). */
const settingsFiles = (kitDir: string): string[] => [
  join(kitDir, "claude-settings.json"),
  ...SPAWN_ROLES.map((r) => roleSettingsFile(kitDir, r)),
];

/** A kit settings file, Zod-validated; missing or invalid files are errors with context, never skipped. */
async function readKitSettings(file: string): Promise<{ text: string; s: z.infer<typeof KitSettingsZ> }> {
  const again = "re-queue the issue so the kit is installed again";
  const text = await readText(file);
  if (text === null) throw new WingmateError("kit_install_failed", `${file} is missing`, again);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new WingmateError(
      "kit_install_failed",
      `${file} is not valid JSON: ${(e as Error).message}`,
      again,
    );
  }
  const parsed = KitSettingsZ.safeParse(raw);
  if (!parsed.success)
    throw new WingmateError(
      "kit_install_failed",
      `${file}: ${parsed.error.issues[0]?.path.join(".") ?? ""} ${parsed.error.issues[0]?.message ?? ""}`,
      again,
    );
  // The validated input rather than Zod's output, which reorders keys: an unchanged list leaves the file byte-identical.
  return { text, s: raw as z.infer<typeof KitSettingsZ> };
}

/**
 * Re-lists the other worktrees' gitdirs and checked-out branches (F7, F10) into every settings file of the kit — the coordinator's
 * and each spawned role's — and returns the denied paths. `installKit` lists them at claim; the tick calls this before every
 * (re)launch and after a claim or cleanup in the same repo, with the record's `gitCommonDir`, `gitdirName` and `branch` (the own
 * branch comes from the record: the agent can rewrite its own HEAD). A sibling HEAD naming no valid branch adds nothing, and no deny
 * ever names the own branch, its lock or their directories (C9, `siblingBranchDenyWrite`). Claude Code pins a `--settings` file's
 * content at launch (2.1.292), so a running session keeps the lists it started with until it is relaunched.
 */
export async function refreshSiblingDenies(
  kitDir: string,
  commonDir: string,
  gitdirName: string,
  branch: string,
  env?: Record<string, string>,
): Promise<string[]> {
  const files = [];
  for (const file of settingsFiles(kitDir)) files.push({ file, ...(await readKitSettings(file)) });
  const siblings = siblingDenies(commonDir, gitdirName, branch);
  for (const { file, text, s } of files) {
    const denyWrite = [
      ...s.sandbox.filesystem.denyWrite.filter((p) => !isSiblingDeny(commonDir, p)),
      ...siblings,
    ];
    // SEC-1: before a (re)launch the env block follows the owner's user-level Claude env as it is now
    const next = JSON.stringify(
      {
        ...s,
        ...(env ? { env } : {}),
        sandbox: { ...s.sandbox, filesystem: { ...s.sandbox.filesystem, denyWrite } },
      },
      null,
      2,
    );
    if (next !== text) await writeAtomic(file, next, 0o644);
  }
  return siblings;
}

async function writeKitDir(i: InstallInput, settings: Record<Role, object>): Promise<void> {
  await mkdir(join(i.kitDir, "gh-empty"), { recursive: true });
  await mkdir(join(i.kitDir, "no-hooks"), { recursive: true });
  await writeAtomic(
    join(i.kitDir, "claude-settings.json"),
    JSON.stringify(settings.coordinator, null, 2),
    0o644,
  );
  for (const role of SPAWN_ROLES)
    await writeAtomic(roleSettingsFile(i.kitDir, role), JSON.stringify(settings[role], null, 2), 0o644);
  await writeAtomic(
    join(i.kitDir, "gitconfig"),
    `[credential]\n\thelper =\n[core]\n\thooksPath = ${join(i.kitDir, "no-hooks")}\n[user]\n\tname = Wingmate\n\temail = wingmate@users.noreply.github.com\n`,
  );
  await writeAtomic(
    join(i.kitDir, "env.json"),
    JSON.stringify(agentEnv(i.kitDir, "coordinator", i.blankEnv), null, 2),
  );
}

type Repo = ProjectConfig["repos"][string];
type Worktree = NonNullable<WRecord["worktree"]>;

/** `.wingmate/launch.json`: what `gate` and `spawn` need, resolved at claim (§8.0, §8.1, §9.2). */
function launchFile(i: InstallInput, repo: Repo, w: Worktree): Launch {
  const r = i.record;
  const tiers: Launch["tiers"] = {};
  for (const [p, t] of Object.entries(i.tiers ?? {})) if (t) tiers[p] = { model: t.model, effort: t.effort };
  tiers[r.provider] = { model: i.launch.model, effort: i.launch.effort };
  return {
    provider: r.provider,
    model: i.launch.model,
    effort: i.launch.effort,
    kitDir: i.kitDir,
    worktreeId: w.id,
    roleSettings: roleSettingsFiles(i.kitDir),
    baseSha: w.baseSha,
    commonDir: w.gitCommonDir,
    pinnedGates: repo.gates,
    ui: repo.ui,
    allowDeps: i.allowDeps ?? false,
    forbiddenPaths: [...i.project.forbiddenPaths, ...repo.forbiddenPaths],
    verifyCross: i.cfg.defaults.providers.verifyCross,
    workers: i.cfg.defaults.providers.workers,
    tiers,
    quota: i.cfg.defaults.quota,
  };
}

/**
 * The coordinator's settings and one per spawned role (§8.1): the same paths and network, each role's own deny list. The other
 * worktrees' gitdirs and branches are listed once, so the six files agree (F7, F10); `refreshSiblingDenies` re-lists them later.
 */
function agentSettings(i: InstallInput, repo: Repo, w: Worktree): Record<Role, object> {
  const known = otherWorktrees(w.gitCommonDir, w.gitdirName);
  const base: SettingsInput = {
    worktreePath: i.worktreePath,
    childWorktrees: [],
    commonDir: w.gitCommonDir,
    gitdirName: w.gitdirName,
    branch: w.branch,
    baseBranch: repo.base,
    kitDir: i.kitDir,
    toolchainPaths: i.toolchainPaths,
    allowedDomains: [...i.cfg.defaults.sandbox.allowedDomains, ...repo.sandbox.allowedDomains],
    role: "coordinator",
    siblingGitdirs: known.gitdirs,
    siblingBranches: known.branches,
    blankEnv: i.blankEnv,
  };
  const of = (role: Role) => claudeSettings({ ...base, role });
  return {
    coordinator: of("coordinator"),
    "plan-verifier": of("plan-verifier"),
    "code-reviewer": of("code-reviewer"),
    "security-reviewer": of("security-reviewer"),
    "ui-reviewer": of("ui-reviewer"),
    worker: of("worker"),
  };
}

export async function installKit(i: InstallInput): Promise<InstallResult> {
  const wt = i.worktreePath;
  const wm = join(wt, ".wingmate");
  const r = i.record;
  const w = r.worktree;
  // F14: the git paths of every settings file come from the worktree; empty ones would widen the grants
  if (!w)
    throw new WingmateError(
      "kit_no_worktree",
      `${r.identifier} has no worktree recorded, so the kit has no branch, gitdir or common dir to scope`,
      "create the issue worktree (claim step) before installing the kit",
    );
  const repo = i.project.repos[r.repo];
  if (!repo)
    throw new WingmateError(
      "kit_install_failed",
      `repo ${r.repo} is not in project ${i.project.key}`,
      "fix config/projects.yaml or re-route the issue",
    );
  const common = w.gitCommonDir;
  const settings = agentSettings(i, repo, w); // before any write: a settings_invalid leaves nothing half-installed
  for (const d of ["evidence", "inbox", "outbox", "ticket", "prompts"])
    await mkdir(join(wm, d), { recursive: true });
  await writeAtomic(join(wm, "PROTOCOL.md"), PROTOCOL_MD);
  await writeAtomic(
    join(wm, "BRIEF.md"),
    renderBrief({
      identifier: r.identifier,
      project: r.project,
      repo: r.repo,
      worktreePath: wt,
      branch: w.branch,
      baseSha: w.baseSha,
      provider: r.provider,
      launch: i.launch,
      autonomy: r.autonomy,
      routing: r.routing,
      conventions: i.project.conventions,
      gates: repo.gates,
      ui: repo.ui,
      nonce: i.nonce,
      ticket: i.issue,
    }),
  );
  for (const [k, v] of Object.entries(PROMPTS)) await writeAtomic(join(wm, "prompts", `${k}.md`), v);
  await writeAtomic(join(wm, "gates.json"), JSON.stringify({}, null, 2));
  await writeAtomic(join(wm, "launch.json"), JSON.stringify(launchFile(i, repo, w), null, 2));
  await writeAtomic(join(wm, "ticket", "title.md"), i.issue.title);
  await writeAtomic(join(wm, "ticket", "description.md"), i.issue.description ?? "");
  await writeAtomic(
    join(wm, "ticket", "comments.md"),
    i.issue.comments.map((c) => `--- ${c.author} ---\n${c.body}`).join("\n\n"),
  );
  await writeLocal(wt, {
    record: {
      identifier: r.identifier,
      stage: r.stage,
      pipelineStage: r.pipelineStage,
      provider: r.provider,
      childRunId: r.coordinator.childRunId,
    },
    gates: {},
    questions: [],
    run: null,
  });
  await writeKitDir(i, settings);
  // F15: a tracked courtesy file stays as the repo has it — merging would show as a local change and trip `kit_tampered`; the
  // authoritative settings are the kit dir's
  const tracked = await isTracked(wt, COURTESY_FILE);
  if (!tracked)
    await writeCourtesySettings(
      wt,
      (settings.coordinator as { permissions: { deny: string[] } }).permissions.deny,
    );
  const created = await writeInstallPolicy(wt, repo.packageRoots);
  // Kit-created `.npmrc` files are excluded (anchored) so a `git add -A` cannot commit them into the path guard.
  await appendExclude(common, [".wingmate/", COURTESY_FILE, ...created.map((f) => `/${f}`)]);
  const hashes = await integrityHashes(wt, common);
  await writeAtomic(join(wm, "integrity.json"), JSON.stringify({ commonDir: common, hashes }, null, 2));
  return { hashes, courtesySettings: tracked ? "skipped_tracked" : "written" };
}
