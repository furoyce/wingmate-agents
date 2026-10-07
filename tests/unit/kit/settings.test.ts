import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SPAWN_ROLES,
  agentEnv,
  claudeSettings,
  codexArgv,
  coordinatorArgv,
  isSiblingDeny,
  isValidBranchName,
  launchCommand,
  roleArgv,
  roleSettingsFile,
  shellQuote,
  siblingBranchDenyWrite,
  siblingBranches,
  siblingDenyWrite,
  userClaudeCredentialEnv,
} from "../../../src/kit/settings";
import { TOKEN_ENV } from "../../../src/linear/envToken";
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
/** The home directory the `~/` entries stand for in these tests (`input.kitDir` sits under it, as the real kit does). */
const HOME = "/home";
const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? `${HOME}${p.slice(1)}` : p);
/**
 * Claude Code 2.1.292's sandbox path rules, as read from its binary (`Hqt`, `Mqt`, `yl`): a plain path is a `subpath` rule (itself and
 * everything under it); a glob becomes an anchored regex with `.^$+{}()|\` escaped (so `[^x]` is the positive class `[\^x]`), and a
 * deny glob also covers everything under what it matches. `~/` is the home directory.
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
const covers = (raw: string, path: string, rule: "allow" | "deny"): boolean => {
  const pattern = expandHome(raw);
  return /[*?[\]]/.test(pattern)
    ? new RegExp(rule === "deny" ? `${globRegex(pattern).slice(0, -1)}(/.*)?$` : globRegex(pattern)).test(
        path,
      )
    : path === pattern || path.startsWith(`${pattern.replace(/\/$/, "")}/`);
};
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
      "/home/.local/share/wingmate/kit/JRF-404/**",
      "/repo/.git/**",
    ]);
    const t = claudeSettings({ ...input, childWorktrees: ["/wt/wm-jrf-404-worker-ab12"] }) as Settings;
    expect(t.sandbox.filesystem.allowRead).toEqual([
      "/wt/wm-jrf-404",
      "/wt/wm-jrf-404-worker-ab12",
      "/usr/bin",
      "/opt/homebrew",
      "~/.local/share/wingmate/bin/**",
      "/home/.local/share/wingmate/kit/JRF-404/**",
      "/repo/.git/**",
    ]);
    expect(t.sandbox.filesystem.allowWrite).toContain("/wt/wm-jrf-404-worker-ab12");
  });
  test("§13.3(a): the compiled binary and this issue's kit dir are readable; the rest of the state dir is not, and none of it is writable", () => {
    const fs = (claudeSettings(input) as Settings).sandbox.filesystem;
    expect(fs.allowRead).toContain("~/.local/share/wingmate/bin/**");
    expect(fs.allowRead.filter((p) => p.includes(".local/share/wingmate"))).toEqual([
      "~/.local/share/wingmate/bin/**",
      "/home/.local/share/wingmate/kit/JRF-404/**",
    ]);
    expect(fs.denyWrite).toContain("~/.local/share/wingmate/**");
    expect(fs.allowWrite.filter((p) => p.includes(".local/share/wingmate"))).toEqual([]);
  });
  test("F8: the issue's kit dir is readable (GIT_CONFIG_GLOBAL, GH_CONFIG_DIR and core.hooksPath point into it) and not writable", () => {
    const fs = (claudeSettings(input) as Settings).sandbox.filesystem;
    const env = agentEnv(input.kitDir);
    const used = [
      env.GIT_CONFIG_GLOBAL,
      `${env.GH_CONFIG_DIR}/config.yml`,
      `${input.kitDir}/no-hooks/pre-commit`,
    ];
    for (const p of [
      ...used,
      `${input.kitDir}/claude-settings.json`,
      `${input.kitDir}/claude-settings.worker.json`,
    ]) {
      if (p === undefined) throw new Error("agentEnv lost a kit path");
      expect(coveredBy(fs.denyRead, p, "deny")).toEqual(["~/"]); // inside the deny region …
      expect(coveredBy(fs.allowRead, p)).toEqual(["/home/.local/share/wingmate/kit/JRF-404/**"]); // … carved out for reading
      expect(coveredBy(fs.denyWrite, p, "deny")).toEqual(["~/.local/share/wingmate/**"]);
      expect(coveredBy(fs.allowWrite, p)).toEqual([]);
    }
    // only this issue's kit: another issue's kit, the records and the credentials stay unreadable
    for (const p of [
      "/home/.local/share/wingmate/kit/JRF-405/gitconfig",
      "/home/.local/share/wingmate/records/JRF-404.json",
      "/home/.config/wingmate/credentials.json",
    ])
      expect(coveredBy(fs.allowRead, p)).toEqual([]);
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
  test("R30 (Task 13 F7): every role denies writing <common>/refs/replace/** — a loose replace ref and its lock (defense in depth: install's core.useReplaceRefs=false is the close) — and a sibling refresh keeps the deny", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    for (const role of ["coordinator", ...SPAWN_ROLES] as const) {
      const fs = (claudeSettings({ ...input, role }) as Settings).sandbox.filesystem;
      for (const p of [`refs/replace/${sha}`, `refs/replace/${sha}.lock`, "refs/replace/x/y"])
        expect([role, coveredBy(fs.denyWrite, `/repo/.git/${p}`, "deny")]).toEqual([
          role,
          ["/repo/.git/refs/replace/**"],
        ]);
      for (const p of COMMIT_WRITES) expect(coveredBy(fs.denyWrite, `/repo/.git/${p}`, "deny")).toEqual([]);
    }
    expect(isSiblingDeny("/repo/.git", "/repo/.git/refs/replace/**")).toBe(false); // `refreshSiblingDenies` re-lists only siblings
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
  test("F10: every other worktree's branch ref and its lock are denied by name; the own branch never is", () => {
    const fs = (
      claudeSettings({
        ...input,
        siblingGitdirs: [...SIBLINGS, "wm-jrf-404"],
        siblingBranches: [
          "main",
          "furoyce/wm-jrf-999",
          "furoyce/wm-jrf-40",
          "owner/feature",
          "furoyce/wm-jrf-404",
          "furoyce",
          "furoyce/wm-jrf-404/x",
        ],
      }) as Settings
    ).sandbox.filesystem;
    for (const b of ["main", "furoyce/wm-jrf-999", "furoyce/wm-jrf-40", "owner/feature"]) {
      expect(fs.denyWrite).toContain(`/repo/.git/refs/heads/${b}`);
      expect(fs.denyWrite).toContain(`/repo/.git/refs/heads/${b}.lock`);
    }
    expect(coveredBy(fs.denyWrite, "/repo/.git/refs/heads/owner/feature", "deny").length).toBeGreaterThan(0);
    // the own branch, and a branch that is a path prefix or extension of it: a plain deny covers its subtree, and the sandbox
    // denies creating or unlinking each deny's ancestors, so either would break the own ref update
    for (const b of ["furoyce/wm-jrf-404", "furoyce", "furoyce/wm-jrf-404/x"]) {
      expect(fs.denyWrite).not.toContain(`/repo/.git/refs/heads/${b}`);
      expect(fs.denyWrite).not.toContain(`/repo/.git/refs/heads/${b}.lock`);
    }
    for (const p of COMMIT_WRITES) expect(coveredBy(fs.denyWrite, `/repo/.git/${p}`, "deny")).toEqual([]);
    // C9: a name git cannot give a branch points at no ref git writes — skipped, never a reason to refuse the whole kit
    const branchDenies = (b: string) =>
      (claudeSettings({ ...input, siblingBranches: [b] }) as Settings).sandbox.filesystem.denyWrite.filter(
        (p) => p.startsWith("/repo/.git/refs/heads/") && !p.includes("*"),
      );
    for (const b of ["wip/[1]", "x/*", "a//b", "../x", "x.lock", "a b", "-x", "a@{1}"])
      expect({ b, denies: branchDenies(b) }).toEqual({ b, denies: [] });
    // a valid branch name the sandbox would read as a pattern still cannot be denied exactly
    for (const b of ["a{b}", "a]b"])
      expect(() => claudeSettings({ ...input, siblingBranches: [b] })).toThrow(/cannot be denied exactly/);
    for (const b of ["", "*", "a//b", "../x"])
      expect(() => claudeSettings({ ...input, branch: b })).toThrow(/branch/);
  });
  test("C9: isValidBranchName follows `git check-ref-format --branch`", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "wm-ref-")); // outside any repository
    const corpus = [
      "main",
      "furoyce/wm-jrf-404",
      "a{b}",
      "a]b",
      "é/ü",
      "a./b",
      "a.lockx",
      "a.lock.b",
      "x-",
      "head",
      "a/HEAD",
      "@",
      "a@b",
      "refs/heads/x",
      "a.",
      ".a",
      "a/.b",
      "a..b",
      "x.lock",
      "x.lock/y",
      "furoyce/wm-jrf-404.lock",
      "-x",
      "HEAD",
      "a@{b",
      "a b",
      "a~1",
      "a^",
      "a:b",
      "a?b",
      "a*b",
      "a[b",
      "a\\b",
      "/a",
      "a/",
      "a//b",
      "a\tb",
      "a\x7fb",
      "a\x01b",
      "",
    ];
    for (const name of corpus) {
      const git = await run(["git", "check-ref-format", "--branch", name], { cwd });
      expect({ name, valid: isValidBranchName(name) }).toEqual({ name, valid: git.code === 0 });
    }
  });
  test("C9: a sibling branch deny never names the own branch, its lock or an ancestor directory of the own ref", () => {
    const heads = "/repo/.git/refs/heads/";
    const own = "furoyce/wm-jrf-404";
    // the own ref's lock as a "branch" (a sibling HEAD can name it), its parent directory, and the own branch itself
    expect(siblingBranchDenyWrite("/repo/.git", own, [`${own}.lock`, "furoyce", own, `${own}/x`])).toEqual(
      [],
    );
    // whatever the own branch is spelled like, no emitted path touches its ref, its lock or their ancestors
    expect(siblingBranchDenyWrite("/repo/.git", "x.lock", ["x", "y"])).toEqual([
      `${heads}y`,
      `${heads}y.lock`,
    ]);
    expect(siblingBranchDenyWrite("/repo/.git", "a.lock/b", ["a", "a.lock"])).toEqual([]);
    const denied = siblingBranchDenyWrite("/repo/.git", own, ["furoyce/wm-jrf-405", "main", "furoyce-x"]);
    expect(denied).toEqual([
      `${heads}furoyce-x`,
      `${heads}furoyce-x.lock`,
      `${heads}furoyce/wm-jrf-405`,
      `${heads}furoyce/wm-jrf-405.lock`,
      `${heads}main`,
      `${heads}main.lock`,
    ]);
    for (const p of [`${heads}${own}`, `${heads}${own}.lock`])
      expect(coveredBy(denied, p, "deny")).toEqual([]);
  });
  test("F10: the main checkout's MERGE_HEAD/ORIG_HEAD/FETCH_HEAD, submodule hooks and config, and legacy remotes/branches are denied", () => {
    const fs = (claudeSettings(input) as Settings).sandbox.filesystem;
    for (const t of ["MERGE_HEAD", "ORIG_HEAD", "FETCH_HEAD"]) {
      expect(coveredBy(fs.denyWrite, `/repo/.git/${t}`, "deny")).toEqual([`/repo/.git/${t}`]);
      // a merge, rebase or fetch in the own linked worktree writes these in its own gitdir (`git rev-parse --git-path`, git 2.53)
      expect(coveredBy(fs.denyWrite, `/repo/.git/worktrees/wm-jrf-404/${t}`, "deny")).toEqual([]);
    }
    for (const p of [
      "modules/sub/hooks/post-checkout",
      "modules/a/modules/b/hooks/pre-commit",
      "modules/sub/config",
      "modules/a/modules/b/config",
      "remotes/origin",
      "branches/origin",
    ])
      expect(coveredBy(fs.denyWrite, `/repo/.git/${p}`, "deny").length).toBeGreaterThan(0);
    // the own worktree's submodule gitdirs live in its own gitdir (`--git-path modules`), so they stay writable
    for (const p of ["modules/sub/index", "modules/sub/HEAD", "modules/sub/config"])
      expect(coveredBy(fs.denyWrite, `/repo/.git/worktrees/wm-jrf-404/${p}`, "deny")).toEqual([]);
  });
  test("F10: sibling branches are read from the main checkout's and every other worktree's HEAD; detached and own HEADs add none", async () => {
    const root = mkdtempSync(join(tmpdir(), "wm-br-"));
    const main = join(root, "main");
    await run(["git", "init", "-q", "-b", "main", main]);
    await run(["git", "-C", main, ...GIT_ID, "commit", "-q", "--allow-empty", "-m", "init"]);
    const common = join(main, ".git");
    for (const n of ["wm-jrf-404", "wm-jrf-405"])
      expect(
        (await run(["git", "-C", main, "worktree", "add", "-q", "-b", `furoyce/${n}`, join(root, n)])).code,
      ).toBe(0);
    expect((await run(["git", "-C", main, "worktree", "add", "-q", "--detach", join(root, "dt")])).code).toBe(
      0,
    );
    expect(siblingBranches(common, "wm-jrf-404")).toEqual(["furoyce/wm-jrf-405", "main"]);
    const fs = (claudeSettings({ ...input, commonDir: common }) as Settings).sandbox.filesystem;
    expect(fs.denyWrite.filter((p) => p.startsWith(`${common}/refs/heads/`) && !p.includes("*"))).toEqual([
      `${common}/refs/heads/furoyce/wm-jrf-405`,
      `${common}/refs/heads/furoyce/wm-jrf-405.lock`,
      `${common}/refs/heads/main`,
      `${common}/refs/heads/main.lock`,
    ]);
    expect(fs.denyWrite.filter((p) => p.startsWith(`${common}/worktrees/`))).toEqual([
      `${common}/worktrees/dt`,
      `${common}/worktrees/wm-jrf-405`,
    ]);
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
    // C4: the coordinator's own kit settings deny starting or dispatching workers directly — `wingmate issue spawn` runs
    // worker-start as a subprocess the permission layer never sees — while run-create and task-create stay allowed
    const c = claudeSettings(input) as Settings;
    expect(c.permissions.deny).toContain("Bash(orca orchestration worker-start *)");
    expect(c.permissions.deny).toContain("Bash(orca orchestration dispatch *)");
    expect(c.permissions.deny).not.toContain("Bash(orca orchestration run-create *)");
    expect(c.permissions.deny).not.toContain("Bash(orca orchestration task-create *)");
  });
  test("C2: agentEnv names the role; every role but the coordinator is denied `wingmate issue … spawn`", () => {
    expect(agentEnv(input.kitDir).WINGMATE_ROLE).toBe("coordinator");
    expect(agentEnv(input.kitDir, "worker").WINGMATE_ROLE).toBe("worker");
    expect(launchCommand(["claude"], agentEnv(input.kitDir, "plan-verifier"))).toEndWith(
      " WINGMATE_ROLE=plan-verifier exec claude",
    );
    const spawnDeny = [
      "Bash(wingmate issue * spawn*)",
      "Bash(*/wingmate issue * spawn*)",
      "Bash(wingmate issue spawn*)",
      "Bash(*/wingmate issue spawn*)",
    ];
    for (const role of SPAWN_ROLES) {
      const deny = (claudeSettings({ ...input, role }) as Settings).permissions.deny;
      for (const d of spawnDeny) expect({ role, has: deny.includes(d) }).toEqual({ role, has: true });
    }
    const coordinator = (claudeSettings(input) as Settings).permissions.deny;
    for (const d of spawnDeny) expect(coordinator).not.toContain(d);
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
      GITHUB_TOKEN: "",
      GH_ENTERPRISE_TOKEN: "",
      GITHUB_ENTERPRISE_TOKEN: "",
      WINGMATE_LINEAR_TOKEN: "",
      GITHUB_PERSONAL_ACCESS_TOKEN: "",
      GH_CONFIG_DIR: "/home/.local/share/wingmate/kit/JRF-404/gh-empty",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/home/.local/share/wingmate/kit/JRF-404/gitconfig",
      GIT_TERMINAL_PROMPT: "0",
      WINGMATE_ROLE: "coordinator",
    });
    expect(shellQuote(["it's"])).toBe("'it'\\''s'");
    expect(launchCommand(["claude", "--model", "a[1m]"], { GH_TOKEN: "", A: "b c" })).toBe(
      "GH_TOKEN='' A='b c' exec claude --model 'a[1m]'",
    );
  });
  test("SEC-1: every kit settings file blanks the credential variables at policy precedence — the fixed GitHub/Linear ones and the credential-named keys of the owner's user-level Claude env; Claude's own auth and Orca's variables never", () => {
    const blankEnv = [
      "LANGFUSE_SECRET_KEY",
      "LANGFUSE_PUBLIC_KEY",
      "ANTHROPIC_API_KEY",
      "ORCA_AGENT_TOKEN",
      "DEBUG",
    ];
    for (const role of ["coordinator", "worker", "ui-reviewer"] as const) {
      const env = (claudeSettings({ ...input, role, blankEnv }) as { env: Record<string, string> }).env;
      expect(env).toEqual({
        GH_ENTERPRISE_TOKEN: "",
        GH_TOKEN: "",
        GITHUB_ENTERPRISE_TOKEN: "",
        GITHUB_PERSONAL_ACCESS_TOKEN: "",
        GITHUB_TOKEN: "",
        LANGFUSE_PUBLIC_KEY: "",
        LANGFUSE_SECRET_KEY: "",
        WINGMATE_LINEAR_TOKEN: "",
      });
    }
    // the launch line blanks them too (a process the owner's shell or the dispatcher exported them to)
    const env = agentEnv(input.kitDir, "coordinator", ["LANGFUSE_SECRET_KEY", "ANTHROPIC_AUTH_TOKEN"]);
    expect(env.LANGFUSE_SECRET_KEY).toBe("");
    expect(env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });
  test("SEC-1: userClaudeCredentialEnv reads only the names of the user-level Claude env's credential keys; nothing when unreadable", () => {
    const home = mkdtempSync(join(tmpdir(), "wm-home-"));
    expect(userClaudeCredentialEnv(home)).toEqual([]);
    mkdirSync(join(home, ".claude"));
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        model: "m",
        env: {
          GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_x",
          LANGFUSE_SECRET_KEY: "sk-lf-x",
          LANGFUSE_PUBLIC_KEY: "pk-lf-x",
          ANTHROPIC_API_KEY: "sk-ant-x",
          ORCA_AGENT_TOKEN: "o",
          DEBUG: "1",
          "not a name": "x",
        },
      }),
    );
    expect(userClaudeCredentialEnv(home)).toEqual([
      "GITHUB_PERSONAL_ACCESS_TOKEN",
      "LANGFUSE_PUBLIC_KEY",
      "LANGFUSE_SECRET_KEY",
    ]);
    writeFileSync(join(home, ".claude", "settings.json"), "{ not json");
    expect(userClaudeCredentialEnv(home)).toEqual([]);
  });
  test("F9: every token variable gh falls back to after GH_TOKEN is blanked", () => {
    const env = agentEnv(input.kitDir);
    for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"])
      expect(env[k]).toBe("");
    expect(launchCommand(["claude"], env)).toStartWith(
      "GH_TOKEN='' GITHUB_TOKEN='' GH_ENTERPRISE_TOKEN='' GITHUB_ENTERPRISE_TOKEN='' ",
    );
  });
  test("F4: the owner's personal Linear key is blank in every agent's environment and launch line, whatever the dispatcher's own environment holds", () => {
    const saved = process.env[TOKEN_ENV];
    process.env[TOKEN_ENV] = "lin_api_settings_test";
    try {
      for (const role of ["coordinator", "worker", "code-reviewer"] as const) {
        const env = agentEnv(input.kitDir, role);
        expect(env[TOKEN_ENV]).toBe("");
        expect(launchCommand(["claude"], env)).toContain(` ${TOKEN_ENV}='' `);
        expect(launchCommand(["claude"], env)).not.toContain("lin_api_settings_test");
      }
    } finally {
      if (saved === undefined) delete process.env[TOKEN_ENV];
      else process.env[TOKEN_ENV] = saved;
    }
  });
  test("F1: roleArgv — Claude runs with its role's kit settings file; tier standard has no --model/--effort; Codex via codexArgv", () => {
    const base = { sessionId: "u1", worktreePath: "/wt" };
    expect(roleSettingsFile(input.kitDir, "code-reviewer")).toBe(
      "/home/.local/share/wingmate/kit/JRF-404/claude-settings.code-reviewer.json",
    );
    expect(
      roleArgv({
        ...base,
        provider: "claude",
        role: "code-reviewer",
        tier: { model: "claude-fable-5-1[1m]", effort: "max" },
        settingsFile: roleSettingsFile(input.kitDir, "code-reviewer"),
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
      "/home/.local/share/wingmate/kit/JRF-404/claude-settings.code-reviewer.json",
      "--strict-mcp-config",
    ]);
    // §9.2 tier standard (workers): the provider's own default model and effort
    expect(
      roleArgv({
        ...base,
        provider: "claude",
        role: "worker",
        tier: null,
        settingsFile: roleSettingsFile(input.kitDir, "worker"),
      }),
    ).toEqual([
      "claude",
      "--session-id",
      "u1",
      "--permission-mode",
      "bypassPermissions",
      "--settings",
      "/home/.local/share/wingmate/kit/JRF-404/claude-settings.worker.json",
      "--strict-mcp-config",
    ]);
    const codex = { ...base, provider: "codex" as const, settingsFile: "unused" };
    expect(roleArgv({ ...codex, role: "plan-verifier", tier: { model: "gpt-x", effort: "xhigh" } })).toEqual(
      codexArgv({ model: "gpt-x", effort: "xhigh", worktreePath: "/wt", role: "plan-verifier" }),
    );
    expect(roleArgv({ ...codex, role: "security-reviewer", tier: { model: "g", effort: "e" } })).toContain(
      "read-only",
    );
    expect(roleArgv({ ...codex, role: "worker", tier: null })).toEqual([
      "codex",
      "-C",
      "/wt",
      "-c",
      "approval_policy=never",
      "-c",
      "project_doc_max_bytes=0",
      "--sandbox",
      "workspace-write",
      "-c",
      "sandbox_workspace_write.network_access=false",
    ]);
  });
});

