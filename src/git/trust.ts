// src/git/trust.ts — C22 (§13.3 d): the issue worktree's git links. `<worktree>/.git` (the gitfile) and `<gitdir>/commondir` are
// agent-writable, and git follows them to the config it obeys (core.sshCommand, credential.helper, url.*.insteadOf, filters) and to
// the refs it resolves; so the dispatcher runs git in a worktree only while both still name the git dirs the claim recorded.
// A refusal names only paths the dispatcher knows (the worktree from Orca, the recorded git dirs), never what the links say: they are
// agent-written, and a refusal becomes the blocked comment on the issue. F1/F2: the main checkout's git dir, where the claim checks
// its base before any issue worktree exists.
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { GitTarget } from "../ports";
import { WingmateError } from "../shared/errors";

const LINK_MAX_BYTES = 4096;
/** Never a symlink at the last component (ELOOP), and never a wait on a FIFO planted at the name. */
const LINK_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

const tampered = (message: string) =>
  new WingmateError(
    "git_dir_tampered",
    message,
    "inspect the worktree's .git file and its gitdir (an agent may have redirected them), then move the issue back to Todo to re-queue it",
  );

/** A one-line link file (`.git`, `commondir`), read only when it is a regular file. */
async function linkFile(path: string, label: string): Promise<string> {
  const fh = await open(path, LINK_FLAGS).catch((e: NodeJS.ErrnoException) => {
    throw tampered(`${label} cannot be read as a regular file (${e.code ?? "error"})`);
  });
  try {
    if (!(await fh.stat()).isFile()) throw tampered(`${label} is not a regular file`);
    const buf = Buffer.alloc(LINK_MAX_BYTES);
    const { bytesRead } = await fh.read(buf, 0, LINK_MAX_BYTES, 0);
    return buf.subarray(0, bytesRead).toString("utf8").trim();
  } finally {
    await fh.close();
  }
}

/**
 * Where git lands for `target` read from a file in `base`: one component at a time, a symlink resolved before a following `..` (git's
 * strbuf_realpath does this; Node's realpath applies `..` first). It must also be where the path reads lexically — git writes these
 * links without symlinks, and a link through one can be re-pointed after any check.
 */
async function landing(base: string, target: string, label: string): Promise<string> {
  const start = isAbsolute(target) ? "/" : await realpath(base).catch(() => base);
  let at = start;
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    at =
      part === ".."
        ? dirname(at)
        : await realpath(join(at, part)).catch((e: NodeJS.ErrnoException) => {
            throw tampered(`${label} names a path that does not resolve (${e.code ?? "error"})`);
          });
  }
  if (at !== resolve(start, target)) throw tampered(`${label} names its path through a symlink`);
  return at;
}

/** The gitdir the worktree's gitfile names, where git lands for it. */
async function gitDirOf(path: string): Promise<string> {
  const label = `${path}/.git`;
  const m = /^gitdir: (.+)$/.exec(await linkFile(join(path, ".git"), label));
  if (!m?.[1]) throw tampered(`${label} is not a gitfile`);
  return landing(path, m[1], label);
}

/** The common dir a gitdir's `commondir` names, where git lands for it. */
const commonDirOf = async (gitDir: string, label: string): Promise<string> =>
  landing(gitDir, await linkFile(join(gitDir, "commondir"), label), label);

/**
 * F1/F2: a main checkout's git dir — `<path>/.git`, a directory (never a symlink or a gitfile) that is the git dir and the common dir
 * both — holding no `commondir` file: git's ref store follows a gitdir's `commondir` even while GIT_COMMON_DIR pins the common dir
 * (git 2.53), so a planted one would hand every ref read to another directory. Agents cannot write the main checkout itself, only
 * parts of its `.git` (§13.3 b).
 */
