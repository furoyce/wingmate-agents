import { describe, expect, test } from "bun:test";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentEnv,
  claudeSettings,
  codexArgv,
  coordinatorArgv,
  launchCommand,
  shellQuote,
  siblingDenyWrite,
} from "../../../src/kit/settings";
import { run } from "../../../src/shared/exec";

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
/**
 * Claude Code 2.1.292's sandbox path rules, as read from its binary (`Hqt`, `Mqt`, `yl`): a plain path is a `subpath` rule (itself and
 * everything under it); a glob becomes an anchored regex with `.^$+{}()|\` escaped (so `[^x]` is the positive class `[\^x]`), and a
 * deny glob also covers everything under what it matches.
 */
const globRegex = (g: string) =>
  `^${g
    .replace(/[.^$+{}()|\\]/g, "\\$&")
    .replace(/\[([^\]]*?)$/g, "\\[$1")
    .replace(/\*\*\//g, "__GLOBSTAR_SLASH__")
    .replace(/\*\*/g, "__GLOBSTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/__GLOBSTAR_SLASH__/g, "(.*/)?")
    .replace(/__GLOBSTAR__/g, ".*")}$`;
const covers = (pattern: string, path: string, rule: "allow" | "deny"): boolean =>
  /[*?[\]]/.test(pattern)
    ? new RegExp(rule === "deny" ? `${globRegex(pattern).slice(0, -1)}(/.*)?$` : globRegex(pattern)).test(
        path,
      )
    : path === pattern || path.startsWith(`${pattern}/`);
const coveredBy = (patterns: string[], path: string, rule: "allow" | "deny" = "allow") =>
  patterns.filter((p) => covers(p, path, rule));