describe("F13: shell quoting survives the login shell", () => {
  /**
   * The owner's login shell runs the launch line with their options, so zsh also runs with MAGIC_EQUAL_SUBST (C6): it expands `~` and
   * `=cmd` after the `=` of any unquoted `anything=value` argument and after each `:` in it (`x==ls` → `x=/bin/ls`).
   */
  const shells = ["/bin/zsh", "/bin/zsh+magicequalsubst", "/bin/bash", "/bin/sh"].filter((s) =>
    existsSync(s.split("+")[0] ?? s),
  );
  const shellArgv = (sh: string, line: string) => {
    const [bin = sh, opt] = sh.split("+");
    return [bin, ...(bin.endsWith("zsh") ? ["-f"] : []), ...(opt ? ["-o", opt] : []), "-c", line];
  };
  /** mulberry32: a seeded PRNG, so the fuzz corpus is the same on every run. */
  const prng = (seed: number) => {
    let s = seed;
    return () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const fuzz = (n: number): string[] => {
    const rnd = prng(20261006);
    const alphabet = "aZ09_./:,-= ~'\"[]1m$`*?!\\;|&(){}<>#%^@+\t\né";
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      let w = "";
      for (let k = Math.floor(rnd() * 12); k > 0; k--) w += alphabet[Math.floor(rnd() * alphabet.length)];
      const r = rnd();
      if (r < 0.25) w = `=${w}`;
      else if (r < 0.5) w = `~${w}`;
      if (rnd() < 0.3) w = `${w}[1m]`;
      out.push(w);
    }
    return out;
  };
  test("leading = (zsh EQUALS) and ~ (tilde) are quoted; the safe charset stays bare", () => {
    expect(shellQuote(["=ls", "=", "~", "~/x", "=claude-fable-5-1[1m]"])).toBe(
      "'=ls' '=' '~' '~/x' '=claude-fable-5-1[1m]'",
    );
    expect(shellQuote(["/k/x.json", "a,b", "--sandbox", "read-only", "gpt-6.1_x"])).toBe(
      "/k/x.json a,b --sandbox read-only gpt-6.1_x",
    );
  });
  test("C6: any word containing ':' or '=' is quoted (zsh MAGIC_EQUAL_SUBST expands after both)", () => {
    expect(shellQuote(["--model=x", "a=b", "model_reasoning_effort=xhigh", "a,b:c", "x==ls", "a:=ls"])).toBe(
      "'--model=x' 'a=b' 'model_reasoning_effort=xhigh' 'a,b:c' 'x==ls' 'a:=ls'",
    );
    expect(launchCommand(["codex", "-c", "approval_policy=never"], { A: "x:y", B: "p=q" })).toBe(
      "A='x:y' B='p=q' exec codex -c 'approval_policy=never'",
    );
  });
  test("fuzz: = and ~ prefixes, spaces, quotes, globs and [1m] suffixes come back verbatim from zsh, bash and sh", async () => {
    expect(shells.length).toBeGreaterThan(0);
    const home = mkdtempSync(join(tmpdir(), "wm-home-")); // a tilde that leaks would expand to this, never the real home
    const fixed = [
      "=ls",
      "=",
      "~",
      "~/x",
      "~root",
      "a=~/b",
      "=claude-fable-5-1[1m]",
      "~[1m]",
      "it's",
      "x y",
      "",
      // C6: assignment-shaped words, which MAGIC_EQUAL_SUBST (zsh) and bash's assignment-word tilde rule expand
      "a:=ls",
      "x=~/y",
      "x==ls",
      "x=a:=ls",
      "--prefix==ls",
      "PATH=/a:~/b",
      "k=v:=w",
    ];
    const words = [...fixed, ...fuzz(300)];
    for (const sh of shells) {
      const r = await run(shellArgv(sh, `printf '%s\\0' ${shellQuote(words)}`), { env: { HOME: home } });
      expect({ sh, code: r.code, stderr: r.stderr }).toEqual({ sh, code: 0, stderr: "" });
      expect(r.stdout.split("\0").slice(0, -1)).toEqual(words);
    }
  });
  test("launchCommand: env values with = and ~ prefixes arrive verbatim; the owner's exported tokens arrive blank (F9), the personal Linear key too (F4)", async () => {
    const home = mkdtempSync(join(tmpdir(), "wm-home-"));
    const cmd = launchCommand(["/usr/bin/env"], {
      ...agentEnv("/k"),
      WM_A: "=x ~y",
      WM_B: "~/z",
      WM_C: "x==ls",
      WM_D: "k=v:=w",
    });
    for (const sh of shells) {
      const r = await run(shellArgv(sh, cmd), {
        env: {
          HOME: home,
          GITHUB_TOKEN: "owner-token",
          GH_ENTERPRISE_TOKEN: "owner-token",
          WINGMATE_LINEAR_TOKEN: "owner-key", // F4: as a login shell that exports it would hold it
        },
      });
      expect(r.code).toBe(0);
      const env = new Map(
        r.stdout.split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
      );
      expect([env.get("WM_A"), env.get("WM_B"), env.get("WM_C"), env.get("WM_D")]).toEqual([
        "=x ~y",
        "~/z",
        "x==ls",
        "k=v:=w",
      ]);
      expect(env.get("WINGMATE_ROLE")).toBe("coordinator");
      for (const k of [
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "GH_ENTERPRISE_TOKEN",
        "GITHUB_ENTERPRISE_TOKEN",
        "WINGMATE_LINEAR_TOKEN",
      ])
        expect(env.get(k)).toBe("");
    }
  });
});
