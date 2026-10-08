// src/ops/install.ts — §4.3: the long-lived dispatcher worktree, the compiled binary (`bun build --compile` to
// <state>/bin/wingmate-<version>, hashed, linked from ~/.local/bin/wingmate), the Orca automation created or edited idempotently,
// `core.useReplaceRefs=false` in each pilot repository (R30), the saved views (§11.5, only as the OAuth app) and install.json. The
// automation is written disabled first; only `--enable` with a doctor that passes every blocking check — run after install.json names
// the new binary — turns it on (§13.3 "a failing check refuses `install --enable`").
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, symlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { Config } from "../config/schema";
import { shellQuote } from "../kit/settings";
import { readCredentials, writeCredentials } from "../linear/auth";
import type { Ctx } from "../machine/context";
import { scanText } from "../policy/secrets";
import { WingmateError, errorCode } from "../shared/errors";
import { run } from "../shared/exec";
import { newUlid } from "../shared/ids";
import type { Dirs } from "../shared/paths";
import { readText, writeAtomic } from "../state/fs";
import type { DoctorReport } from "./doctor";
import { type RepoSetting, disableReplaceRefsInPilots } from "./repoSettings";

export const InstallStateSchema = z.object({
  version: z.string(),
  automationId: z.string().nullable(),
  worktreeId: z.string(),
  binPath: z.string(),
  sha256: z.string(),
  viewUrls: z.array(z.string()),
  installedAt: z.string(),
  enabled: z.boolean(),
});
export type InstallState = z.infer<typeof InstallStateSchema>;
export interface InstallResult extends InstallState {
  /** The saved views could not be written (an error code); the CLI then prints the manual recipe. */
  viewsError: string | null;
  /** R30: `core.useReplaceRefs=false` in each pilot repository — set now, already set, or failed with the reason. */
  repoSettings: RepoSetting[];
}

export const AUTOMATION_NAME = "wingmate-dispatcher";
export const DISPATCHER_WORKTREE = "wingmate-dispatcher";
export const AUTOMATION_PROMPT =
  "This automation never runs an agent. If you are reading this, print UNEXPECTED_AGENT_RUN and stop.";
/** A version is a path component of the binary and a word of the precheck command: semver characters only. */
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

/** The precheck line Orca runs (D15): the whole tick, which never exits 0. */
export const precheckCommand = (binPath: string): string => `${shellQuote([binPath])} tick --precheck`;

/** §4.3 exactly: `orca automations create …` (the client adds `--json`); `--disabled` unless `enabled`. */
export function automationArgs(
  cfg: Config,
  binPath: string,
  workspaceRef: string,
  enabled: boolean,
): string[] {
  const d = cfg.defaults.dispatcher;
  return [
    "automations",
    "create",
    "--name",
    AUTOMATION_NAME,
    "--trigger",
    "*/5 * * * *",
    "--workspace",
    workspaceRef,
    "--workspace-mode",
    "existing",
    "--fresh-session",
    "--precheck",
    precheckCommand(binPath),
    "--precheck-timeout",
    String(d.precheckTimeoutSec),
    "--missed-run-grace-minutes",
    String(d.missedRunGraceMinutes),
    "--timezone",
    cfg.defaults.timezone,
    "--provider",
    d.provider,
    "--prompt",
    AUTOMATION_PROMPT,
    ...(enabled ? [] : ["--disabled"]),
  ];
}

export interface InstallOptions {
  enable: boolean;
  /** The checkout `install` runs from: `orca worktree current` there names this repository. */
  repoRoot: string;
  /** The version compiled; absent → the dispatcher worktree's package.json. */
  version?: string;
  clientId?: string;
  clientSecret?: string;
  build?: (worktreePath: string, outFile: string) => Promise<string>;
  sha256?: (file: string) => Promise<string>;
  symlink?: (target: string, link: string) => Promise<void>;
  /** Writes the saved views as the app and returns their URLs; absent → no views are written (the recipe is printed). */
  views?: (ctx: Ctx) => Promise<string[]>;
  /** The doctor `--enable` requires; absent → one with probes and no token source, which never passes `linear_auth`. */
  doctor?: (ctx: Ctx) => Promise<DoctorReport>;
}

const statePath = (dirs: Dirs) => join(dirs.state, "install.json");

export async function readInstallState(dirs: Dirs): Promise<InstallState | null> {
  const text = await readText(statePath(dirs));
  if (text === null) return null;
  try {
    return InstallStateSchema.parse(JSON.parse(text));
  } catch (e) {
    throw new WingmateError(
      "install_state_invalid",
      `${statePath(dirs)} does not parse (${errorCode(e)})`,
      "re-run `wingmate install`",
    );
  }
}

