// tests/unit/machine/base.test.ts — C30 (Ruling R29): the claim's base is GitHub's. Real temp repositories whose origin/main lives
// only in packed-refs (which an agent's sandbox may rewrite), GitHub as a local bare repository reached through the repository's own
// url.<…>.insteadOf (so a fetch needs no network), and an injected `git ls-remote` answering for GitHub; every other git command is real.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitCli } from "../../../src/git/cli";
import { verifyBase } from "../../../src/machine/claim";
import type { GitTarget } from "../../../src/ports";
import { run } from "../../../src/shared/exec";

const HERMETIC = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const ID = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"];
/** `https://github.com/<repos.api.github>.git`, the URL every remote read and fetch goes to (C23). */
const URL = "https://github.com/furoyce/bouncr.lol.git";
const REPO = { github: "furoyce/bouncr.lol", base: "origin/main" };

async function git(args: string[]): Promise<string> {
  const r = await run(["git", ...args], { env: HERMETIC });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
const pinned = (t: GitTarget) => ["git", "-C", t.path, `--git-dir=${t.gitDir}`, `--work-tree=${t.path}`];

/** The repository a claim finds: a main checkout at commit R whose origin/main is R in packed-refs only, a linked worktree, GitHub at R. */
async function repos() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wm-base-")));
  const main = join(root, "main");
  await git(["init", "-q", "-b", "main", main]);
  await git(["-C", main, ...ID, "commit", "-q", "--allow-empty", "-m", "A"]);
  await git(["-C", main, ...ID, "commit", "-q", "--allow-empty", "-m", "R"]);
  const r = await git(["-C", main, "rev-parse", "HEAD"]);
  const gh = join(root, "gh.git");
  await git(["clone", "-q", "--bare", main, gh]);
  await git(["-C", main, "config", `url.${gh}.insteadOf`, URL]);
  await git(["-C", main, "update-ref", "refs/remotes/origin/main", r]);
  await git(["-C", main, "pack-refs", "--all"]); // as after gc: no loose ref under refs/remotes/
  const wt = join(root, "wt", "wm-jrf-9");
  await git(["-C", main, "worktree", "add", "-q", "-b", "furoyce/wm-jrf-9", wt, "main"]);
  const common = join(main, ".git");
  const t: GitTarget = { path: wt, gitDir: join(common, "worktrees", "wm-jrf-9"), commonDir: common };
  /** GitHub's main moves one commit ahead (a PR merged there); this clone does not have that commit. */
  const ahead = async (): Promise<string> => {
    const scratch = join(root, "scratch");
    await git(["clone", "-q", gh, scratch]);
    await git(["-C", scratch, ...ID, "commit", "-q", "--allow-empty", "-m", "merged on GitHub"]);
    await git(["-C", scratch, "push", "-q", "origin", "main"]);
    return git(["--git-dir", gh, "rev-parse", "main"]);
  };
  /** packed-refs rewritten by hand, as an agent's sandbox may: origin/main now names `sha`. */
  const plant = (sha: string) => {
    const file = join(common, "packed-refs");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        /^[0-9a-f]{40} refs\/remotes\/origin\/main$/m,
        `${sha} refs/remotes/origin/main`,
      ),
    );
  };
  return { root, main, gh, r, t, ahead, plant };
}

/** Real git, except `ls-remote`, which answers as GitHub would for its main (`tip`; empty when the branch is not there). */
function cli(tip: () => string) {
  const seen: string[][] = [];
  const git = new GitCli(async (argv, opts) => {
    seen.push(argv);
    if (argv.includes("ls-remote")) {
      const sha = tip();
      return {
        code: 0,
        stdout: sha ? `${sha}\trefs/heads/main\n` : "",
        stderr: "",
        timedOut: false,
        truncated: false,
      };
    }
    return run(argv, { ...opts, env: { ...opts?.env, ...HERMETIC } });
  });
  return { git, seen, fetches: () => seen.filter((a) => a.includes("fetch")) };
}

describe("C30: verifyBase — the claim's base is GitHub's (Ruling R29)", () => {
  test("origin/main naming GitHub's main is verified: ls-remote of the configured URL for refs/heads/main, nothing fetched", async () => {
    const { r, t } = await repos();
    const c = cli(() => r);
    expect(await verifyBase(c.git, t, REPO)).toEqual({ ok: true, sha: r, fetched: false });
    expect(c.seen.filter((a) => a.includes("ls-remote"))).toEqual([
      [...pinned(t), "ls-remote", "--heads", URL, "main"],
    ]);
    expect(c.fetches()).toEqual([]);
  });

  test("packed-refs rewritten to an agent's commit (no loose ref to shadow it) is base_mismatch, naming both commits by 12 characters only", async () => {
    const { r, t, plant } = await repos();
    await git(["-C", t.path, ...ID, "commit", "-q", "--allow-empty", "-m", "agent"]);
    const agent = await git(["-C", t.path, "rev-parse", "HEAD"]);
    plant(agent);
    expect(await git(["-C", t.path, "rev-parse", "refs/remotes/origin/main"])).toBe(agent); // the poisoned base git now reads
    const v = await verifyBase(cli(() => r).git, t, REPO);
    expect(v).toMatchObject({ ok: false, remote: r, local: agent, fetched: false });
    const detail = v.ok ? "" : v.detail;
    expect(detail).toContain("refs/remotes/origin/main");
    expect(detail).toContain(agent.slice(0, 12));
    expect(detail).toContain(r.slice(0, 12));
    expect(detail).not.toContain(agent);
    expect(detail).not.toContain(r);
  });

  test("GitHub ahead of this clone: its commit is fetched from the configured URL first (no ref moves); origin/main is still behind, so the base mismatches", async () => {
    const { main, r, t, ahead } = await repos();
    const tip = await ahead();
    const refs = await git(["-C", main, "for-each-ref"]);
    const c = cli(() => tip);
    expect(await verifyBase(c.git, t, REPO)).toMatchObject({
      ok: false,
      remote: tip,
      local: r,
      fetched: true,
    });
    expect(c.fetches()).toEqual([
      [
        ...pinned(t),
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-auto-maintenance",
        "--no-recurse-submodules",
        URL,
        tip,
      ],
    ]);
    expect(await git(["-C", main, "cat-file", "-t", tip])).toBe("commit");
    expect(await git(["-C", main, "for-each-ref"])).toBe(refs);
  });

  test("origin/main naming GitHub's commit that this clone lacks is fetched, then verified: the fetch comes before the comparison", async () => {
    const { t, ahead, plant } = await repos();
    const tip = await ahead();
    plant(tip); // the ref says GitHub's commit, but its object is not here yet
    const c = cli(() => tip);
    expect(await verifyBase(c.git, t, REPO)).toEqual({ ok: true, sha: tip, fetched: true });
    expect(c.fetches()).toHaveLength(1);
  });

  test("the base branch missing on GitHub, or origin/main missing here, is base_mismatch too (fail closed)", async () => {
    const { main, r, t } = await repos();
    const none = cli(() => "");
    const gone = await verifyBase(none.git, t, REPO);
    expect(gone).toMatchObject({ ok: false, remote: null, fetched: false });
    expect(gone.ok ? "" : gone.detail).toContain("furoyce/bouncr.lol");
    expect(none.fetches()).toEqual([]);
    await git(["-C", main, "update-ref", "-d", "refs/remotes/origin/main"]);
    const missing = await verifyBase(cli(() => r).git, t, REPO);
    expect(missing).toMatchObject({ ok: false, remote: r, local: null });
    expect(missing.ok ? "" : missing.detail).toContain("does not resolve");
  });
});
