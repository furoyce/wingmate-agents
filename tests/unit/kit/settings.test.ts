import { describe, expect, test } from "bun:test";
import {
  agentEnv,
  claudeSettings,
  codexArgv,
  coordinatorArgv,
  launchCommand,
  shellQuote,
} from "../../../src/kit/settings";

const input = {
  worktreePath: "/wt/wm-jrf-404",
  childWorktrees: [],
  commonDir: "/repo/.git",
  gitdirName: "wm-jrf-404",
  branch: "furoyce/wm-jrf-404",
  baseBranch: "main",
  kitDir: "/home/.local/share/wingmate/kit/JRF-404",
  toolchainPaths: ["/usr/bin", "/opt/homebrew"],
  allowedDomains: ["registry.npmjs.org", "api.anthropic.com"],
  role: "coordinator" as const,
};
type Settings = {
  sandbox: {
    enabled: boolean;
    allowUnsandboxedCommands: boolean;
    failIfUnavailable: boolean;
    autoAllowBashIfSandboxed: boolean;
    filesystem: { denyRead: string[]; allowRead: string[]; allowWrite: string[]; denyWrite: string[] };
    network: { allowedDomains: string[]; deniedDomains: string[]; strictAllowlist: boolean };
  };
  permissions: { deny: string[] };
};
/** Sandbox path semantics: a glob matches by pattern; a plain path covers itself and everything under it. */
const covers = (pattern: string, path: string): boolean =>
  /[*?[\]{}]/.test(pattern)
    ? new Bun.Glob(pattern).match(path)
    : path === pattern || path.startsWith(`${pattern}/`);
const coveredBy = (patterns: string[], path: string) => patterns.filter((p) => covers(p, path));

