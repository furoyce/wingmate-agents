// tests/unit/git/cli.test.ts — GitCli against a real temp repository; GhCli against an injected runner (no network)
import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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
  test("prView is Zod-parsed", async () => {
    const runner: Runner = async () =>
      ok(JSON.stringify({ state: "MERGED", headRefName: "wm-jrf-1", url: "https://github.com/a/b/pull/3" }));
    expect((await new GhCli(runner).prView("/w", 3)).state).toBe("MERGED");
    const bad: Runner = async () => ok(JSON.stringify({ state: 1 }));
    await expect(new GhCli(bad).prView("/w", 3)).rejects.toThrow();
  });
});
