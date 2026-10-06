// src/kit/settings.ts — the dispatcher-owned Claude settings file, the explicit agent argv and the agent environment (§4.4, §13.3 b/c).
import { join } from "node:path";

export type Role =
  | "coordinator"
  | "plan-verifier"
  | "code-reviewer"
  | "security-reviewer"
  | "ui-reviewer"
  | "worker";
export interface SettingsInput {
  worktreePath: string;
  childWorktrees: string[];
  commonDir: string;
  gitdirName: string;
  branch: string;
  baseBranch: string;
  kitDir: string;
  toolchainPaths: string[];
  allowedDomains: string[];
  role: Role;
}

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
  if (i.role !== "coordinator")
    deny.push(
      "Bash(orca orchestration worker-start *)",
      "Bash(orca orchestration run-create *)",
      "Bash(orca orchestration task-create *)",
      // `dispatch` hands a task to another terminal — a spawn by another name (Orca 1.4.220).
      "Bash(orca orchestration dispatch *)",
    );
  return {
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      filesystem: {
        denyRead: ["~/"],
        allowRead: [i.worktreePath, ...i.childWorktrees, ...i.toolchainPaths, join(c, "**")],
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
          `${c}/*.lock`,
        ],
        denyWrite: [
          `${c}/config`,
          `${c}/hooks/**`,
          `${c}/info/**`,
          `${c}/refs/heads/${base}*`,
          `${c}/refs/remotes/**`,
          `${c}/worktrees/*/**`,
          "~/.local/share/wingmate/**",
          "~/.config/wingmate/**",
          "~/.claude/**",
          "~/.codex/**",
          "~/.gitconfig",
          "~/.ssh/**",
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
  };
}

export const coordinatorArgv = (a: {
  provider: "claude" | "codex";
  model: string;
  effort: string;
  sessionId: string;
  kitDir: string;
  worktreePath?: string;
}): string[] =>
  a.provider === "claude"
    ? [
        "claude",
        "--model",
        a.model,
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

/** R8: `-c approval_policy=never` is accepted by both `codex` and `codex exec`; `--ask-for-approval` is rejected by `exec` (spike §3.5). */
export const codexArgv = (a: {
  model: string;
  effort: string;
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
    "--model",
    a.model,
    "-c",
    `model_reasoning_effort=${a.effort}`,
    "-c",
    "approval_policy=never",
    "-c",
    "project_doc_max_bytes=0",
    ...(readOnly
      ? ["--sandbox", "read-only"]
      : ["--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=false"]),
  ];
};

export const agentEnv = (kitDir: string): Record<string, string> => ({
  GH_TOKEN: "",
  GH_CONFIG_DIR: join(kitDir, "gh-empty"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: join(kitDir, "gitconfig"),
  GIT_TERMINAL_PROMPT: "0",
});

/** POSIX single-quoting; `[`/`]` (as in `claude-fable-5-1[1m]`) must be quoted or zsh globs them. */
export const shellQuote = (argv: string[]): string =>
  argv.map((a) => (/^[A-Za-z0-9_./:=,-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");

/** The one line typed into the login shell Orca spawns: env assignments, then `exec` so the PTY ends with the agent (§4.4). */
export const launchCommand = (argv: string[], env: Record<string, string>): string =>
  `${Object.entries(env)
    .map(([k, v]) => `${k}=${shellQuote([v])}`)
    .join(" ")} exec ${shellQuote(argv)}`;
