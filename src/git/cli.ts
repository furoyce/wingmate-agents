// src/git/cli.ts — GitPort over the git binary; never prompts, never writes outside the given cwd.
import type { BranchHistory, GitPort } from "../ports";
import { WingmateError } from "../shared/errors";
import { type RunOptions, type RunResult, run } from "../shared/exec";
import { parseAddedLines } from "./diff";
import { isBranchName } from "./refname";

export type Runner = (argv: string[], opts?: RunOptions) => Promise<RunResult>;

/** A full SHA-1 or SHA-256 object name: nothing else may stand on the source side of a pushed refspec. */
const OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * D14: the environment of every git process the dispatcher starts in a worktree, directly or through gh. Its config has command scope,
 * above the repository's own, so no hook and no fsmonitor command runs with the owner's credentials: a relative `core.hooksPath`
 * (husky's `.husky/_`) resolves inside the agent-writable worktree, where an ignored hook is seen by neither git status, the path
 * guard nor the secret scan. Never prompts.
 */
export const DISPATCHER_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: "/dev/null",
  GIT_CONFIG_KEY_1: "core.fsmonitor",
  GIT_CONFIG_VALUE_1: "false",
};

/** Not `git_…`: an invalid branch is no infrastructure trouble, so a finish that keeps hitting it is counted (and quarantined). */
function assertBranch(branch: string): void {
  if (!isBranchName(branch))
    throw new WingmateError(
      "branch_invalid",
      "the branch name breaks git's ref-name rules",
      "the record's branch comes from Orca at claim; re-queue the issue",
    );
}

export class GitCli implements GitPort {
  constructor(private readonly exec: Runner = run) {}

  private async g(cwd: string, args: string[], timeoutMs = 60_000): Promise<string> {
    const r = await this.exec(["git", "-C", cwd, ...args], { timeoutMs, env: { ...DISPATCHER_GIT_ENV } });
    if (r.code !== 0)
      throw new WingmateError(
        "git_failed",
        `git ${args[0]} failed (${r.code}): ${r.stderr.trim().slice(0, 300)}`,
      );
    return r.stdout;
  }
  async revParse(cwd: string, ref: string): Promise<string> {
    return (await this.g(cwd, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
  }
  async commonDir(cwd: string): Promise<string> {
    return (await this.g(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  }
  async gitDir(cwd: string): Promise<string> {
    return (await this.g(cwd, ["rev-parse", "--absolute-git-dir"])).trim();
  }
  /**
   * `--no-renames`: a rename is reported as the deletion of its old path and the addition of its new one, so a file moved out of a
   * guarded path is still a changed path (and a moved file's lines are all added lines), whatever the owner's `diff.renames` is.
   */
  async changedPaths(cwd: string, baseSha: string, head = "HEAD"): Promise<string[]> {
    const out = await this.g(cwd, [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      "--diff-filter=ACMRD",
      `${baseSha}...${head}`,
    ]);
    return out.split("\0").filter(Boolean);
  }
  async addedLines(cwd: string, baseSha: string, head = "HEAD"): Promise<{ path: string; line: string }[]> {
    const diff = await this.g(
      cwd,
      [
        "diff",
        "--no-ext-diff",
        "--no-color",
        "--no-renames",
        "--unified=0",
        "--diff-filter=ACMR",
        `${baseSha}...${head}`,
      ],
      120_000,
    );
    return parseAddedLines(diff);
  }
  async commitsAhead(cwd: string, baseSha: string, head = "HEAD"): Promise<number> {
    const n = Number((await this.g(cwd, ["rev-list", "--count", `${baseSha}..${head}`])).trim());
    if (!Number.isInteger(n))
      throw new WingmateError("git_failed", "git rev-list --count returned no number");
    return n;
  }
  /**
   * The push sends every commit of `baseSha..head`, not the net diff: a file or line that one commit added and a later one removed is
   * gone from `baseSha...head` yet still in the pushed pack. Each commit is read against its first parent (a merge too), with the
   * same rename and filter rules as the net diff, and the messages with it.
   */
  async historyChanges(cwd: string, baseSha: string, head: string): Promise<BranchHistory> {
    const range = `${baseSha}..${head}`;
    const log = ["log", "--no-color", "--no-renames", "--diff-merges=first-parent", "--format="];
    const names = await this.g(cwd, [...log, "--name-only", "-z", "--diff-filter=ACMRD", range]);
    const patch = await this.g(
      cwd,
      [...log, "-p", "--no-ext-diff", "--unified=0", "--diff-filter=ACMR", range],
      120_000,
    );
    const messages = await this.g(cwd, ["log", "--format=%B", range]);
    return {
      paths: [...new Set(names.split("\0").filter(Boolean))],
      added: parseAddedLines(patch),
      messages,
    };
  }
  /**
   * §13.3(d, h): the commit the guards cleared, by its object name, to the record's own branch — never `HEAD` (it could move
   * between the guards and the push), never a `+` (force) refspec, never a name git would read as an option. `-u` records an
   * upstream only for a branch source, so git leaves the config alone for a commit id.
   */
  async push(cwd: string, branch: string, sha: string): Promise<void> {
    assertBranch(branch);
    if (!OBJECT_NAME.test(sha))
      throw new WingmateError("sha_invalid", "git push: the commit to publish is not a full object name");
    await this.g(cwd, ["push", "-u", "origin", `${sha}:refs/heads/${branch}`], 180_000);
  }
  /** The SHA of exactly `refs/heads/<branch>` on origin (`ls-remote` patterns also match `…/<branch>` of other branches). */
  async lsRemoteSha(cwd: string, branch: string): Promise<string | null> {
    assertBranch(branch);
    const out = await this.g(cwd, ["ls-remote", "--heads", "origin", branch]);
    for (const line of out.split("\n")) {
      const [sha, ref] = line.split("\t");
      if (sha && ref?.trim() === `refs/heads/${branch}`) return sha.trim();
    }
    return null;
  }
}
