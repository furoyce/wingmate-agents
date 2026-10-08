// src/kit/settings.ts — the dispatcher-owned Claude settings files, the explicit agent argv and the agent environment (§4.4, §8.1,
// §13.3 b/c).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { WingmateError } from "../shared/errors";

/** The roles `wingmate issue spawn` launches (§8.1); each gets its own settings file in the kit dir. */
export const SPAWN_ROLES = [
  "plan-verifier",
  "code-reviewer",
  "security-reviewer",
  "ui-reviewer",
  "worker",
] as const;
export type SpawnRole = (typeof SPAWN_ROLES)[number];
export type Role = "coordinator" | SpawnRole;
export interface SettingsInput {
  worktreePath: string;
  childWorktrees: string[];
  commonDir: string;
  gitdirName: string;
  branch: string;
  baseBranch: string;
  kitDir: string;
  toolchainPaths: string[];
  /** Scoped runtime grants are read-only; never inferred from a bin directory's parent. */
  runtimeReadPaths?: readonly string[] | undefined;
  runtimePath?: string | undefined;
  /** Exact OS-account receipt file: custom-state legacy kits must also authenticate the absence of a runtime. */
  runtimeAnchorReadPath?: string | undefined;
  allowedDomains: string[];
  role: Role;
  /** Gitdir names under `<common>/worktrees/` to deny (the own one is skipped); omitted → listed from disk now (`siblingDenyWrite`). */
  siblingGitdirs?: string[] | undefined;
  /** Branches the other worktrees have checked out (the own one is skipped); omitted → read from their HEADs now (`siblingBranches`). */
  siblingBranches?: string[] | undefined;
  /** SEC-1: credential-named variables to blank besides the fixed ones (`userClaudeCredentialEnv`); only names, never values. */
  blankEnv?: readonly string[] | undefined;
}

/**
 * SEC-1 (§13.3 a/b): credential-bearing variables, by name only — never by value. Claude Code applies the owner's user-level `env`
 * (`~/.claude/settings.json`) to every session and its Bash subprocesses, under the kit's own settings; the kit's `--settings` file
 * loads at `policy` precedence (spike §3.4b: `sandbox status` reports its keys from source `policy`), so its `env` block setting each
 * such name to "" wins. The doctor probe fails while any blanked name is still set inside the sandbox (probe 13); N1 (R32): any other
 * credential-named variable there (Orca's and Claude Code's own per-terminal variables, `GIT_CONFIG_KEY_n`) is only named in a note.
 */
export const CREDENTIAL_ENV_PATTERN = "TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|_KEY|CREDENTIAL";
/** Never blanked: Claude Code's own model access (the session holds it by design, D14) and Orca's agent-integration variables. */
export const AGENT_OWN_ENV_PATTERN =
  "^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|ORCA_[A-Za-z0-9_]*)$";
const CREDENTIAL_ENV = new RegExp(CREDENTIAL_ENV_PATTERN, "i");
const AGENT_OWN_ENV = new RegExp(AGENT_OWN_ENV_PATTERN);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Always blank: the variables gh reads a token from, GitHub's MCP server token, and the owner's personal Linear key (F4). */
const ALWAYS_BLANK = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "WINGMATE_LINEAR_TOKEN",
];
export const isCredentialEnv = (name: string): boolean =>
  ENV_NAME.test(name) && CREDENTIAL_ENV.test(name) && !AGENT_OWN_ENV.test(name);

/** SEC-1: the credential-named keys of the owner's user-level Claude `env` — names only, sorted; none when the file is unreadable. */
export function userClaudeCredentialEnv(home: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  } catch {
    return [];
  }
  const env = raw && typeof raw === "object" ? (raw as { env?: unknown }).env : undefined;
  if (!env || typeof env !== "object" || Array.isArray(env)) return [];
  return Object.keys(env).filter(isCredentialEnv).sort();
}

