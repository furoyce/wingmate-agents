// src/kit/install.ts — installs the kit into a worktree at claim and re-hashes it every tick (§8.0, §13.3 e/g).
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, readFile, readdir, readlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import type { Config, ProjectConfig } from "../config/schema";
import { WingmateError } from "../shared/errors";
import { run } from "../shared/exec";
import { readText, writeAtomic } from "../state/fs";
import type { WRecord } from "../state/records";
import { type BriefTicket, renderBrief } from "./brief";
import { type Launch, writeLocal } from "./local";
import { PROMPTS } from "./prompts";
import { PROTOCOL_MD } from "./protocol";
import { agentEnv, claudeSettings } from "./settings";

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

/** Content (with the executable bit) for files, the target for symlinks, the mode for anything else — nothing is followed or opened blindly (a FIFO would hang the tick). */
async function digest(path: string, commonConfig: string): Promise<string> {
  const s = await lstat(path);
  const h = createHash("sha256");
  if (s.isSymbolicLink()) h.update(`symlink\0${await readlink(path)}`);
  else if (!s.isFile()) h.update(`special\0${s.mode}`);
  else {
    h.update(`file\0${s.mode & 0o111 ? "x" : "-"}\0`);
    h.update(path === commonConfig ? canonicalGitConfig(await readFile(path, "utf8")) : await readFile(path));
  }
  return h.digest("hex");
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

/** Changed, added or removed files of the integrity set, plus modified/untracked files under the non-kit globs per `git status`. */
export async function verifyIntegrity(
  worktreePath: string,
  commonDir: string,
  expected: Record<string, string>,
): Promise<string[]> {
  const now = await integrityHashes(worktreePath, commonDir);
  const changed = new Set<string>();
  for (const [k, v] of Object.entries(expected)) if (now[k] !== v) changed.add(k);
  for (const k of Object.keys(now)) if (!(k in expected)) changed.add(k);
  const globs = INTEGRITY_GLOBS.filter((g) => !g.startsWith(".wingmate"));
  const st = await run(
    ["git", "-C", worktreePath, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...globs],
    { timeoutMs: 60_000 },
  );
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
 * Every Claude session that loads the worktree's settings — the coordinator and any worker or reviewer `worker-start` places in
 * it — is denied the spawn verbs: the coordinator reaches them only through `wingmate issue spawn`, a subprocess the permission
 * layer never sees. `task-create` stays allowed (graph-method DAGs).
 */
const COURTESY_DENY = ["Bash(orca orchestration worker-start *)", "Bash(orca orchestration dispatch *)"];

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

async function writeKitDir(i: InstallInput, settings: object): Promise<void> {
  await mkdir(join(i.kitDir, "gh-empty"), { recursive: true });
  await mkdir(join(i.kitDir, "no-hooks"), { recursive: true });
  await writeAtomic(join(i.kitDir, "claude-settings.json"), JSON.stringify(settings, null, 2), 0o644);
  await writeAtomic(
    join(i.kitDir, "gitconfig"),
    `[credential]\n\thelper =\n[core]\n\thooksPath = ${join(i.kitDir, "no-hooks")}\n[user]\n\tname = Wingmate\n\temail = wingmate@users.noreply.github.com\n`,
  );
  await writeAtomic(join(i.kitDir, "env.json"), JSON.stringify(agentEnv(i.kitDir), null, 2));
}

export async function installKit(i: InstallInput): Promise<{ hashes: Record<string, string> }> {
  const wt = i.worktreePath;
  const wm = join(wt, ".wingmate");
  const r = i.record;
  const repo = i.project.repos[r.repo];
  if (!repo)
    throw new WingmateError(
      "kit_install_failed",
      `repo ${r.repo} is not in project ${i.project.key}`,
      "fix config/projects.yaml or re-route the issue",
    );
  const common = r.worktree?.gitCommonDir ?? join(wt, ".git");
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
      branch: r.worktree?.branch ?? "",
      baseSha: r.worktree?.baseSha ?? "",
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
  const tiers: Launch["tiers"] = {};
  for (const [p, t] of Object.entries(i.tiers ?? {})) if (t) tiers[p] = { model: t.model, effort: t.effort };
  tiers[r.provider] = { model: i.launch.model, effort: i.launch.effort };
  const launch: Launch = {
    provider: r.provider,
    model: i.launch.model,
    effort: i.launch.effort,
    kitDir: i.kitDir,
    baseSha: r.worktree?.baseSha ?? null,
    commonDir: common,
    pinnedGates: repo.gates,
    ui: repo.ui,
    allowDeps: false,
    forbiddenPaths: [...i.project.forbiddenPaths, ...repo.forbiddenPaths],
    verifyCross: i.cfg.defaults.providers.verifyCross,
    workers: i.cfg.defaults.providers.workers,
    tiers,
    quota: i.cfg.defaults.quota,
  };
  await writeAtomic(join(wm, "launch.json"), JSON.stringify(launch, null, 2));
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
  const settings = claudeSettings({
    worktreePath: wt,
    childWorktrees: [],
    commonDir: common,
    gitdirName: r.worktree?.gitdirName ?? "",
    branch: r.worktree?.branch ?? "",
    baseBranch: repo.base,
    kitDir: i.kitDir,
    toolchainPaths: i.toolchainPaths,
    allowedDomains: [...i.cfg.defaults.sandbox.allowedDomains, ...repo.sandbox.allowedDomains],
    role: "coordinator",
  });
  await writeKitDir(i, settings);
  await writeCourtesySettings(wt, [
    ...(settings as { permissions: { deny: string[] } }).permissions.deny,
    ...COURTESY_DENY,
  ]);
  const created = await writeInstallPolicy(wt, repo.packageRoots);
  // Kit-created `.npmrc` files are excluded (anchored) so a `git add -A` cannot commit them into the path guard.
  await appendExclude(common, [".wingmate/", ".claude/settings.local.json", ...created.map((f) => `/${f}`)]);
  const hashes = await integrityHashes(wt, common);
  await writeAtomic(join(wm, "integrity.json"), JSON.stringify({ commonDir: common, hashes }, null, 2));
  return { hashes };
}