/** §11.1: the OAuth app's client id/secret, 0600 in a 0700 directory; a cached token survives only an unchanged id and secret. */
export async function saveAppCredentials(dirs: Dirs, clientId: string, clientSecret: string): Promise<void> {
  await mkdir(dirs.config, { recursive: true, mode: 0o700 });
  await chmod(dirs.config, 0o700);
  const prev = await readCredentials(dirs).catch(() => null);
  const same = prev?.clientId === clientId && prev.clientSecret === clientSecret;
  await writeCredentials(dirs, { clientId, clientSecret, token: same ? prev.token : null });
}

const hasAppCredentials = (dirs: Dirs) =>
  readCredentials(dirs).then(
    () => true,
    () => false,
  );

/** `wingmate-dispatcher` of this repository from origin/main, reused when Orca already lists it. */
async function dispatcherWorktree(
  ctx: Ctx,
  repoRoot: string,
): Promise<{ repoId: string; id: string; path: string }> {
  const self = await ctx.orca.worktreeCurrent(repoRoot);
  const fleet = await ctx.orca.worktreePs();
  const row = fleet.worktrees.find(
    (w) =>
      w.repoId === self.repoId &&
      (w.displayName === DISPATCHER_WORKTREE || basename(w.path) === DISPATCHER_WORKTREE),
  );
  if (row) return { repoId: self.repoId, id: row.worktreeId, path: row.path };
  if (fleet.truncated || fleet.omittedHostIds.length)
    throw new WingmateError(
      "orca_partial",
      "the fleet read is partial, so an existing dispatcher worktree may be missing from it; nothing was created",
      "retry once every Orca host answers",
    );
  const made = await ctx.orca.worktreeCreate({
    repoId: self.repoId,
    name: DISPATCHER_WORKTREE,
    baseBranch: "origin/main",
    linearIssue: "",
    comment: "wingmate dispatcher (long-lived)",
  });
  return { repoId: self.repoId, id: made.id, path: made.path };
}

async function versionOf(worktreePath: string): Promise<string> {
  const text = await readText(join(worktreePath, "package.json"));
  const v = z.object({ version: z.string() }).safeParse(text === null ? null : JSON.parse(text));
  if (!v.success) throw new WingmateError("version_unknown", `${worktreePath}/package.json has no version`);
  return v.data.version;
}

export async function install(ctx: Ctx, o: InstallOptions): Promise<InstallResult> {
  if ((o.clientId === undefined) !== (o.clientSecret === undefined))
    throw new WingmateError("usage", "--client-id and --client-secret go together");
  if (o.clientId !== undefined && o.clientSecret !== undefined) {
    if (!o.clientId.trim() || !o.clientSecret.trim())
      throw new WingmateError("usage", "--client-id and --client-secret must not be empty");
    await saveAppCredentials(ctx.dirs, o.clientId.trim(), o.clientSecret.trim());
  }
  const wt = await dispatcherWorktree(ctx, o.repoRoot);
  const version = o.version ?? (await versionOf(wt.path));
  if (!VERSION.test(version))
    throw new WingmateError("version_invalid", "the version is not a plain semver string");
  await mkdir(ctx.dirs.bin, { recursive: true });
  const binPath = await (o.build ?? defaultBuild)(wt.path, join(ctx.dirs.bin, `wingmate-${version}`));
  const sha256 = await (o.sha256 ?? defaultSha256)(binPath);
  await (o.symlink ?? defaultSymlink)(binPath, join(ctx.home, ".local", "bin", "wingmate"));
  // the automation: always written disabled here (create, or edit with the same flags — spike results §5)
  const prev = await readInstallState(ctx.dirs).catch(() => null);
  const named = (await ctx.orca.automationsList()).filter((a) => a.name === AUTOMATION_NAME);
  const current = named.find((a) => a.id === prev?.automationId) ?? named[0];
  const flags = automationArgs(ctx.cfg, binPath, `id:${wt.repoId}::${wt.path}`, false).slice(2);
  let automationId: string;
  if (current) {
    await ctx.orca.automationsEdit(current.id, flags);
    automationId = current.id;
  } else automationId = (await ctx.orca.automationsCreate(flags)).id;
  // R30 (D14): Orca's checkouts of a pilot repository follow no replace ref — set before any doctor reads it back
  const repoSettings = await disableReplaceRefsInPilots(ctx);
  // §11.5: written as the app, so only with its credentials; otherwise the CLI prints the manual recipe
  let viewUrls: string[] = [];
  let viewsError: string | null = null;
  if (o.views && (await hasAppCredentials(ctx.dirs)))
    try {
      viewUrls = await o.views(ctx);
    } catch (e) {
      viewsError = errorCode(e);
      ctx.log.warn({ code: viewsError }, "install: saved views not written");
    }
  const state: InstallState = {
    version,
    automationId,
    worktreeId: wt.id,
    binPath,
    sha256,
    viewUrls,
    installedAt: ctx.now(),
    enabled: false,
  };
  await writeAtomic(statePath(ctx.dirs), JSON.stringify(state, null, 2));
  if (o.enable) {
    const doctorOf = o.doctor ?? (await import("./doctor")).defaultInstallDoctor;
    const rep = await doctorOf(ctx);
    const failing = rep.checks.filter((c) => !c.ok && c.blocking).map((c) => c.name);
    if (!rep.ok || failing.length)
      throw new WingmateError(
        "doctor_failed",
        `doctor_failed: blocking checks failed (${failing.join(", ") || "unknown"}); the automation stays disabled`,
        "fix them, run `wingmate doctor`, then `wingmate install --enable`",
      );
    await ctx.orca.automationsEdit(automationId, ["--enabled"]);
    state.enabled = true;
    await writeAtomic(statePath(ctx.dirs), JSON.stringify(state, null, 2));
  }
  return { ...state, viewsError, repoSettings };
}