/** SEC-1: the kit settings' `env` block — every always-blank name and every given credential name set to "". */
export const blankedEnv = (extra: readonly string[] = []): Record<string, string> =>
  Object.fromEntries(
    [...new Set([...ALWAYS_BLANK, ...extra.filter(isCredentialEnv)])].sort().map((n) => [n, ""]),
  );

/** §13.3(b) browser verbs, plus the Orca 1.4.220 browser verbs the spec list predates; denied for every role but ui-reviewer. */
const BROWSER_VERBS = [
  "goto",
  "click",
  "dblclick",
  "fill",
  "type",
  "inserttext",
  "keypress",
  "select",
  "check",
  "uncheck",
  "upload",
  "drag",
  "mouse",
  "get",
  "snapshot",
  "screenshot",
  "find",
  "focus",
  "clear",
  "back",
  "forward",
  "reload",
  ...["hover", "scroll", "scrollintoview", "wait", "is", "highlight", "full-screenshot", "select-all", "pdf"],
  ...["dialog", "geolocation", "console", "network", "capture", "viewport"],
];
/** Hosts an agent must never reach even if a project lists them by mistake (§13.3 b); always in `deniedDomains` (R12). */
const BLOCKED_HOSTS = [
  "github.com",
  "api.github.com",
  "*.githubusercontent.com",
  "gitlab.com",
  "vercel.com",
  "*.supabase.co",
  "*.neon.tech",
];
const LINEAR_WRITE_VERBS = [
  "comment",
  "status",
  "label",
  "save-issue",
  "assignee",
  "create",
  "attach",
  "relation",
  "priority",
  "estimate",
  "due-date",
];
const ORCA_ADMIN_VERBS = [
  "eval",
  "cookie",
  "tab",
  "automations",
  "account",
  "environment",
  "repo",
  "project",
  "skills share",
  "computer",
];
/**
 * Orca 1.4.220 verbs (read from `orca agent-context --json`, 2026-10-06) that the §13.3(b) list predates and no role needs: each
 * sends data off the machine or past the sandbox through the unsandboxed Orca app (`exec` drives the browser, `open-url`,
 * `download --path` writes anywhere, `artifacts share`), reads other sessions or the clipboard (`search`, `clipboard`,
 * `diagnostics`, `profile state`, browser `storage`), changes host-wide state (`agent hooks` feeds liveness, `serve`,
 * `browser identity set`), or starts agents (`claude-teams`). Denied for every role.
 */
const ORCA_EXTRA_DENY = [
  "exec",
  "open-url",
  "download",
  "artifacts",
  "clipboard",
  "search",
  "diagnostics",
  "profile",
  "storage",
  "set",
  "intercept",
  "agent hooks",
  "serve",
  "claude-teams",
  "browser identity set",
];

/**
 * §13.3(b) `wingmate issue … spawn` for every non-coordinator role (C2), by bare name or path (`~/.local/bin/wingmate`), with or
 * without the optional `<id>` (§8.1). Prefix rules stop a well-behaved agent; `spawn` itself refuses unless WINGMATE_ROLE is
 * coordinator.
 */
const SPAWN_DENY = [
  "Bash(wingmate issue * spawn*)",
  "Bash(*/wingmate issue * spawn*)",
  "Bash(wingmate issue spawn*)",
  "Bash(*/wingmate issue spawn*)",
];

/**
 * §13.3(a): the single exception to the state dir's deny region — read (hence execute) access to the compiled binary, which
 * `~/.local/bin/wingmate` links to (§4.3), so `wingmate issue …` runs inside the sandbox. `denyWrite` still covers it.
 */
const WINGMATE_BIN_READ = "~/.local/share/wingmate/bin/**";
/**
 * The commit e-mail of every agent (the kit gitconfig) and of doctor's probe: a reserved `.invalid` address (RFC 2606) that no
 * GitHub account can verify, so pushed agent commits credit nobody. A `<name>@users.noreply.github.com` address credits the
 * GitHub user of that name, and a user "Wingmate" exists.
 */
