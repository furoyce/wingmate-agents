// tests/unit/git/cli.test.ts — GitCli against a real temp repository; GhCli against an injected runner (no network)
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { GhCli } from "../../../src/gh/cli";
import { GitCli, type Runner } from "../../../src/git/cli";
import { type RunResult, run } from "../../../src/shared/exec";

const HERMETIC = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const ID = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"];
async function git(args: string[]): Promise<string> {
  const r = await run(["git", ...args], { env: HERMETIC });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}
/** main with two commits; branch `feature` one commit ahead with one added secret-shaped line. */
async function repo(): Promise<{ dir: string; base: string }> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wm-gitcli-")));
  await git(["init", "-q", "-b", "main", dir]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  await git(["-C", dir, "add", "a.txt"]);
  await git(["-C", dir, ...ID, "commit", "-q", "-m", "one"]);
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  await git(["-C", dir, ...ID, "commit", "-q", "-am", "two"]);
  const base = (await git(["-C", dir, "rev-parse", "HEAD"])).trim();
  await git(["-C", dir, "switch", "-q", "-c", "feature"]);
  writeFileSync(join(dir, "src.ts"), 'const x = 1;\ntoken = "sk-ant-api03-xxxx"\n');
  await git(["-C", dir, "add", "src.ts"]);
  await git(["-C", dir, ...ID, "commit", "-q", "-m", "feature"]);
  return { dir, base };
}

