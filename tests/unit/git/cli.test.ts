// tests/unit/git/cli.test.ts — GitCli against a real temp repository; GhCli against an injected runner (no network)
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { GhCli } from "../../../src/gh/cli";
import { GitCli, type Runner } from "../../../src/git/cli";
import { qualifiedBase } from "../../../src/git/refname";
import type { GitTarget } from "../../../src/ports";
import { type RunResult, run } from "../../../src/shared/exec";

const HERMETIC = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
/** The configured GitHub URL of the bouncr api repo (`https://github.com/<repos.<name>.github>.git`, C23). */
const URL = "https://github.com/furoyce/bouncr.lol.git";
const ok = (stdout: string): RunResult => ({
  code: 0,
  stdout,
  stderr: "",
  timedOut: false,
  truncated: false,
});
const pinned = (t: GitTarget) => ["git", "-C", t.path, `--git-dir=${t.gitDir}`, `--work-tree=${t.path}`];
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
/** The same repository with `feature` checked out in a linked worktree, as Orca makes them, and that worktree's git target (C22). */
async function linkedTarget(): Promise<{ dir: string; base: string; t: GitTarget }> {
  const { dir, base } = await repo();
  await git(["-C", dir, "switch", "-q", "main"]);
  const wt = join(realpathSync(mkdtempSync(join(tmpdir(), "wm-gitcli-wt-"))), "wm-jrf-9");
  await git(["-C", dir, "worktree", "add", "-q", wt, "feature"]);
  return {
    dir,
    base,
    t: { path: wt, gitDir: join(dir, ".git", "worktrees", "wm-jrf-9"), commonDir: join(dir, ".git") },
  };
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
      return {
        code: 128,
        stdout: "",
        stderr: "fatal: not a git repository",
        timedOut: false,
        truncated: false,
      };
    };
    await expect(new GitCli(runner).revParse("/nowhere", "HEAD")).rejects.toThrow(/rev-parse failed \(128\)/);
    expect(seen[0]?.argv.slice(0, 3)).toEqual(["git", "-C", "/nowhere"]);
    expect(seen[0]?.env?.GIT_TERMINAL_PROMPT).toBe("0");
  });
  test("C23: push sends exactly the verified commit to refs/heads/<branch> of the configured URL — after checking that origin names that repository — with -u, never forced; branch and sha are checked first", async () => {
    const { t } = await linkedTarget();
    const calls: { argv: string[]; env: Record<string, string> }[] = [];
    let origin: string | null = URL;
    const runner: Runner = async (argv, opts) => {
      calls.push({ argv, env: opts?.env ?? {} });
      if (!argv.includes("config")) return ok("");
      return origin === null ? { ...ok(""), code: 1 } : ok(`${origin}\n`);
    };
    const g = new GitCli(runner);
    const sha = "a".repeat(40);
    await g.push(t, URL, "furoyce/wm-jrf-1", sha);
    expect(calls.map((c) => c.argv)).toEqual([
      [...pinned(t), "config", "--get", "remote.origin.url"],
      [...pinned(t), "push", "--porcelain", "-u", URL, `${sha}:refs/heads/furoyce/wm-jrf-1`],
    ]);
    expect(calls.map((c) => c.env.GIT_COMMON_DIR)).toEqual([t.commonDir, t.commonDir]);
    // origin naming the same repository another way is the same remote; the push still goes to the configured URL
    for (const same of [
      "git@github.com:furoyce/bouncr.lol.git",
      "https://github.com/Furoyce/bouncr.lol",
      "ssh://git@github.com/furoyce/bouncr.lol.git",
    ]) {
      origin = same;
      calls.length = 0;
      await g.push(t, URL, "furoyce/wm-jrf-1", sha);
      expect(calls.at(-1)?.argv).toEqual([
        ...pinned(t),
        "push",
        "--porcelain",
        "-u",
        URL,
        `${sha}:refs/heads/furoyce/wm-jrf-1`,
      ]);
    }
    // another repository, another host, or no origin at all: refused before anything is pushed
    for (const other of [
      "https://github.com/someone/else.git",
      "https://evil.example/furoyce/bouncr.lol.git",
      "git@github.com:furoyce/bouncr.lol.evil.git",
      "",
      null,
    ]) {
      origin = other;
      calls.length = 0;
      await expect(g.push(t, URL, "furoyce/wm-jrf-1", sha)).rejects.toMatchObject({
        code: "remote_mismatch",
      });
      expect(calls.some((c) => c.argv.includes("push"))).toBe(false);
    }
    origin = URL;
    calls.length = 0;
    await expect(g.push(t, "--upload-pack=x", "furoyce/wm-jrf-1", sha)).rejects.toMatchObject({
      code: "remote_mismatch",
    });
    for (const branch of ["--upload-pack=x", "+main", "main:other", "a..b", ""])
      await expect(g.push(t, URL, branch, sha)).rejects.toMatchObject({ code: "branch_invalid" });
    for (const bad of ["HEAD", `+${sha}`, `${sha}:refs/heads/main`, "abc"])
      await expect(g.push(t, URL, "furoyce/wm-jrf-1", bad)).rejects.toMatchObject({ code: "sha_invalid" });
    await expect(g.lsRemoteSha(t, URL, "--upload-pack=x")).rejects.toMatchObject({ code: "branch_invalid" });
    expect(calls.some((c) => c.argv.includes("push"))).toBe(false);
  });
  test("C22: with a worktree target every git read runs pinned (--git-dir, --work-tree, GIT_COMMON_DIR as recorded), and every log read checks no signature", async () => {
    const { t } = await linkedTarget();
    const seen: { argv: string[]; env: Record<string, string> }[] = [];
    const runner: Runner = async (argv, opts) => {
      seen.push({ argv, env: opts?.env ?? {} });
      return ok(argv.includes("rev-list") ? "1\n" : argv.includes("rev-parse") ? `${"a".repeat(40)}\n` : "");
    };
    const g = new GitCli(runner);
    const sha = "a".repeat(40);
    await g.revParse(t, "HEAD");
    await g.changedPaths(t, sha, sha);
    await g.addedLines(t, sha, sha);
    await g.commitsAhead(t, sha, sha);
    await g.historyChanges(t, sha, sha, null);
    expect(seen.length).toBeGreaterThanOrEqual(7);
    for (const { argv, env } of seen) {
      expect(argv.slice(0, 5)).toEqual(pinned(t));
      expect(env).toMatchObject({
        GIT_COMMON_DIR: t.commonDir,
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: "/dev/null",
        GIT_CONFIG_KEY_1: "core.fsmonitor",
        GIT_CONFIG_VALUE_1: "false",
      });
    }
    const logs = seen.map((s) => s.argv).filter((a) => a.includes("log"));
    expect(logs).toHaveLength(3);
    for (const a of logs)
      expect(a.slice(a.indexOf("log") - 2, a.indexOf("log"))).toEqual(["-c", "log.showSignature=false"]);
  });
  test("C22: a tampered commondir or gitfile refuses (git_dir_tampered) before any git process starts", async () => {
    const { t } = await linkedTarget();
    let calls = 0;
    const runner: Runner = async () => {
      calls += 1;
      return ok(`${URL}\n`);
    };
    const g = new GitCli(runner);
    const sha = "a".repeat(40);
    const fake = realpathSync(mkdtempSync(join(tmpdir(), "wm-gitcli-fake-")));
    writeFileSync(join(t.gitDir, "commondir"), `${fake}\n`);
    const tampered = { code: "git_dir_tampered" };
    await expect(g.revParse(t, "HEAD")).rejects.toMatchObject(tampered);
    await expect(g.historyChanges(t, sha, sha, null)).rejects.toMatchObject(tampered);
    await expect(g.lsRemoteSha(t, URL, "furoyce/wm-jrf-9")).rejects.toMatchObject(tampered);
    await expect(g.push(t, URL, "furoyce/wm-jrf-9", sha)).rejects.toMatchObject(tampered);
    writeFileSync(join(t.gitDir, "commondir"), "../..\n");
    writeFileSync(join(t.path, ".git"), `gitdir: ${join(fake, "worktrees", "wm-jrf-9")}\n`);
    await expect(g.addedLines(t, sha, sha)).rejects.toMatchObject(tampered);
    expect(calls).toBe(0);
  });
  test("F7: a ref made in another namespace of the shared git dir shadows origin/main for a short-name rev-parse; the qualified base never follows it", async () => {
    const { dir, t } = await linkedTarget();
    const remote = (await git(["-C", dir, "rev-parse", "main"])).trim();
    const agent = (await git(["-C", dir, "rev-parse", "feature"])).trim(); // a commit an agent made
    await git(["-C", dir, "update-ref", "refs/remotes/origin/main", remote]);
    const g = new GitCli();
    expect(await g.revParse(t, "origin/main")).toBe(remote);
    // none of these is denied to an agent's sandbox (only refs/heads/<base>* and refs/remotes/** are)
    for (const shadow of ["refs/tags/origin/main", "refs/heads/origin/main", "refs/origin/main"]) {
      await git(["-C", dir, "update-ref", shadow, agent]);
      expect({ shadow, sha: await g.revParse(t, "origin/main") }).toEqual({ shadow, sha: agent }); // git's disambiguation
      expect({ shadow, sha: await g.revParse(t, qualifiedBase("origin/main")) }).toEqual({
        shadow,
        sha: remote,
      });
      await git(["-C", dir, "update-ref", "-d", shadow]);
    }
    const seen: string[][] = [];
    const runner: Runner = async (argv) => {
      seen.push(argv);
      return ok(`${remote}\n`);
    };
    await new GitCli(runner).revParse(t, "refs/remotes/origin/main");
    expect(seen[0]?.slice(5)).toEqual([
      "rev-parse",
      "--verify",
      "--end-of-options",
      "refs/remotes/origin/main^{commit}",
    ]);
  });
  test("C22: pinned reads in a linked worktree give real git's answers", async () => {
    const { base, t } = await linkedTarget();
    const g = new GitCli();
    const head = await g.revParse(t, "HEAD");
    expect(head).toBe((await git(["-C", t.path, "rev-parse", "HEAD"])).trim());
    expect(await g.changedPaths(t, base, head)).toEqual(["src.ts"]);
    expect(await g.addedLines(t, base, head)).toContainEqual({
      path: "src.ts",
      line: 'token = "sk-ant-api03-xxxx"',
    });
    expect(await g.commitsAhead(t, base, head)).toBe(1);
    const h = await g.historyChanges(t, base, head, null);
    expect(h.paths).toEqual(["src.ts"]);
    expect(h.messages).toContain("feature");
  });
  test("C26: a non-fast-forward rejection is push_rejected, never an infrastructure failure retried each tick; any other failure stays git_failed", async () => {
    const { t } = await linkedTarget();
    const sha = "a".repeat(40);
    const dst = `${sha}:refs/heads/furoyce/wm-jrf-1`;
    let reply: RunResult = ok("");
    const runner: Runner = async (argv) => (argv.includes("config") ? ok(`${URL}\n`) : reply);
    const g = new GitCli(runner);
    const failed = (stdout: string, code = 1): RunResult => ({
      ...ok(stdout),
      code,
      stderr: "error: failed to push some refs",
    });
    for (const why of ["non-fast-forward", "fetch first"]) {
      reply = failed(`To ${URL}\n!\t${dst}\t[rejected] (${why})\nDone\n`);
      await expect(g.push(t, URL, "furoyce/wm-jrf-1", sha)).rejects.toMatchObject({ code: "push_rejected" });
    }
    reply = failed(`To ${URL}\n!\t${dst}\t[remote rejected] (protected branch hook declined)\nDone\n`);
    await expect(g.push(t, URL, "furoyce/wm-jrf-1", sha)).rejects.toMatchObject({ code: "git_failed" });
    reply = failed("", 128);
    await expect(g.push(t, URL, "furoyce/wm-jrf-1", sha)).rejects.toMatchObject({ code: "git_failed" });
  });
  test("C26: the history read starts at the remote branch tip when this worktree has it, so commits pushed earlier are not read again", async () => {
    const { dir, base } = await repo();
    const g = new GitCli();
    const pushed = await g.revParse(dir, "HEAD"); // origin's branch: what an earlier cycle published
    writeFileSync(join(dir, "b.ts"), "export const b = 2;\n");
    await git(["-C", dir, "add", "b.ts"]);
    await git(["-C", dir, ...ID, "commit", "-q", "-m", "later"]);
    const head = await g.revParse(dir, "HEAD");
    const h = await g.historyChanges(dir, base, head, pushed);
    expect(h.paths).toEqual(["b.ts"]);
    expect(h.added).toEqual([{ path: "b.ts", line: "export const b = 2;" }]);
    expect(h.messages).toContain("later");
    expect(h.messages).not.toContain("feature");
    // a tip this worktree does not have (pushed from elsewhere), anything but an object name, or none: the branch since its base
    for (const since of ["b".repeat(40), "--output=/tmp/wm-x", null]) {
      const all = await g.historyChanges(dir, base, head, since);
      expect({ since, paths: [...all.paths].sort() }).toEqual({ since, paths: ["b.ts", "src.ts"] });
    }
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
    const { t } = await linkedTarget();
    const seen: { argv: string[]; env: Record<string, string> }[] = [];
    const runner: Runner = async (argv, opts) => {
      seen.push({ argv, env: opts?.env ?? {} });
      const out = argv.includes("rev-list")
        ? "1\n"
        : argv.includes("rev-parse")
          ? `${"a".repeat(40)}\n`
          : argv.includes("config")
            ? `${URL}\n`
            : "";
      return { code: 0, stdout: out, stderr: "", timedOut: false, truncated: false };
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
    await g.push(t, URL, "furoyce/wm-jrf-1", sha);
    await g.lsRemoteSha(t, URL, "furoyce/wm-jrf-1");
    await g.fetchCommit(t, URL, sha);
    expect(seen.length).toBeGreaterThanOrEqual(11);
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
  test("C24: a committed or an untracked `.gitattributes` '* -diff' hides no added line, net or in the history (--text --no-textconv)", async () => {
    const neon = 'const url = "postgresql://app:S3cret@ep-cool-sound-123456.us-east-2.aws.neon.tech/neondb";';
    const { dir, base } = await repo();
    writeFileSync(join(dir, ".gitattributes"), "* -diff\n");
    writeFileSync(join(dir, "db.ts"), `${neon}\n`);
    await git(["-C", dir, "add", ".gitattributes", "db.ts"]);
    await git(["-C", dir, ...ID, "commit", "-q", "-m", "attrs"]);
    const g = new GitCli();
    const head = await g.revParse(dir, "HEAD");
    expect(await g.addedLines(dir, base, head)).toContainEqual({ path: "db.ts", line: neon });
    expect((await g.historyChanges(dir, base, head)).added).toContainEqual({ path: "db.ts", line: neon });
    // an untracked one: the work tree's attributes apply to a diff of two commits too
    const u = await repo();
    writeFileSync(join(u.dir, ".gitattributes"), "*.ts -diff\n");
    const token = { path: "src.ts", line: 'token = "sk-ant-api03-xxxx"' };
    expect(await g.addedLines(u.dir, u.base)).toContainEqual(token);
    expect((await g.historyChanges(u.dir, u.base, "HEAD")).added).toContainEqual(token);
  });
  test("C24: a symlink replaced by a regular file (a type change) is a changed path and its lines are added lines, net and in the history", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "wm-gitcli-t-")));
    await git(["init", "-q", "-b", "main", dir]);
    writeFileSync(join(dir, "a.txt"), "one\n");
    symlinkSync("a.txt", join(dir, "link"));
    await git(["-C", dir, "add", "-A"]);
    await git(["-C", dir, ...ID, "commit", "-q", "-m", "init"]);
    const base = (await git(["-C", dir, "rev-parse", "HEAD"])).trim();
    await git(["-C", dir, "switch", "-q", "-c", "feature"]);
    rmSync(join(dir, "link"));
    writeFileSync(join(dir, "link"), "AWS_KEY=AKIAIOSFODNN7EXAMPLE\n");
    await git(["-C", dir, "add", "-A"]);
    await git(["-C", dir, ...ID, "commit", "-q", "-m", "typechange"]);
    const g = new GitCli();
    const head = await g.revParse(dir, "HEAD");
    const line = { path: "link", line: "AWS_KEY=AKIAIOSFODNN7EXAMPLE" };
    expect(await g.changedPaths(dir, base, head)).toEqual(["link"]);
    expect(await g.addedLines(dir, base, head)).toContainEqual(line);
    const h = await g.historyChanges(dir, base, head);
    expect(h.paths).toEqual(["link"]);
    expect(h.added).toContainEqual(line);
  });
  test("C24: every guard diff and log read passes --text --no-textconv --no-ext-diff, and every --diff-filter includes T", async () => {
    const seen: string[][] = [];
    const runner: Runner = async (argv) => {
      seen.push(argv);
      return { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
    };
    const g = new GitCli(runner);
    const sha = "a".repeat(40);
    await g.changedPaths("/w", sha, sha);
    await g.addedLines("/w", sha, sha);
    await g.historyChanges("/w", sha, sha);
    const reads = seen.filter((a) => (a.includes("diff") || a.includes("log")) && !a.includes("--format=%B"));
    expect(reads).toHaveLength(4);
    for (const a of reads) {
      expect(a).toEqual(expect.arrayContaining(["--text", "--no-textconv", "--no-ext-diff"]));
      const filter = a.find((x) => x.startsWith("--diff-filter=")) ?? "";
      expect(filter).toContain("T");
    }
  });
  test("C25: a guard read cut at the 8 MiB capture cap is diff_too_large, never a partial diff", async () => {
    const sha = "a".repeat(40);
    const cut: Runner = async () => ({
      code: 0,
      stdout: "diff --git a/x b/x\n+++ b/x\n@@ -0,0 +1 @@\n+partial",
      stderr: "",
      timedOut: false,
      truncated: true,
    });
    const g = new GitCli(cut);
    await expect(g.changedPaths("/w", sha, sha)).rejects.toMatchObject({ code: "diff_too_large" });
    await expect(g.addedLines("/w", sha, sha)).rejects.toMatchObject({ code: "diff_too_large" });
    await expect(g.historyChanges("/w", sha, sha)).rejects.toMatchObject({ code: "diff_too_large" });
  });
  test("lsRemoteSha reads the exact refs/heads/<branch> line of the configured URL (a prefix match of another branch, or no object name, is ignored)", async () => {
    const { t } = await linkedTarget();
    const out =
      "1111111111111111111111111111111111111111\trefs/heads/team/wm-jrf-1\n2222222222222222222222222222222222222222\trefs/heads/wm-jrf-1\n";
    const calls: string[][] = [];
    const runner: Runner = async (argv) => {
      calls.push(argv);
      return ok(out);
    };
    expect(await new GitCli(runner).lsRemoteSha(t, URL, "wm-jrf-1")).toBe(
      "2222222222222222222222222222222222222222",
    );
    expect(calls).toEqual([[...pinned(t), "ls-remote", "--heads", URL, "wm-jrf-1"]]); // C23: the URL, never the name origin
    const none: Runner = async () => ok("");
    expect(await new GitCli(none).lsRemoteSha(t, URL, "wm-jrf-1")).toBeNull();
    const odd: Runner = async () => ok("--output=/tmp/x\trefs/heads/wm-jrf-1\n");
    expect(await new GitCli(odd).lsRemoteSha(t, URL, "wm-jrf-1")).toBeNull();
  });
  test("C30: fetchCommit fetches exactly the missing commit from the configured URL — no ref, no FETCH_HEAD, no tags, no submodules, no maintenance — and nothing when the commit is here", async () => {
    const { t } = await linkedTarget();
    const sha = "c".repeat(40);
    const calls: { argv: string[]; env: Record<string, string> }[] = [];
    let present = false;
    const runner: Runner = async (argv, opts) => {
      calls.push({ argv, env: opts?.env ?? {} });
      if (argv.includes("fetch")) present = true;
      if (argv.includes("rev-parse")) return present ? ok(`${sha}\n`) : { ...ok(""), code: 1 };
      return ok("");
    };
    const g = new GitCli(runner);
    expect(await g.fetchCommit(t, URL, sha)).toBe(true);
    expect(calls.map((c) => c.argv)).toEqual([
      [...pinned(t), "rev-parse", "--verify", "--quiet", `${sha}^{commit}`],
      [
        ...pinned(t),
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-auto-maintenance",
        "--no-recurse-submodules",
        URL,
        sha,
      ],
      [...pinned(t), "rev-parse", "--verify", "--quiet", `${sha}^{commit}`],
    ]);
    expect(calls.map((c) => c.env.GIT_COMMON_DIR)).toEqual([t.commonDir, t.commonDir, t.commonDir]);
    calls.length = 0;
    expect(await g.fetchCommit(t, URL, sha)).toBe(false); // here now: nothing is fetched
    expect(calls.map((c) => c.argv[5])).toEqual(["rev-parse"]);
  });
  test("C30: fetchCommit refuses a non-object name or a non-GitHub URL before any git process, and a commit still missing after the fetch", async () => {
    const { t } = await linkedTarget();
    let calls = 0;
    const missing: Runner = async (argv) => {
      calls += 1;
      return argv.includes("rev-parse") ? { ...ok(""), code: 1 } : ok("");
    };
    const g = new GitCli(missing);
    for (const bad of ["main", "--upload-pack=x", `+${"c".repeat(40)}`, "c".repeat(39)])
      await expect(g.fetchCommit(t, URL, bad)).rejects.toMatchObject({ code: "sha_invalid" });
    await expect(g.fetchCommit(t, "--upload-pack=x", "c".repeat(40))).rejects.toMatchObject({
      code: "remote_mismatch",
    });
    expect(calls).toBe(0);
    await expect(g.fetchCommit(t, URL, "c".repeat(40))).rejects.toMatchObject({ code: "git_failed" });
  });
  test("C30: fetchCommit against real git — the commit lands in the shared object store, no ref moves and no FETCH_HEAD is written", async () => {
    const { dir, t } = await linkedTarget();
    // the "GitHub" side: a bare repository one commit ahead, reached through the repository's own url.<…>.insteadOf (no network)
    const remote = join(realpathSync(mkdtempSync(join(tmpdir(), "wm-gitcli-gh-"))), "gh.git");
    await git(["clone", "-q", "--bare", dir, remote]);
    const scratch = join(realpathSync(mkdtempSync(join(tmpdir(), "wm-gitcli-clone-"))), "c");
    await git(["clone", "-q", remote, scratch]);
    await git(["-C", scratch, ...ID, "commit", "-q", "--allow-empty", "-m", "on GitHub only"]);
    await git(["-C", scratch, "push", "-q", "origin", "main"]);
    const tip = (await git(["--git-dir", remote, "rev-parse", "main"])).trim();
    await git(["-C", dir, "config", `url.${remote}.insteadOf`, URL]);
    const refsBefore = await git(["-C", dir, "for-each-ref"]);
    const hermetic: Runner = (argv, opts) => run(argv, { ...opts, env: { ...opts?.env, ...HERMETIC } });
    const g = new GitCli(hermetic);
    expect(await g.fetchCommit(t, URL, tip)).toBe(true);
    expect((await git(["-C", dir, "cat-file", "-t", tip])).trim()).toBe("commit");
    expect(await git(["-C", dir, "for-each-ref"])).toBe(refsBefore);
    for (const d of [t.gitDir, t.commonDir])
      expect(await Bun.file(join(d, "FETCH_HEAD")).exists()).toBe(false);
    expect(await g.fetchCommit(t, URL, tip)).toBe(false);
  });
});