async function verifyMainGitDir(t: GitTarget): Promise<void> {
  const label = `${t.path}/.git`;
  if (t.gitDir !== join(t.path, ".git"))
    throw tampered(`${label} is not the main checkout's git dir ${t.gitDir}`);
  const st = await lstat(t.gitDir).catch((e: NodeJS.ErrnoException) => {
    throw tampered(`${label} cannot be read (${e.code ?? "error"})`);
  });
  if (!st.isDirectory()) throw tampered(`${label} is no longer a directory`);
  const planted = await lstat(join(t.gitDir, "commondir")).then(
    () => true,
    (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return false;
      throw tampered(`${label}/commondir cannot be checked (${e.code ?? "error"})`);
    },
  );
  if (planted)
    throw tampered(
      `${label} holds a commondir file, which a main checkout's git dir never has: git would read its refs through it`,
    );
}

/**
 * F1/F2 (C30): the repository's main checkout (Orca's `worktree ps` row with `isMainWorktree`) as the git target of the claim's base
 * check, made before any issue worktree exists: git runs there with `<path>/.git` pinned as both its git dir and its common dir.
 * `main_checkout_unusable` when `<path>/.git` is not a directory (missing, a symlink, or a gitfile, which no dispatcher record could
 * vouch for); `git_dir_tampered` when it holds a `commondir` file.
 */
export async function mainCheckoutTarget(path: string): Promise<GitTarget> {
  const gitDir = join(path, ".git");
  const st = await lstat(gitDir).catch(() => null);
  if (!st?.isDirectory())
    throw new WingmateError(
      "main_checkout_unusable",
      `${gitDir} is not a directory (missing, a symlink or a gitfile): the base is verified only in a main checkout that holds its own git dir`,
      "point Orca's repository at a plain clone whose .git is a directory, then move the issue back to Todo to re-queue it",
    );
  const t: GitTarget = { path, gitDir, commonDir: gitDir };
  await verifyMainGitDir(t);
  return t;
}

/**
 * C22: refuses (`git_dir_tampered`) unless the worktree's gitfile names `t.gitDir` and that gitdir's `commondir` names `t.commonDir`.
 * A main checkout's target (F1/F2: its git dir is its common dir) is checked as `verifyMainGitDir` says.
 */
export async function verifyGitLinks(t: GitTarget): Promise<void> {
  if (t.gitDir === t.commonDir) return verifyMainGitDir(t);
  if ((await gitDirOf(t.path)) !== t.gitDir)
    throw tampered(`${t.path}/.git does not name the worktree's own gitdir ${t.gitDir}`);
  const label = `${t.gitDir}/commondir`;
  if ((await commonDirOf(t.gitDir, label)) !== t.commonDir)
    throw tampered(`${label} does not name the common dir ${t.commonDir}`);
}

/**
 * C22 at claim: the worktree's git dirs read from its own links, accepted only in a linked worktree's layout — the gitdir is
 * `<common>/worktrees/<name>` and its `commondir` names that `<common>` — and, for a worktree an earlier cycle recorded, only when
 * they are the git dirs recorded then (the archived record is dispatcher-owned; the links are not).
 */
export async function discoverGitLinks(
  path: string,
  recorded: { gitCommonDir: string; gitdirName: string } | null,
): Promise<GitTarget> {
  const gitDir = await gitDirOf(path);
  const commonDir = dirname(dirname(gitDir));
  const layout = `${path}/.git does not name a linked worktree's gitdir under its common dir`;
  if (basename(dirname(gitDir)) !== "worktrees") throw tampered(layout);
  if ((await commonDirOf(gitDir, `the commondir of ${path}/.git's gitdir`)) !== commonDir)
    throw tampered(layout);
  if (recorded && (commonDir !== recorded.gitCommonDir || basename(gitDir) !== recorded.gitdirName))
    throw tampered(
      `${path} no longer names the git dirs recorded for it (${join(recorded.gitCommonDir, "worktrees", recorded.gitdirName)})`,
    );
  return { path, gitDir, commonDir };
}

/** The record's worktree as the git target the dispatcher runs git against. */
export const gitTarget = (wt: { path: string; gitCommonDir: string; gitdirName: string }): GitTarget => ({
  path: wt.path,
  gitDir: join(wt.gitCommonDir, "worktrees", wt.gitdirName),
  commonDir: wt.gitCommonDir,
});
