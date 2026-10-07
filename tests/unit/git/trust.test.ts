// tests/unit/git/trust.test.ts — C22 (§13.3 d): the issue worktree's gitfile and commondir, checked against real linked worktrees
import { describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverGitLinks, gitTarget, mainCheckoutTarget, verifyGitLinks } from "../../../src/git/trust";
import { run } from "../../../src/shared/exec";

const HERMETIC = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
async function git(args: string[]): Promise<string> {
  const r = await run(["git", ...args], { env: HERMETIC });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
/** A main checkout with one commit and two linked worktrees, as Orca makes them (`git worktree add`). */
async function linked() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wm-trust-")));
  const main = join(root, "main");
  await git(["init", "-q", "-b", "main", main]);
  await git([
    "-C",
    main,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@e",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "i",
  ]);
  const wt = join(root, "wt", "wm-jrf-1");
  const other = join(root, "wt", "wm-jrf-2");
  await git(["-C", main, "worktree", "add", "-q", "-b", "furoyce/wm-jrf-1", wt, "main"]);
  await git(["-C", main, "worktree", "add", "-q", "-b", "furoyce/wm-jrf-2", other, "main"]);
  const common = join(main, ".git");
  return { root, main, common, wt, other, gitDir: join(common, "worktrees", "wm-jrf-1") };
}
/** A git dir the agent could make in $TMPDIR, laid out like a linked worktree's (`<fake>/worktrees/<name>`, commondir `../..`). */
function forged(root: string): string {
  const fake = join(root, "fake");
  mkdirSync(join(fake, "worktrees", "wm-jrf-1"), { recursive: true });
  writeFileSync(join(fake, "config"), '[core]\n\tsshCommand = "touch /tmp/wm-pwned"\n');
  writeFileSync(join(fake, "worktrees", "wm-jrf-1", "commondir"), "../..\n");
  writeFileSync(join(fake, "worktrees", "wm-jrf-1", "HEAD"), "ref: refs/heads/furoyce/wm-jrf-1\n");
  return fake;
}
const tampered = { code: "git_dir_tampered" };

describe("C22: the worktree's git links (§13.3 d)", () => {
  test("a linked worktree's links name its own gitdir under the common dir: discovered, and verified as the record names them", async () => {
    const l = await linked();
    const t = await discoverGitLinks(l.wt, null);
    expect(t).toEqual({ path: l.wt, gitDir: l.gitDir, commonDir: l.common });
    expect(gitTarget({ path: l.wt, gitCommonDir: l.common, gitdirName: "wm-jrf-1" })).toEqual(t);
    await verifyGitLinks(t);
    // a reused worktree is accepted only with the git dirs an earlier cycle recorded for it
    expect(await discoverGitLinks(l.wt, { gitCommonDir: l.common, gitdirName: "wm-jrf-1" })).toEqual(t);
  });

  test("a tampered gitfile — another worktree's gitdir, a forged git dir, a symlink, no gitfile at all — is git_dir_tampered", async () => {
    const l = await linked();
    const t = gitTarget({ path: l.wt, gitCommonDir: l.common, gitdirName: "wm-jrf-1" });
    const gitfile = join(l.wt, ".git");
    const original = readFileSync(gitfile, "utf8");
    writeFileSync(gitfile, `gitdir: ${join(l.common, "worktrees", "wm-jrf-2")}\n`);
    await expect(verifyGitLinks(t)).rejects.toMatchObject(tampered);
    const fake = forged(l.root);
    writeFileSync(gitfile, `gitdir: ${join(fake, "worktrees", "wm-jrf-1")}\n`);
    await expect(verifyGitLinks(t)).rejects.toMatchObject(tampered);
    // laid out like a linked worktree, but not the git dirs recorded for this worktree (the archive is the anchor)
    await expect(
      discoverGitLinks(l.wt, { gitCommonDir: l.common, gitdirName: "wm-jrf-1" }),
    ).rejects.toMatchObject(tampered);
    rmSync(gitfile);
    writeFileSync(join(l.root, "gitfile"), original);
    symlinkSync(join(l.root, "gitfile"), gitfile); // never followed
    await expect(verifyGitLinks(t)).rejects.toMatchObject(tampered);
    await expect(discoverGitLinks(l.wt, null)).rejects.toMatchObject(tampered);
    rmSync(gitfile);
    await expect(verifyGitLinks(t)).rejects.toMatchObject(tampered);
    writeFileSync(gitfile, original);
    await verifyGitLinks(t);
  });

  test("a tampered commondir — an agent-made common dir, absolute or relative — is git_dir_tampered, also when discovering", async () => {
    const l = await linked();
    const t = gitTarget({ path: l.wt, gitCommonDir: l.common, gitdirName: "wm-jrf-1" });
    const commondir = join(l.gitDir, "commondir");
    const fake = forged(l.root);
    writeFileSync(commondir, `${fake}\n`);
    await expect(verifyGitLinks(t)).rejects.toMatchObject(tampered);
    await expect(discoverGitLinks(l.wt, null)).rejects.toMatchObject(tampered);
    writeFileSync(commondir, "../../../../fake\n");
    await expect(verifyGitLinks(t)).rejects.toMatchObject(tampered);
    // a link that resolves to the right common dir today is still refused: git never writes one, and it can be re-pointed later
    symlinkSync(l.common, join(l.root, "common-link"));
    writeFileSync(commondir, `${join(l.root, "common-link")}\n`);
    await expect(verifyGitLinks(t)).rejects.toMatchObject(tampered);
    writeFileSync(commondir, "../..\n");
    await verifyGitLinks(t);
  });

  test("a refusal names only the worktree and the recorded git dirs, never what the agent-written links say", async () => {
    const l = await linked();
    const t = gitTarget({ path: l.wt, gitCommonDir: l.common, gitdirName: "wm-jrf-1" });
    const marker = "AGENT-WRITTEN-MARKER";
    const planted = join(l.root, marker, "worktrees", "wm-jrf-1");
    mkdirSync(planted, { recursive: true });
    writeFileSync(join(planted, "commondir"), "../..\n");
    const gitfile = join(l.wt, ".git");
    const original = readFileSync(gitfile, "utf8");
    const messages: string[] = [];
    const refused = async (p: Promise<unknown>) => {
      const e = await p.catch((x: unknown) => x);
      expect(e).toMatchObject(tampered);
      messages.push(e instanceof Error ? e.message : String(e));
    };
    for (const body of [`gitdir: ${planted}\n`, `gitdir: /nowhere/${marker}\n`, `${marker}\n`]) {
      writeFileSync(gitfile, body);
      await refused(verifyGitLinks(t));
      await refused(discoverGitLinks(l.wt, { gitCommonDir: l.common, gitdirName: "wm-jrf-1" }));
    }
    writeFileSync(gitfile, original);
    for (const body of [`${join(l.root, marker)}\n`, `../../../${marker}\n`]) {
      writeFileSync(join(l.gitDir, "commondir"), body);
      await refused(verifyGitLinks(t));
      await refused(discoverGitLinks(l.wt, null));
    }
    expect(messages).toHaveLength(10);
    for (const m of messages) expect(m).not.toContain(marker);
  });

  test("the common dir's worktrees/ swapped for a symlink to a copy elsewhere is git_dir_tampered (paths resolve as git resolves them)", async () => {
    const l = await linked();
    const t = gitTarget({ path: l.wt, gitCommonDir: l.common, gitdirName: "wm-jrf-1" });
    const copy = join(l.root, "elsewhere");
    mkdirSync(copy);
    cpSync(join(l.common, "worktrees"), join(copy, "worktrees"), { recursive: true });
    renameSync(join(l.common, "worktrees"), join(l.common, "worktrees.moved"));
    symlinkSync(join(copy, "worktrees"), join(l.common, "worktrees"));
    // lexically every path still reads <common>/worktrees/wm-jrf-1 and ../.., but git lands in the copy and in its parent
    await expect(verifyGitLinks(t)).rejects.toMatchObject(tampered);
    await expect(discoverGitLinks(l.wt, null)).rejects.toMatchObject(tampered);
  });
});