describe("GitCli", () => {
  test("changedPaths, addedLines, commitsAhead, revParse, commonDir and gitDir", async () => {
    const { dir, base } = await repo();
    const g = new GitCli();
    expect(await g.changedPaths(dir, base)).toEqual(["src.ts"]);
    expect(await g.addedLines(dir, base)).toEqual([
      { path: "src.ts", line: "const x = 1;" },
      { path: "src.ts", line: 'token = "sk-ant-api03-xxxx"' },
    ]);
    expect(await g.commitsAhead(dir, base)).toBe(1);
    expect(await g.revParse(dir, "HEAD")).toMatch(/^[0-9a-f]{40}$/);
    expect(await g.revParse(dir, "main")).toBe(base);
    expect((await g.commonDir(dir)).endsWith(".git")).toBe(true);
    expect(await g.gitDir(dir)).toBe(join(dir, ".git"));
  });
  test("a linked worktree's gitDir is its admin dir under the common dir (the gitdirName the kit denies by)", async () => {
    const { dir } = await repo();
    const wt = join(realpathSync(mkdtempSync(join(tmpdir(), "wm-gitcli-wt-"))), "wm-jrf-9");
    await git(["-C", dir, "worktree", "add", "-q", "-b", "furoyce/wm-jrf-9", wt, "main"]);
    const g = new GitCli();
    expect(await g.commonDir(wt)).toBe(join(dir, ".git"));
    const gd = await g.gitDir(wt);
    expect(gd.startsWith(join(dir, ".git", "worktrees"))).toBe(true);
    expect(basename(gd)).toBe("wm-jrf-9");
  });
  test("an added line that itself starts with '++' inside a hunk is not mistaken for a file header", async () => {
    const { dir, base } = await repo();
    writeFileSync(join(dir, "plus.txt"), "++ b/not-a-header\n");
    await git(["-C", dir, "add", "plus.txt"]);
    await git(["-C", dir, ...ID, "commit", "-q", "-m", "plus"]);
    const lines = await new GitCli().addedLines(dir, base);
    expect(lines).toContainEqual({ path: "plus.txt", line: "++ b/not-a-header" });
  });
  test("failures carry the git verb and exit code; GIT_TERMINAL_PROMPT=0 is always set", async () => {
    const seen: { argv: string[]; env: Record<string, string> | undefined }[] = [];
    const runner: Runner = async (argv, opts) => {
      seen.push({ argv, env: opts?.env });
      return { code: 128, stdout: "", stderr: "fatal: not a git repository", timedOut: false };
    };
    await expect(new GitCli(runner).revParse("/nowhere", "HEAD")).rejects.toThrow(/rev-parse failed \(128\)/);
    expect(seen[0]?.argv.slice(0, 3)).toEqual(["git", "-C", "/nowhere"]);
    expect(seen[0]?.env?.GIT_TERMINAL_PROMPT).toBe("0");
  });
  test("push sends exactly the verified commit to refs/heads/<branch> with -u, never forced; branch and sha are checked first", async () => {
    const calls: string[][] = [];
    const runner: Runner = async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    const g = new GitCli(runner);
    const sha = "a".repeat(40);
    await g.push("/w", "furoyce/wm-jrf-1", sha);
    expect(calls).toEqual([
      ["git", "-C", "/w", "push", "-u", "origin", `${sha}:refs/heads/furoyce/wm-jrf-1`],
    ]);
    for (const branch of ["--upload-pack=x", "+main", "main:other", "a..b", ""])
      await expect(g.push("/w", branch, sha)).rejects.toMatchObject({ code: "branch_invalid" });
    for (const bad of ["HEAD", `+${sha}`, `${sha}:refs/heads/main`, "abc"])
      await expect(g.push("/w", "furoyce/wm-jrf-1", bad)).rejects.toMatchObject({ code: "sha_invalid" });
    await expect(g.lsRemoteSha("/w", "--upload-pack=x")).rejects.toMatchObject({ code: "branch_invalid" });
    expect(calls).toHaveLength(1);
  });
  test("a rename is seen from both sides (--no-renames): a file moved out of a guarded path is still a changed path", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "wm-gitcli-mv-")));
    await git(["init", "-q", "-b", "main", dir]);
    mkdirSync(join(dir, ".github"), { recursive: true });
    writeFileSync(join(dir, ".github", "ci.yml"), "on: push\njobs: {}\n");
    await git(["-C", dir, "add", "."]);
    await git(["-C", dir, ...ID, "commit", "-q", "-m", "ci"]);
    const base = (await git(["-C", dir, "rev-parse", "HEAD"])).trim();
    await git(["-C", dir, "switch", "-q", "-c", "feature"]);
    mkdirSync(join(dir, "docs"), { recursive: true });
    await git(["-C", dir, "mv", ".github/ci.yml", "docs/ci.yml"]);
    await git(["-C", dir, ...ID, "commit", "-q", "-m", "move"]);
    const g = new GitCli();
    expect((await g.changedPaths(dir, base)).sort()).toEqual([".github/ci.yml", "docs/ci.yml"]);
    expect(await g.addedLines(dir, base)).toEqual([
      { path: "docs/ci.yml", line: "on: push" },
      { path: "docs/ci.yml", line: "jobs: {}" },
    ]);
  });
  test("the diff, added lines and commit count read an explicit head when one is given", async () => {
    const { dir, base } = await repo();
    const g = new GitCli();
    const head = await g.revParse(dir, "HEAD");
    await git(["-C", dir, "switch", "-q", "main"]); // HEAD moves; the explicit head does not
    expect(await g.changedPaths(dir, base, head)).toEqual(["src.ts"]);
    expect(await g.addedLines(dir, base, head)).toHaveLength(2);
    expect(await g.commitsAhead(dir, base, head)).toBe(1);
    expect(await g.changedPaths(dir, base)).toEqual([]);
  });
  test("F3: historyChanges reads every commit the push sends — a file added then removed is absent from the net diff only", async () => {
    const { dir, base } = await repo();
    const neon = "DATABASE_URL=postgresql://app:S3cret@ep-cool-sound-123456.us-east-2.aws.neon.tech/neondb";
    writeFileSync(join(dir, ".env"), `${neon}\n`);
    await git(["-C", dir, "add", ".env"]);
    await git(["-C", dir, ...ID, "commit", "-q", "-m", "add env\n\nGH_TOKEN in the message"]);
    await git(["-C", dir, "rm", "-q", ".env"]);
    await git(["-C", dir, ...ID, "commit", "-q", "-m", "remove env"]);
    await git(["-C", dir, "switch", "-q", "main"]); // a merge brings main's later change in against its first parent
    writeFileSync(join(dir, "m.txt"), "from main\n");
    await git(["-C", dir, "add", "m.txt"]);
    await git(["-C", dir, ...ID, "commit", "-q", "-m", "main change"]);
    await git(["-C", dir, "switch", "-q", "feature"]);
    await git(["-C", dir, ...ID, "merge", "-q", "--no-edit", "-m", "merge main", "main"]);
    const g = new GitCli();
    const head = await g.revParse(dir, "HEAD");
    expect((await g.changedPaths(dir, base, head)).sort()).toEqual(["m.txt", "src.ts"]); // .env is gone from the net diff
    const h = await g.historyChanges(dir, base, head);
    expect([...h.paths].sort()).toEqual([".env", "m.txt", "src.ts"]);
    expect(h.added).toContainEqual({ path: ".env", line: neon });
    expect(h.added).toContainEqual({ path: "src.ts", line: 'token = "sk-ant-api03-xxxx"' });
    expect(h.added).toContainEqual({ path: "m.txt", line: "from main" });
    for (const m of [
      "feature",
      "add env",
      "GH_TOKEN in the message",
      "remove env",
      "main change",
      "merge main",
    ])
      expect(h.messages).toContain(m);
    await git(["-C", dir, "switch", "-q", "main"]); // HEAD moves; the explicit head does not
    expect((await g.historyChanges(dir, base, head)).paths).toContain(".env");
  });
  test("F2 (D14): every git process GitCli starts runs no repository hook and no fsmonitor, without prompting", async () => {
    const seen: { argv: string[]; env: Record<string, string> }[] = [];
    const runner: Runner = async (argv, opts) => {
      seen.push({ argv, env: opts?.env ?? {} });
      const out = argv.includes("rev-list") ? "1\n" : argv.includes("rev-parse") ? `${"a".repeat(40)}\n` : "";
      return { code: 0, stdout: out, stderr: "", timedOut: false };
    };
    const g = new GitCli(runner);
    const sha = "a".repeat(40);
    await g.revParse("/w", "HEAD");
    await g.commonDir("/w");
    await g.gitDir("/w");
    await g.changedPaths("/w", sha, sha);
    await g.addedLines("/w", sha, sha);
    await g.commitsAhead("/w", sha, sha);
    await g.historyChanges("/w", sha, sha);
    await g.push("/w", "furoyce/wm-jrf-1", sha);
    await g.lsRemoteSha("/w", "furoyce/wm-jrf-1");
    expect(seen.length).toBeGreaterThanOrEqual(9);
    expect(seen.some((s) => s.argv.includes("push"))).toBe(true);
    for (const { argv, env } of seen) {
      const config = Object.fromEntries(
        Array.from({ length: Number(env.GIT_CONFIG_COUNT ?? 0) }, (_, i) => [
          env[`GIT_CONFIG_KEY_${i}`],
          env[`GIT_CONFIG_VALUE_${i}`],
        ]),
      );
      expect([argv[3], config]).toEqual([
        argv[3],
        { "core.hooksPath": "/dev/null", "core.fsmonitor": "false" },
      ]);
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    }
  });
  test("lsRemoteSha reads the exact refs/heads/<branch> line (a prefix match of another branch is ignored)", async () => {
    const out =
      "1111111111111111111111111111111111111111\trefs/heads/team/wm-jrf-1\n2222222222222222222222222222222222222222\trefs/heads/wm-jrf-1\n";
    const runner: Runner = async () => ({ code: 0, stdout: out, stderr: "", timedOut: false });
    expect(await new GitCli(runner).lsRemoteSha("/w", "wm-jrf-1")).toBe(
      "2222222222222222222222222222222222222222",
    );
    const none: Runner = async () => ({ code: 0, stdout: "", stderr: "", timedOut: false });
    expect(await new GitCli(none).lsRemoteSha("/w", "wm-jrf-1")).toBeNull();
  });
});