describe("settings", () => {
  test("claude settings enforce sandbox, deny region and git write policy", () => {
    const s = claudeSettings(input) as Settings;
    expect(s.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(s.sandbox.failIfUnavailable).toBe(true);
    expect(s.sandbox.filesystem.denyRead).toContain("~/");
    expect(s.sandbox.filesystem.allowWrite).toContain("/repo/.git/objects/**");
    expect(s.sandbox.filesystem.denyWrite).toContain("/repo/.git/hooks/**");
    expect(s.sandbox.network.allowedDomains).not.toContain("github.com");
    for (const d of [
      "Bash(git push *)",
      "Bash(orca linear comment *)",
      "Bash(orca terminal send *)",
      "Bash(orca computer *)",
      "Bash(gh api *)",
      "Read(~/.config/wingmate/**)",
    ])
      expect(s.permissions.deny).toContain(d);
    expect(s.permissions.deny).toContain("Bash(orca goto *)");
    // beyond the brief: the rest of the §13.3(b) shape
    expect(s.sandbox.enabled).toBe(true);
    expect(s.sandbox.autoAllowBashIfSandboxed).toBe(true);
    expect(s.sandbox.filesystem.allowWrite).toContain("/repo/.git/refs/heads/furoyce/wm-jrf-404*");
    expect(s.sandbox.filesystem.allowWrite).toContain("/repo/.git/worktrees/wm-jrf-404/**");
    expect(s.sandbox.filesystem.denyWrite).toContain("/repo/.git/refs/heads/main*");
    expect(s.sandbox.filesystem.denyWrite).toContain("/repo/.git/config");
    expect(s.sandbox.network.allowedDomains).toEqual(["registry.npmjs.org", "api.anthropic.com"]);
  });
  test("network control is enforced (R12): strictAllowlist, deniedDomains, in-process tools denied", () => {
    const s = claudeSettings(input) as Settings;
    expect(s.sandbox.network.strictAllowlist).toBe(true);
    for (const h of ["github.com", "api.github.com", "*.githubusercontent.com"])
      expect(s.sandbox.network.deniedDomains).toContain(h);
    for (const h of ["gitlab.com", "vercel.com", "*.supabase.co", "*.neon.tech"])
      expect(s.sandbox.network.deniedDomains).toContain(h);
    expect(s.permissions.deny).toContain("WebFetch");
    expect(s.permissions.deny).toContain("WebSearch");
  });
  test("a blocked host listed by mistake is filtered from allowedDomains (case, wildcard members, covering wildcards)", () => {
    const leaky = claudeSettings({
      ...input,
      allowedDomains: [
        "github.com",
        "GitHub.com",
        "raw.githubusercontent.com",
        "*.github.com",
        "x.supabase.co",
        "registry.npmjs.org",
      ],
    }) as Settings;
    expect(leaky.sandbox.network.allowedDomains).toEqual(["registry.npmjs.org"]);
  });
  test("toolchain read paths come only from the input (no hardcoded brew paths)", () => {
    const s = claudeSettings({ ...input, toolchainPaths: [] }) as Settings;
    expect(s.sandbox.filesystem.allowRead).toEqual([
      "/wt/wm-jrf-404",
      "~/.local/share/wingmate/bin/**",
      "/repo/.git/**",
    ]);
    const t = claudeSettings({ ...input, childWorktrees: ["/wt/wm-jrf-404-worker-ab12"] }) as Settings;
    expect(t.sandbox.filesystem.allowRead).toEqual([
      "/wt/wm-jrf-404",
      "/wt/wm-jrf-404-worker-ab12",
      "/usr/bin",
      "/opt/homebrew",
      "~/.local/share/wingmate/bin/**",
      "/repo/.git/**",
    ]);
    expect(t.sandbox.filesystem.allowWrite).toContain("/wt/wm-jrf-404-worker-ab12");
  });
  test("§13.3(a): the compiled binary is readable (so `wingmate issue …` runs); the rest of the state dir is not, and none of it is writable", () => {
    const fs = (claudeSettings(input) as Settings).sandbox.filesystem;
    expect(fs.allowRead).toContain("~/.local/share/wingmate/bin/**");
    expect(fs.allowRead.filter((p) => p.includes(".local/share/wingmate"))).toEqual([
      "~/.local/share/wingmate/bin/**",
    ]);
    expect(fs.denyWrite).toContain("~/.local/share/wingmate/**");
    expect(fs.allowWrite.filter((p) => p.includes(".local/share/wingmate"))).toEqual([]);
  });
  test("git in the own linked worktree can commit: no denyWrite pattern covers the own gitdir, and no other worktree's gitdir is writable", () => {
    const fs = (claudeSettings(input) as Settings).sandbox.filesystem;
    // deny wins over allow in Claude's sandbox, so a deny covering the own gitdir would fail `git add`/`git commit`
    for (const f of ["index.lock", "index", "HEAD.lock", "HEAD", "logs/HEAD", "COMMIT_EDITMSG"]) {
      const own = `/repo/.git/worktrees/wm-jrf-404/${f}`;
      expect(coveredBy(fs.allowWrite, own)).toEqual(["/repo/.git/worktrees/wm-jrf-404/**"]);
      expect(coveredBy(fs.denyWrite, own)).toEqual([]);
      // §13.3(b) "every other <common>/worktrees/*/**": no allow rule reaches a sibling (default write deny)
      expect(coveredBy(fs.allowWrite, `/repo/.git/worktrees/wm-jrf-999/${f}`)).toEqual([]);
      expect(coveredBy(fs.allowWrite, `/repo/.git/worktrees/wm-jrf-4040/${f}`)).toEqual([]);
    }
  });
  test("a gitdirName that is not one literal path component is refused: it would widen the own-gitdir grant", () => {
    for (const g of ["", ".", "..", "a/b", "*", "wm-[1]", "{a,b}"])
      expect(() => claudeSettings({ ...input, gitdirName: g })).toThrow(/gitdirName/);
  });
  test("only lock files under the allowed git paths are writable, never the common dir's top-level locks", () => {
    const fs = (claudeSettings(input) as Settings).sandbox.filesystem;
    expect(fs.allowWrite).not.toContain("/repo/.git/*.lock");
    expect(
      fs.allowWrite.filter((p) => /^\/repo\/\.git\/[^/]*\.lock$/.test(p) || p.endsWith("/*.lock")),
    ).toEqual([]);
    for (const l of ["config.lock", "HEAD.lock", "index.lock", "shallow.lock", "gc.pid.lock"])
      expect(coveredBy(fs.allowWrite, `/repo/.git/${l}`)).toEqual([]);
    for (const l of [
      "packed-refs.lock",
      "refs/heads/furoyce/wm-jrf-404.lock",
      "refs/heads/wm-jrf-404-spike.lock",
      "logs/refs/heads/furoyce/wm-jrf-404",
      "objects/info/commit-graph.lock",
      "worktrees/wm-jrf-404/index.lock",
    ])
      expect(coveredBy(fs.allowWrite, `/repo/.git/${l}`).length).toBeGreaterThan(0);
  });
  test("ui-reviewer keeps browser verbs; worker denies spawn", () => {
    const ui = claudeSettings({ ...input, role: "ui-reviewer" }) as Settings;
    expect(ui.permissions.deny).not.toContain("Bash(orca goto *)");
    const w = claudeSettings({ ...input, role: "worker" }) as Settings;
    expect(w.permissions.deny).toContain("Bash(orca orchestration worker-start *)");
    // beyond the brief
    expect(ui.permissions.deny).toContain("Bash(orca orchestration worker-start *)");
    expect(w.permissions.deny).toContain("Bash(orca orchestration dispatch *)");
    expect(w.permissions.deny).toContain("Bash(orca goto *)");
    const c = claudeSettings(input) as Settings;
    expect(c.permissions.deny).not.toContain("Bash(orca orchestration worker-start *)");
    expect(c.permissions.deny).not.toContain("Bash(orca orchestration dispatch *)");
  });
  test("Orca 1.4.220 verbs that bypass the sandbox through the Orca app are denied for every role", () => {
    for (const role of ["coordinator", "worker", "ui-reviewer", "plan-verifier"] as const) {
      const s = claudeSettings({ ...input, role }) as Settings;
      for (const v of [
        "exec",
        "open-url",
        "download",
        "artifacts",
        "search",
        "clipboard",
        "agent hooks",
        "serve",
      ])
        expect(s.permissions.deny).toContain(`Bash(orca ${v} *)`);
    }
  });
  test("argv and env", () => {
    expect(
      coordinatorArgv({
        provider: "claude",
        model: "claude-fable-5-1[1m]",
        effort: "max",
        sessionId: "u1",
        kitDir: input.kitDir,
      }),
    ).toEqual([
      "claude",
      "--model",
      "claude-fable-5-1[1m]",
      "--effort",
      "max",
      "--session-id",
      "u1",
      "--permission-mode",
      "bypassPermissions",
      "--settings",
      "/home/.local/share/wingmate/kit/JRF-404/claude-settings.json",
      "--strict-mcp-config",
    ]);
    expect(codexArgv({ model: "gpt-6.1-sol", effort: "xhigh", worktreePath: "/wt", role: "worker" })).toEqual(
      [
        "codex",
        "-C",
        "/wt",
        "--model",
        "gpt-6.1-sol",
        "-c",
        "model_reasoning_effort=xhigh",
        "-c",
        "approval_policy=never",
        "-c",
        "project_doc_max_bytes=0",
        "--sandbox",
        "workspace-write",
        "-c",
        "sandbox_workspace_write.network_access=false",
      ],
    );
    expect(codexArgv({ model: "m", effort: "xhigh", worktreePath: "/wt", role: "plan-verifier" })).toContain(
      "read-only",
    );
    expect(agentEnv(input.kitDir)).toMatchObject({
      GH_TOKEN: "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(shellQuote(["claude", "--model", "a[1m]", "x y"])).toBe("claude --model 'a[1m]' 'x y'");
    // beyond the brief
    expect(codexArgv({ model: "m", effort: "e", worktreePath: "/wt", role: "worker" })).not.toContain(
      "--ask-for-approval",
    );
    expect(
      coordinatorArgv({
        provider: "codex",
        model: "m",
        effort: "xhigh",
        sessionId: "u",
        kitDir: input.kitDir,
        worktreePath: "/wt",
      }),
    ).toEqual(codexArgv({ model: "m", effort: "xhigh", worktreePath: "/wt", role: "coordinator" }));
    expect(agentEnv(input.kitDir)).toEqual({
      GH_TOKEN: "",
      GH_CONFIG_DIR: "/home/.local/share/wingmate/kit/JRF-404/gh-empty",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/home/.local/share/wingmate/kit/JRF-404/gitconfig",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(shellQuote(["it's"])).toBe("'it'\\''s'");
    expect(launchCommand(["claude", "--model", "a[1m]"], { GH_TOKEN: "", A: "b c" })).toBe(
      "GH_TOKEN='' A='b c' exec claude --model 'a[1m]'",
    );
  });
});