export const AGENT_GIT_EMAIL = "wingmate@noreply.invalid";
/**
 * Claude Code grants a linked worktree's git common dir as a whole: its sandbox config builder adds the detected common dir to
 * `allowWrite` (read from the 2.1.291 and 2.1.292 binaries), so inside `<common>` the allowWrite entries are inert and only denyWrite
 * restricts (F7). Its own denies there cover `hooks`, `config(.lock)`, `config.worktree(.lock)`, `commondir`,
 * `objects/info/(http-)alternates` and each worktree's `config.worktree(.lock)` and `commondir` — nothing else.
 *
 * At the top level that leaves the main checkout's `HEAD`, `index`, `MERGE_HEAD`, `ORIG_HEAD` and `FETCH_HEAD` (a planted MERGE_HEAD
 * turns the owner's next commit into a merge) and the repo-wide `shallow` and `gc.pid`, denied here (F7, F10): a commit, merge,
 * rebase or fetch in the own linked worktree writes none of them — `git rev-parse --git-path` puts those in its gitdir (git 2.53).
 * `packed-refs.lock` stays writable because a commit takes it, so there is no `<common>/*.lock` deny.
 */
const COMMON_TOP_DENY = [
  "HEAD",
  "HEAD.lock",
  "index",
  "index.lock",
  "shallow",
  "shallow.lock",
  "gc.pid",
  "MERGE_HEAD",
  "ORIG_HEAD",
  "FETCH_HEAD",
];
/**
 * Repo-wide state under `<common>` the grant leaves writable (F10): the main checkout's submodule gitdirs (`modules/`; their hooks
 * and config run as the owner outside the sandbox — the own worktree's submodules live in its own gitdir) and the legacy remote
 * definitions (`remotes/`, `branches/`).
 */
const COMMON_GLOB_DENY = ["modules/**/hooks/**", "modules/**/config", "remotes/**", "branches/**"];
/**
 * One literal path component. The own gitdir's grant and every other worktree's deny are spelled from such names: a glob or brace
 * character would widen the grant (`""` gives `worktrees//**`) or turn a deny into a pattern that covers the own gitdir.
 */
const GITDIR_NAME = /^(?!\.\.?$)[^/\\*?[\]{}]+$/;

function assertGitdirName(name: string): void {
  if (!GITDIR_NAME.test(name))
    throw new WingmateError(
      "settings_invalid",
      `gitdirName ${JSON.stringify(name)} is not one literal path component`,
      "record the worktree's gitdir name before writing agent settings",
    );
}

/** The real directories under `<common>/worktrees/` (gitdirs git made); a missing directory means there are none. */
function listWorktreeDirs(commonDir: string): string[] {
  const dir = join(commonDir, "worktrees");
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new WingmateError(
      "settings_invalid",
      `cannot list ${dir}: ${(e as Error).message}`,
      "check the repository's git common dir, then re-install the kit",
    );
  }
}

/**
 * §13.3(b) denies every other worktree's gitdir under `<common>/worktrees/`, one deny per name (F7). The sandbox's globs have no
 * negation (`^` is escaped, `[!…]` is a positive class) and a blanket `worktrees/*` deny would cover the own gitdir too (deny wins), so
 * the names are listed — by `installKit` at claim and by `refreshSiblingDenies` before each (re)launch. Each is a plain path, which the
 * sandbox applies as a subpath rule: the directory itself as well as everything in it. Symlinks are never listed: Claude resolves a
 * deny path through one, so a planted link could aim the deny at the own gitdir, and a write through one is checked at its target.
 */