/** The prober's sibling names (F7), chosen to collide with the own `wm-jrf-404` by prefix; the own name in the list is skipped. */
const SIBLINGS = ["wm-jrf-999", "wm-jrf-40", "wm-jrf-4040", "wm-jrf-404x", "wm-x", "a"];
/** What `git add`/`git commit` in the own linked worktree writes inside the common dir (spike §3.4; `packed-refs.lock` per F7). */
const COMMIT_WRITES = [
  ...["index.lock", "index", "HEAD.lock", "HEAD", "logs/HEAD", "COMMIT_EDITMSG", "ORIG_HEAD"].map(
    (f) => `worktrees/wm-jrf-404/${f}`,
  ),
  "objects/ab/cdef0123456789",
  "objects/pack/pack-1.idx",
  "objects/info/commit-graph.lock",
  "refs/heads/furoyce/wm-jrf-404",
  "refs/heads/furoyce/wm-jrf-404.lock",
  "logs/refs/heads/furoyce/wm-jrf-404",
  "packed-refs",
  "packed-refs.lock",
];
const GIT_ID = ["-c", "user.name=t", "-c", "user.email=t@example.invalid"];

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
  test("git in the own linked worktree can commit: no denyWrite rule covers what a commit writes in the common dir", () => {
    const fs = (claudeSettings({ ...input, siblingGitdirs: [...SIBLINGS, "wm-jrf-404"] }) as Settings).sandbox
      .filesystem;
    // deny wins over allow in Claude's sandbox, so a deny covering any of these would fail `git add`/`git commit`
    for (const p of COMMIT_WRITES) expect(coveredBy(fs.denyWrite, `/repo/.git/${p}`, "deny")).toEqual([]);
    for (const f of ["index.lock", "index", "HEAD.lock", "HEAD", "logs/HEAD", "COMMIT_EDITMSG"])
      expect(coveredBy(fs.allowWrite, `/repo/.git/worktrees/wm-jrf-404/${f}`)).toEqual([
        "/repo/.git/worktrees/wm-jrf-404/**",
      ]);
  });
  test("F7: Claude grants a linked worktree's common dir itself, so every other worktree's gitdir is denied by name", () => {
    // Claude Code adds the detected common dir to allowWrite (`ge.push(commonDir)`), so no allowWrite entry restricts `<common>`:
    // a sibling is unwritable only if a denyWrite rule covers it (the old "default write deny" assumption did not hold)
    const fs = (claudeSettings({ ...input, siblingGitdirs: [...SIBLINGS, "wm-jrf-404"] }) as Settings).sandbox
      .filesystem;
    for (const s of SIBLINGS) {
      expect(fs.denyWrite).toContain(`/repo/.git/worktrees/${s}`);
      for (const f of ["", "/HEAD", "/HEAD.lock", "/index", "/index.lock", "/logs/HEAD", "/config.worktree"])
        expect(coveredBy(fs.denyWrite, `/repo/.git/worktrees/${s}${f}`, "deny").length).toBeGreaterThan(0);
    }
    for (const f of ["", "/HEAD", "/index", "/index.lock"])
      expect(coveredBy(fs.denyWrite, `/repo/.git/worktrees/wm-jrf-404${f}`, "deny")).toEqual([]);
    // no blanket or negated worktrees glob: either would also cover the own gitdir (`^` is escaped, `[!…]` is a positive class)
    expect(fs.denyWrite.filter((p) => p.startsWith("/repo/.git/worktrees/") && /[*?[\]]/.test(p))).toEqual(
      [],
    );
    expect(fs.denyWrite.filter((p) => p.includes("[^") || p.includes("[!"))).toEqual([]);
  });
  test("F7: the main checkout's HEAD and index and the repo-wide shallow/gc.pid are denied with their locks; packed-refs.lock is not", () => {
    const fs = (claudeSettings(input) as Settings).sandbox.filesystem;
    for (const t of ["HEAD", "HEAD.lock", "index", "index.lock", "shallow", "shallow.lock", "gc.pid"])
      expect(coveredBy(fs.denyWrite, `/repo/.git/${t}`, "deny")).toEqual([`/repo/.git/${t}`]);
    // `git commit` takes packed-refs.lock (denying it printed `Unable to create packed-refs.lock`), so neither it nor a
    // `<common>/*.lock` blanket is denied
    expect(coveredBy(fs.denyWrite, "/repo/.git/packed-refs.lock", "deny")).toEqual([]);
    expect(fs.denyWrite).not.toContain("/repo/.git/*.lock");
  });
  test("F7: sibling names come from the input, the own name is skipped, and a name that is not one literal path component is refused", () => {
    const none = (claudeSettings({ ...input, siblingGitdirs: ["wm-jrf-404"] }) as Settings).sandbox
      .filesystem;
    expect(none.denyWrite.filter((p) => p.startsWith("/repo/.git/worktrees/"))).toEqual([]);
    // a glob character would turn the deny into a pattern that could cover the own gitdir
    for (const g of ["*", "wm-*", "wm-[1]", "{a,b}", "a\\b"])
      expect(() => claudeSettings({ ...input, siblingGitdirs: [g] })).toThrow(/cannot be denied exactly/);
    expect(siblingDenyWrite("/repo/.git", "wm-jrf-404", ["b", "a", "wm-jrf-404", "a"])).toEqual([
      "/repo/.git/worktrees/a",
      "/repo/.git/worktrees/b",
    ]);
    expect(() => siblingDenyWrite("/repo/.git", "", ["a"])).toThrow(/gitdirName/);
  });
  test("F7: siblingDenyWrite lists a real repo's worktree gitdirs; symlinks and files are skipped, a repo without linked worktrees has none", async () => {
    const root = mkdtempSync(join(tmpdir(), "wm-sib-"));
    const main = join(root, "main");
    await run(["git", "init", "-q", main]);
    await run(["git", "-C", main, ...GIT_ID, "commit", "-q", "--allow-empty", "-m", "init"]);
    const common = join(main, ".git");
    expect(siblingDenyWrite(common, "wm-jrf-404")).toEqual([]);
    for (const n of ["wm-jrf-404", "wm-jrf-40", "wm-jrf-999"])
      expect(
        (await run(["git", "-C", main, "worktree", "add", "-q", "-b", `furoyce/${n}`, join(root, n)])).code,
      ).toBe(0);
    // Claude resolves a deny path through a symlink, so a planted link must never be listed (it could aim the deny at the own gitdir)
    symlinkSync(join(common, "worktrees", "wm-jrf-404"), join(common, "worktrees", "zz-link"));
    writeFileSync(join(common, "worktrees", "stray"), "x");
    expect(siblingDenyWrite(common, "wm-jrf-404")).toEqual([
      `${common}/worktrees/wm-jrf-40`,
      `${common}/worktrees/wm-jrf-999`,
    ]);
    // claudeSettings lists them itself when the caller passes no names
    const fs = (claudeSettings({ ...input, commonDir: common }) as Settings).sandbox.filesystem;
    expect(fs.denyWrite.filter((p) => p.startsWith(`${common}/worktrees/`))).toEqual([
      `${common}/worktrees/wm-jrf-40`,
      `${common}/worktrees/wm-jrf-999`,
    ]);
    expect(siblingDenyWrite(join(root, "nope", ".git"), "wm-jrf-404")).toEqual([]);
  });
  test("a gitdirName that is not one literal path component is refused: it would widen the own-gitdir grant", () => {
    for (const g of ["", ".", "..", "a/b", "*", "wm-[1]", "{a,b}"])
      expect(() => claudeSettings({ ...input, gitdirName: g })).toThrow(/gitdirName/);
  });
  test("lock files: the allowWrite globs cover only their own locks; the common dir's top-level locks are denied", () => {
    const fs = (claudeSettings(input) as Settings).sandbox.filesystem;
    expect(fs.allowWrite).not.toContain("/repo/.git/*.lock");
    expect(
      fs.allowWrite.filter((p) => /^\/repo\/\.git\/[^/]*\.lock$/.test(p) || p.endsWith("/*.lock")),
    ).toEqual([]);
    // allowWrite is inert inside the common dir (F7), so the top-level locks are kept out by denyWrite; `config.lock` is
    // Claude's own deny and `gc.pid.lock` is out of the F7 list
    for (const l of ["HEAD.lock", "index.lock", "shallow.lock"])
      expect(coveredBy(fs.denyWrite, `/repo/.git/${l}`, "deny").length).toBeGreaterThan(0);
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