describe("GhCli", () => {
  /** `repos.<name>.github` of the bouncr api repo (C29: every gh call names it). */
  const REPO = "furoyce/bouncr.lol";
  const args = { head: "wm-jrf-1", base: "main", title: "JRF-1: t", body: "b", draft: false };
  test("an open PR for the head is reused; no gh pr create follows", async () => {
    const calls: string[][] = [];
    const runner: Runner = async (argv) => {
      calls.push(argv);
      return ok(JSON.stringify([{ number: 7, url: "https://github.com/furoyce/bouncr.lol/pull/7" }]));
    };
    expect(await new GhCli(runner).prCreate(REPO, args)).toEqual({
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
    expect(await new GhCli(runner).prCreate(REPO, { ...args, draft: true })).toEqual({
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
    await expect(new GhCli(runner).prCreate(REPO, args)).rejects.toThrow(/no PR url/);
  });
  test("F2 (D14): the git processes gh starts run no hook and no fsmonitor", async () => {
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
    await gh.prCreate(REPO, args);
    await gh.prView(REPO, 3);
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
  test("C29: every gh call names the configured repository (--repo <owner/name>) and runs outside any worktree, so gh never resolves the repository (or runs git) through a worktree's links", async () => {
    const calls: { argv: string[]; cwd: string | undefined }[] = [];
    const runner: Runner = async (argv, opts) => {
      calls.push({ argv, cwd: opts?.cwd });
      if (argv[2] === "list") return ok("[]");
      if (argv[2] === "view")
        return ok(
          JSON.stringify({ state: "OPEN", headRefName: "wm-jrf-1", url: "https://github.com/a/b/pull/3" }),
        );
      return ok("https://github.com/furoyce/bouncr.lol/pull/12\n");
    };
    const gh = new GhCli(runner);
    await gh.prCreate(REPO, { ...args, draft: true });
    await gh.prView(REPO, 3);
    const bodyFile = calls[1]?.argv[calls[1].argv.indexOf("--body-file") + 1] ?? "";
    expect(calls.map((c) => c.argv)).toEqual([
      [
        "gh",
        "pr",
        "list",
        "--repo",
        REPO,
        "--head",
        "wm-jrf-1",
        "--state",
        "open",
        "--json",
        "number,url",
        "--limit",
        "1",
      ],
      [
        "gh",
        "pr",
        "create",
        "--repo",
        REPO,
        "--head",
        "wm-jrf-1",
        "--base",
        "main",
        "--title",
        "JRF-1: t",
        "--body-file",
        bodyFile,
        "--draft",
      ],
      ["gh", "pr", "view", "3", "--repo", REPO, "--json", "state,headRefName,url"],
    ]);
    // `/`: no repository there for gh's own git calls (remotes, status) to find, and no agent can write one there
    expect(calls.map((c) => c.cwd)).toEqual(["/", "/", "/"]);
  });
  test("C29: a repository that is not owner/name (an option, a path, a URL, empty) is refused before gh starts", async () => {
    let calls = 0;
    const runner: Runner = async () => {
      calls += 1;
      return ok("[]");
    };
    const gh = new GhCli(runner);
    for (const bad of ["--repo=x/y", "-R", "a/b/c", "https://github.com/a/b", "", "a", "/w", "-x/y"]) {
      await expect(gh.prCreate(bad, args)).rejects.toMatchObject({ code: "gh_repo_invalid" });
      await expect(gh.prView(bad, 3)).rejects.toMatchObject({ code: "gh_repo_invalid" });
    }
    expect(calls).toBe(0);
  });
  test("prView is Zod-parsed", async () => {
    const runner: Runner = async () =>
      ok(JSON.stringify({ state: "MERGED", headRefName: "wm-jrf-1", url: "https://github.com/a/b/pull/3" }));
    expect((await new GhCli(runner).prView(REPO, 3)).state).toBe("MERGED");
    const bad: Runner = async () => ok(JSON.stringify({ state: 1 }));
    await expect(new GhCli(bad).prView(REPO, 3)).rejects.toThrow();
  });
});