describe("GhCli", () => {
  const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false });
  const args = { head: "wm-jrf-1", base: "main", title: "JRF-1: t", body: "b", draft: false };
  test("an open PR for the head is reused; no gh pr create follows", async () => {
    const calls: string[][] = [];
    const runner: Runner = async (argv) => {
      calls.push(argv);
      return ok(JSON.stringify([{ number: 7, url: "https://github.com/furoyce/bouncr.lol/pull/7" }]));
    };
    expect(await new GhCli(runner).prCreate("/w", args)).toEqual({
      number: 7,
      url: "https://github.com/furoyce/bouncr.lol/pull/7",
    });
    expect(calls.map((c) => c.slice(0, 3).join(" "))).toEqual(["gh pr list"]);
  });
  test("an empty list is followed by gh pr create; its URL is parsed into { number, url }", async () => {
    const calls: string[][] = [];
    const runner: Runner = async (argv) => {
      calls.push(argv);
      return argv[2] === "list"
        ? ok("[]")
        : ok("Creating pull request\nhttps://github.com/furoyce/bouncr.lol/pull/12\n");
    };
    expect(await new GhCli(runner).prCreate("/w", { ...args, draft: true })).toEqual({
      number: 12,
      url: "https://github.com/furoyce/bouncr.lol/pull/12",
    });
    const create = calls[1] ?? [];
    expect(create.slice(0, 3)).toEqual(["gh", "pr", "create"]);
    expect(create).toContain("--draft");
    expect(create).toContain("--body-file");
    expect(create).not.toContain("--web");
  });
  test("a create without a PR URL in its output is an error", async () => {
    const runner: Runner = async (argv) => ok(argv[2] === "list" ? "[]" : "done\n");
    await expect(new GhCli(runner).prCreate("/w", args)).rejects.toThrow(/no PR url/);
  });
  test("F2 (D14): gh runs in the worktree with hooks and fsmonitor off for the git processes it starts there", async () => {
    const envs: Record<string, string>[] = [];
    const runner: Runner = async (argv, opts) => {
      envs.push(opts?.env ?? {});
      if (argv[2] === "list") return ok("[]");
      if (argv[2] === "view")
        return ok(
          JSON.stringify({ state: "OPEN", headRefName: "wm-jrf-1", url: "https://github.com/a/b/pull/3" }),
        );
      return ok("https://github.com/furoyce/bouncr.lol/pull/12\n");
    };
    const gh = new GhCli(runner);
    await gh.prCreate("/w", args);
    await gh.prView("/w", 3);
    expect(envs).toHaveLength(3);
    for (const env of envs)
      expect(env).toMatchObject({
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: "/dev/null",
        GIT_CONFIG_KEY_1: "core.fsmonitor",
        GIT_CONFIG_VALUE_1: "false",
      });
  });
  test("prView is Zod-parsed", async () => {
    const runner: Runner = async () =>
      ok(JSON.stringify({ state: "MERGED", headRefName: "wm-jrf-1", url: "https://github.com/a/b/pull/3" }));
    expect((await new GhCli(runner).prView("/w", 3)).state).toBe("MERGED");
    const bad: Runner = async () => ok(JSON.stringify({ state: 1 }));
    await expect(new GhCli(bad).prView("/w", 3)).rejects.toThrow();
  });
});