export function siblingDenyWrite(commonDir: string, gitdirName: string, names?: readonly string[]): string[] {
  assertGitdirName(gitdirName);
  const out: string[] = [];
  for (const n of [...new Set(names ?? listWorktreeDirs(commonDir))].sort()) {
    if (n === gitdirName) continue;
    if (!GITDIR_NAME.test(n))
      throw new WingmateError(
        "settings_invalid",
        `worktree gitdir ${JSON.stringify(n)} under ${commonDir}/worktrees is not one literal path component, so it cannot be denied exactly`,
        "rename or remove that worktree (`git worktree move` or `git worktree remove`), then re-install the kit",
      );
    out.push(`${commonDir}/worktrees/${n}`);
  }
  return out;
}

/** A branch name the sandbox matches exactly: literal components (no glob or brace characters), none empty, `.` or `..`. */
const isLiteralBranch = (b: string): boolean =>
  b.length > 0 && b.split("/").every((p) => GITDIR_NAME.test(p));

/**
 * `git check-ref-format --branch` (git 2.53): whether git can give a branch this name. A HEAD that names anything else points at
 * no ref git writes, so there is nothing to deny for it (C9).
 */
export function isValidBranchName(name: string): boolean {
  if (name === "" || name === "HEAD" || name.startsWith("-") || name.startsWith("/")) return false;
  if (name.endsWith("/") || name.endsWith(".") || /\.\.|@\{|\/\/|[ ~^:?*[\\]/.test(name)) return false;
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return false; // control characters and DEL
  }
  return name.split("/").every((p) => !p.startsWith(".") && !p.endsWith(".lock"));
}

function assertBranch(branch: string): void {
  if (!isLiteralBranch(branch))
    throw new WingmateError(
      "settings_invalid",
      `branch ${JSON.stringify(branch)} is not a literal ref name`,
      "record the worktree's branch before writing agent settings",
    );
}

/** The branch a HEAD file names (`ref: refs/heads/<b>`); null when it is detached, absent or names no branch. */
function headBranch(headFile: string): string | null {
  let text: string;
  try {
    text = readFileSync(headFile, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw new WingmateError(
      "settings_invalid",
      `cannot read ${headFile}: ${(e as Error).message}`,
      "check the repository's git common dir, then re-install the kit",
    );
  }
  return /^ref: refs\/heads\/(.+?)\s*$/.exec(text)?.[1] ?? null;
}

/**
 * The branches the main checkout (`<common>/HEAD`) and every other linked worktree (`<common>/worktrees/<n>/HEAD`) have checked out
 * (F10). The own worktree's HEAD is never read: the agent can write it, so the own branch comes from the record.
 */
export function siblingBranches(commonDir: string, gitdirName: string, names?: readonly string[]): string[] {
  const heads = [join(commonDir, "HEAD")];
  for (const n of new Set(names ?? listWorktreeDirs(commonDir)))
    if (n !== gitdirName && GITDIR_NAME.test(n)) heads.push(join(commonDir, "worktrees", n, "HEAD"));
  return [...new Set(heads.map(headBranch).filter((b): b is string => b !== null))].sort();
}

/**
 * F10: Claude's common-dir grant leaves `refs/heads/**` writable apart from the base branch, so each other worktree's branch ref is
 * denied by name, with its lock (a planted lock blocks that worktree's commits). A name git cannot give a branch is skipped: no ref
 * git writes has it (C9). No emitted path is the own ref, its lock or one of their ancestors or descendants: a plain deny covers its
 * subtree, and the sandbox denies creating or unlinking every deny's ancestors — either would break the own ref update (C9).
 */
export function siblingBranchDenyWrite(
  commonDir: string,
  branch: string,
  branches: readonly string[],
): string[] {
  assertBranch(branch);
  const heads = `${commonDir}/refs/heads/`;
  const own = [`${heads}${branch}`, `${heads}${branch}.lock`];
  const overlap = (p: string, q: string) => p === q || p.startsWith(`${q}/`) || q.startsWith(`${p}/`);
  const out: string[] = [];
  for (const b of [...new Set(branches)].sort()) {
    if (!isValidBranchName(b)) continue;
    const deny = [`${heads}${b}`, `${heads}${b}.lock`];
    if (deny.some((p) => own.some((o) => overlap(p, o)))) continue;
    if (!isLiteralBranch(b))
      throw new WingmateError(
        "settings_invalid",
        `branch ${JSON.stringify(b)} checked out in another worktree of ${commonDir} is not a literal ref name, so it cannot be denied exactly`,
        "rename that branch or remove its worktree, then re-install the kit",
      );
    out.push(...deny);
  }
  return out;
}

/** The other worktrees' gitdir names and checked-out branches, read from disk once (so several settings files agree). */
export function otherWorktrees(
  commonDir: string,
  gitdirName: string,
): { gitdirs: string[]; branches: string[] } {
  const gitdirs = listWorktreeDirs(commonDir).filter((n) => n !== gitdirName);
  return { gitdirs, branches: siblingBranches(commonDir, gitdirName, gitdirs) };
}

/**
 * The per-repo denies written last in `denyWrite` — the other worktrees' gitdirs, then their branches — which `installKit` lists at
 * claim and `refreshSiblingDenies` re-lists before each launch. Omitted lists are read from disk now.
 */
export function siblingDenies(
  commonDir: string,
  gitdirName: string,
  branch: string,
  known: { gitdirs?: readonly string[] | undefined; branches?: readonly string[] | undefined } = {},
): string[] {
  return [
    ...siblingDenyWrite(commonDir, gitdirName, known.gitdirs),
    ...siblingBranchDenyWrite(
      commonDir,
      branch,
      known.branches ?? siblingBranches(commonDir, gitdirName, known.gitdirs),
    ),
  ];
}

/** Whether a `denyWrite` entry is one of `siblingDenies` (what a refresh replaces): the static entries under `refs/heads/` are globs. */
export const isSiblingDeny = (commonDir: string, p: string): boolean =>
  p.startsWith(`${commonDir}/worktrees/`) || (p.startsWith(`${commonDir}/refs/heads/`) && !/[*?[\]]/.test(p));

const covers = (pattern: string, host: string): boolean =>
  pattern.startsWith("*.") ? host === pattern || host.endsWith(pattern.slice(1)) : host === pattern;
/** Case-insensitive: a blocked host, a host under a blocked `*.` wildcard, or an allowed wildcard that would cover a blocked host. */
const isBlocked = (domain: string): boolean => {
  const d = domain.trim().toLowerCase();
  return BLOCKED_HOSTS.some((h) => covers(h, d) || covers(d, h.replace(/^\*\./, "x.")));
};

export function claudeSettings(i: SettingsInput): object {
  const c = i.commonDir;
  const base = i.baseBranch.replace(/^origin\//, "");
  assertGitdirName(i.gitdirName);
  assertBranch(i.branch);
  const siblings = siblingDenies(c, i.gitdirName, i.branch, {
    gitdirs: i.siblingGitdirs,
    branches: i.siblingBranches,
  });
  const deny = [
    "Read(~/.config/wingmate/**)",
    "Read(~/.ssh/**)",
    "Read(~/.config/gh/**)",
    "Read(~/.claude/**)",
    "Read(~/.codex/**)",
    "Read(**/.env*)",
    ...LINEAR_WRITE_VERBS.map((v) => `Bash(orca linear ${v} *)`),
    ...ORCA_ADMIN_VERBS.map((v) => `Bash(orca ${v} *)`),
    ...ORCA_EXTRA_DENY.map((v) => `Bash(orca ${v} *)`),
    "Bash(orca worktree rm *)",
    "Bash(orca worktree create *)",
    "Bash(orca worktree set *)",
    "Bash(orca terminal send *)",
    "Bash(orca terminal create *)",
    "Bash(orca terminal close *)",
    "Bash(orca terminal split *)",
    "Bash(orca orchestration reset *)",
    "Bash(orca orchestration run-use *)",
    "Bash(orca orchestration gate-resolve *)",
    "Bash(orca orchestration coordinator-*)",
    "Bash(git push *)",
    "Bash(gh pr create *)",
    "Bash(gh pr merge *)",
    "Bash(gh api *)",
    "Bash(gh secret *)",
    "Bash(gh workflow *)",
    "Bash(gh release *)",
    "Bash(gh repo *)",
    "Bash(vercel *)",
    "Bash(eas *)",
    "Bash(neonctl *)",
    "Bash(npx neonctl *)",
    "Bash(git reset --hard *)",
    "Bash(git branch -D *)",
    "Bash(git switch *)",
    "Bash(git checkout -b *)",
    "mcp__*Linear__save_*",
    "mcp__*Linear__create_*",
    "mcp__*Linear__delete_*",
  ];
  if (i.role !== "ui-reviewer") deny.push(...BROWSER_VERBS.map((v) => `Bash(orca ${v} *)`));
  // Every role, the coordinator included (C4): a coordinator starts workers only through `wingmate issue spawn`, which runs
  // worker-start as a subprocess the permission layer never sees, under the role's own settings file (§8.1). `dispatch` hands a
  // task to another terminal — a spawn by another name (Orca 1.4.220).
  deny.push("Bash(orca orchestration worker-start *)", "Bash(orca orchestration dispatch *)");
  // §13.3(b): only the coordinator creates Runs and tasks or spawns (C2; `spawn` also refuses unless WINGMATE_ROLE is coordinator)
  if (i.role !== "coordinator")
    deny.push(
      "Bash(orca orchestration run-create *)",
      "Bash(orca orchestration task-create *)",
      ...SPAWN_DENY,
    );
  const readOnly = i.role !== "coordinator" && i.role !== "worker";
  if (readOnly) deny.push("Write", "Edit", "NotebookEdit");
  return {
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      filesystem: {
        denyRead: ["~/"],
        allowRead: [
          i.worktreePath,
          ...i.childWorktrees,
          ...i.toolchainPaths,
          ...(i.runtimeReadPaths ?? []),
          ...(i.runtimeAnchorReadPath ? [i.runtimeAnchorReadPath] : []),
          WINGMATE_BIN_READ,
          // F8: agentEnv points git and gh into this issue's kit (gitconfig, gh-empty, no-hooks); an unreadable
          // GIT_CONFIG_GLOBAL kills git (EPERM, spike §3.4). Read only — `~/.local/share/wingmate/**` stays in denyWrite.
          join(i.kitDir, "**"),
          join(c, "**"),
        ],
        // §13.3(b)'s grants in the common dir, each glob covering its own `.lock`. Claude grants a linked worktree's whole common
        // dir by itself, which makes them inert there (F7); they are the allowlist should that grant go away. What keeps an agent
        // from planting the main checkout's `HEAD.lock`/`index.lock` or writing another worktree's gitdir is denyWrite below.
        allowWrite: [
          i.worktreePath,
          ...i.childWorktrees,
          "$TMPDIR",
          `${c}/objects/**`,
          `${c}/refs/heads/${i.branch}*`,
          `${c}/refs/heads/wm-*`,
          `${c}/logs/**`,
          `${c}/worktrees/${i.gitdirName}/**`,
          `${c}/packed-refs*`,
        ],
        denyWrite: [
          ...(i.runtimeReadPaths ?? []),
          ...(i.runtimeAnchorReadPath ? [i.runtimeAnchorReadPath] : []),
          ...(readOnly ? [i.worktreePath, c, ...i.childWorktrees] : []),
          `${c}/config`,
          `${c}/hooks/**`,
          `${c}/info/**`,
          `${c}/refs/heads/${base}*`,
          `${c}/refs/remotes/**`,
          // R30 (§13.3 b): defense in depth — a packed replace ref stays writable through packed-refs; what keeps Orca's checkout from
          // following either form is install's core.useReplaceRefs=false in `<common>/config`, which is denied above
          `${c}/refs/replace/**`,
          ...COMMON_TOP_DENY.map((n) => `${c}/${n}`),
          ...COMMON_GLOB_DENY.map((g) => `${c}/${g}`),
          "~/.local/share/wingmate/**",
          i.kitDir,
          "~/.config/wingmate/**",
          "~/.claude/**",
          "~/.codex/**",
          "~/.gitconfig",
          "~/.ssh/**",
          // last, so `refreshSiblingDenies` re-lists them in place (`isSiblingDeny`)
          ...siblings,
        ],
      },
      // Verified 2026-10-06 (spike §3.4a): `allowedDomains` alone is advisory under bypassPermissions; `strictAllowlist: true`
      // closes the list and `deniedDomains` wins over every allow (including the Bash tool's per-command `allowed_domains`).
      // In-process tools (WebFetch/WebSearch/MCP) sit outside the sandbox filter, so they are denied below. An invalid value
      // silently disables the whole sandbox block → `doctor` validates the written file.
      network: {
        allowedDomains: i.allowedDomains.filter((d) => !isBlocked(d)),
        deniedDomains: [...BLOCKED_HOSTS],
        strictAllowlist: true,
      },
    },
    permissions: { deny: [...deny, "WebFetch", "WebSearch"] },
    env: { ...blankedEnv(i.blankEnv), ...(i.runtimePath ? { PATH: i.runtimePath } : {}) },
  };
}

/** §4.4 / §13.3(b): the coordinator's argv. R31: a null model (the Claude CLI's own default) puts no `--model` on it; effort stays. */
export const coordinatorArgv = (a: {
  provider: "claude" | "codex";
  model: string | null;
  effort: string;
  sessionId: string;
  kitDir: string;
  worktreePath?: string;
}): string[] =>
  a.provider === "claude"
    ? [
        "claude",
        ...(a.model ? ["--model", a.model] : []),
        "--effort",
        a.effort,
        "--session-id",
        a.sessionId,
        "--permission-mode",
        "bypassPermissions",
        "--settings",
        join(a.kitDir, "claude-settings.json"),
        "--strict-mcp-config",
      ]
    : codexArgv({
        model: a.model,
        effort: a.effort,
        worktreePath: a.worktreePath ?? ".",
        role: "coordinator",
      });

/**
 * R8: `-c approval_policy=never` is accepted by both `codex` and `codex exec`; `--ask-for-approval` is rejected by `exec` (spike §3.5).
 * A null model/effort (tier standard, §9.2) leaves the provider's own default in place.
 */
export const codexArgv = (a: {
  model: string | null;
  effort: string | null;
  worktreePath: string;
  role: Role;
}): string[] => {
  const readOnly =
    a.role === "plan-verifier" ||
    a.role === "code-reviewer" ||
    a.role === "security-reviewer" ||
    a.role === "ui-reviewer";
  return [
    "codex",
    "-C",
    a.worktreePath,
    ...(a.model ? ["--model", a.model] : []),
    ...(a.effort ? ["-c", `model_reasoning_effort=${a.effort}`] : []),
    "-c",
    "approval_policy=never",
    "-c",
    "project_doc_max_bytes=0",
    ...(readOnly
      ? ["--sandbox", "read-only"]
      : ["--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=false"]),
  ];
};

/** The dispatcher-written settings file of a spawned role (§8.1): `<kit>/claude-settings.<role>.json`. */
export const roleSettingsFile = (kitDir: string, role: SpawnRole): string =>
  join(kitDir, `claude-settings.${role}.json`);

/** Every spawned role's settings file, as `launch.json` records them for `spawn`. */
export const roleSettingsFiles = (kitDir: string): Record<SpawnRole, string> => ({
  "plan-verifier": roleSettingsFile(kitDir, "plan-verifier"),
  "code-reviewer": roleSettingsFile(kitDir, "code-reviewer"),
  "security-reviewer": roleSettingsFile(kitDir, "security-reviewer"),
  "ui-reviewer": roleSettingsFile(kitDir, "ui-reviewer"),
  worker: roleSettingsFile(kitDir, "worker"),
});

/**
 * The argv `spawn` launches a role agent with (§8.1 amended 2026-10-06), so the §13.3(b)/(c) controls apply: Claude with the role's
 * dispatcher-written settings file, Codex through `codexArgv` (`--sandbox read-only` for verifier and reviewer roles). `tier` null is
 * tier standard (§9.2, workers): no `--model`/`--effort`, the provider's default. R31: a tier whose model is null (the Claude CLI's own
 * default) gives `--effort` without `--model`.
 */
export const roleArgv = (a: {
  provider: "claude" | "codex";
  role: SpawnRole;
  tier: { model: string | null; effort: string } | null;
  sessionId: string;
  settingsFile: string;
  worktreePath: string;
}): string[] =>
  a.provider === "claude"
    ? [
        "claude",
        ...(a.tier ? [...(a.tier.model ? ["--model", a.tier.model] : []), "--effort", a.tier.effort] : []),
        "--session-id",
        a.sessionId,
        "--permission-mode",
        "bypassPermissions",
        "--settings",
        a.settingsFile,
        "--strict-mcp-config",
      ]
    : codexArgv({
        model: a.tier?.model ?? null,
        effort: a.tier?.effort ?? null,
        worktreePath: a.worktreePath,
        role: a.role,
      });

/**
 * The environment every agent is launched with (§13.3 b); `role` is the agent's own, which `spawn` checks (C2). SEC-1: `blank` adds
 * credential-named variables (`userClaudeCredentialEnv`) blanked on the launch line too, for any process that inherited them.
 */
export const agentEnv = (
  kitDir: string,
  role: Role = "coordinator",
  blank: readonly string[] = [],
  runtime?: { path: string },
): Record<string, string> => ({
  ...(runtime ? { PATH: runtime.path } : {}),
  GH_TOKEN: "",
  // gh falls back to these when GH_TOKEN is empty, so an owner shell exporting one would hand it to the agent (F9, §13.3 a)
  GITHUB_TOKEN: "",
  GH_ENTERPRISE_TOKEN: "",
  GITHUB_ENTERPRISE_TOKEN: "",
  // F4 (§13.3 a): the owner's personal Linear key (Task 13), blank even when the login shell Orca types the launch line into exports it
  WINGMATE_LINEAR_TOKEN: "",
  ...blankedEnv(blank),
  GH_CONFIG_DIR: join(kitDir, "gh-empty"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: join(kitDir, "gitconfig"),
  GIT_TERMINAL_PROMPT: "0",
  WINGMATE_ROLE: role,
});

const SHELL_SAFE = /^[A-Za-z0-9_./,-]+$/;
/**
 * POSIX single-quoting of every word outside a charset no shell expands. `[`/`]` (as in `claude-fable-5-1[1m]`) would be globbed by
 * zsh; a leading `=` (zsh EQUALS: `=cmd` becomes its path) or `~` (tilde) is expanded; and under zsh's MAGIC_EQUAL_SUBST, which
 * the owner's login shell running the launch line may set, so are `=cmd` and `~` after the `=` of any `anything=value` word and
 * after each `:` in it (`x==ls` → `x=/bin/ls`). So any word with `:` or `=` is quoted too (C6).
 */
export const shellQuote = (argv: string[]): string =>
  argv.map((a) => (SHELL_SAFE.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");

/** The one line typed into the login shell Orca spawns: env assignments, then `exec` so the PTY ends with the agent (§4.4). */
export const launchCommand = (argv: string[], env: Record<string, string>): string =>
  `${Object.entries(env)
    .map(([k, v]) => `${k}=${shellQuote([v])}`)
    .join(" ")} exec ${shellQuote(argv)}`;