describe("F1/F2: the main checkout as a git target (the claim's base check before any worktree exists)", () => {
  const pinnedRefs = (main: string) =>
    run(["git", "-C", main, `--git-dir=${join(main, ".git")}`, `--work-tree=${main}`, "for-each-ref"], {
      env: { ...HERMETIC, GIT_COMMON_DIR: join(main, ".git") },
    });

  test("a plain clone's .git directory is its git dir and its common dir, and verifies before every command", async () => {
    const l = await linked();
    const t = await mainCheckoutTarget(l.main);
    expect(t).toEqual({ path: l.main, gitDir: l.common, commonDir: l.common });
    await verifyGitLinks(t);
  });

  test("a .git that is a symlink, a gitfile or missing is main_checkout_unusable: no record could vouch for where it leads", async () => {
    const l = await linked();
    const unusable = { code: "main_checkout_unusable" };
    await expect(mainCheckoutTarget(l.wt)).rejects.toMatchObject(unusable); // a linked worktree: its .git is a gitfile
    await expect(mainCheckoutTarget(join(l.root, "nowhere"))).rejects.toMatchObject(unusable);
    const viaLink = join(l.root, "via-link");
    mkdirSync(viaLink);
    symlinkSync(l.common, join(viaLink, ".git"));
    await expect(mainCheckoutTarget(viaLink)).rejects.toMatchObject(unusable);
  });

  test("git reads refs through a commondir planted in a main checkout's .git even with GIT_COMMON_DIR pinned, so one there is git_dir_tampered", async () => {
    const l = await linked();
    const t = await mainCheckoutTarget(l.main);
    expect((await pinnedRefs(l.main)).stdout).toContain("refs/heads/main");
    const fake = join(l.root, "fake.git");
    await git(["init", "-q", "--bare", fake]);
    writeFileSync(join(l.common, "commondir"), `${fake}\n`);
    expect((await pinnedRefs(l.main)).stdout).not.toContain("refs/heads/main"); // the refs come from the fake now
    await expect(mainCheckoutTarget(l.main)).rejects.toMatchObject(tampered);
    await expect(verifyGitLinks(t)).rejects.toMatchObject(tampered);
  });

  test("a target whose git dir is not <path>/.git, or whose .git was replaced after it was taken, is refused before git runs", async () => {
    const l = await linked();
    await expect(verifyGitLinks({ path: l.wt, gitDir: l.common, commonDir: l.common })).rejects.toMatchObject(
      tampered,
    );
    const t = await mainCheckoutTarget(l.main);
    renameSync(l.common, join(l.root, "moved.git"));
    symlinkSync(join(l.root, "moved.git"), l.common);
    await expect(verifyGitLinks(t)).rejects.toMatchObject(tampered);
  });
});