/** `bun install --frozen-lockfile` then `bun build --compile` into a temp file renamed over `outFile` (a running binary is never rewritten). */
export const MIN_BUILD_BUN = "1.4.2";

/** Older Bun executables lose inherited environment variables inside macOS Seatbelt (Bun #27802). */
export function supportedBuildBun(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return false;
  const actual = match.slice(1).map(Number);
  if (actual.some((n) => !Number.isSafeInteger(n))) return false;
  const minimum = MIN_BUILD_BUN.split(".").map(Number);
  for (const [i, expected] of minimum.entries()) {
    const value = actual[i] ?? 0;
    if (value > expected) return true;
    if (value < expected) return false;
  }
  return true;
}

export async function defaultBuild(
  worktreePath: string,
  outFile: string,
  exec: typeof run = run,
): Promise<string> {
  const tail = (s: string) => {
    const t = s.trim().split("\n").slice(-5).join(" | ").slice(0, 500);
    return scanText(t).length ? "(output withheld: it looked like a secret)" : t;
  };
  const version = await exec(["bun", "--version"], { cwd: worktreePath, timeoutMs: 30_000 });
  if (version.code !== 0 || version.timedOut || version.truncated || !supportedBuildBun(version.stdout))
    throw new WingmateError(
      "bun_unsupported",
      `building Wingmate requires Bun ${MIN_BUILD_BUN} or later; older runtimes lose the agent environment inside the macOS sandbox`,
      "put a supported Bun release on PATH, then re-run install",
    );
  const deps = await exec(["bun", "install", "--frozen-lockfile"], {
    cwd: worktreePath,
    timeoutMs: 10 * 60_000,
  });
  if (deps.code !== 0)
    throw new WingmateError("build_failed", `bun install failed (${deps.code}): ${tail(deps.stderr)}`);
  const tmp = `${outFile}.${newUlid()}.tmp`;
  const b = await exec(
    [
      "bun",
      "build",
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--no-compile-autoload-tsconfig",
      "--no-compile-autoload-package-json",
      "./bin/wingmate.ts",
      "--outfile",
      tmp,
    ],
    {
      cwd: worktreePath,
      timeoutMs: 10 * 60_000,
    },
  );
  if (b.code !== 0)
    throw new WingmateError("build_failed", `bun build failed (${b.code}): ${tail(b.stderr)}`);
  await chmod(tmp, 0o755);
  await rename(tmp, outFile);
  return outFile;
}

export const defaultSha256 = async (file: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");

/** `link` → `target`, swapped in atomically; a regular file already at `link` is the owner's and is never replaced. */
export async function defaultSymlink(target: string, link: string): Promise<void> {
  await mkdir(dirname(link), { recursive: true });
  const st = await lstat(link).catch(() => null);
  if (st && !st.isSymbolicLink())
    throw new WingmateError(
      "bin_link_conflict",
      `${link} exists and is not a symlink; it was left alone`,
      "move it away, then re-run `wingmate install`",
    );
  const tmp = `${link}.${newUlid()}.tmp`;
  await symlink(target, tmp);
  await rename(tmp, link);
}
