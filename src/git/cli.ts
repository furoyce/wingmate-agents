// src/git/cli.ts — GitPort over the git binary; never prompts, never writes outside the given cwd.
import type { GitPort } from "../ports";
import { WingmateError } from "../shared/errors";
import { type RunOptions, type RunResult, run } from "../shared/exec";
import { parseAddedLines } from "./diff";

export type Runner = (argv: string[], opts?: RunOptions) => Promise<RunResult>;

export class GitCli implements GitPort {
  constructor(private readonly exec: Runner = run) {}

  private async g(cwd: string, args: string[], timeoutMs = 60_000): Promise<string> {
    const r = await this.exec(["git", "-C", cwd, ...args], { timeoutMs, env: { GIT_TERMINAL_PROMPT: "0" } });
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
  async changedPaths(cwd: string, baseSha: string): Promise<string[]> {
    const out = await this.g(cwd, ["diff", "--name-only", "-z", "--diff-filter=ACMRD", `${baseSha}...HEAD`]);
    return out.split("\0").filter(Boolean);
  }
  async addedLines(cwd: string, baseSha: string): Promise<{ path: string; line: string }[]> {
    const diff = await this.g(
      cwd,
      ["diff", "--no-ext-diff", "--no-color", "--unified=0", "--diff-filter=ACMR", `${baseSha}...HEAD`],
      120_000,
    );
    return parseAddedLines(diff);
  }
  async commitsAhead(cwd: string, baseSha: string): Promise<number> {
    const n = Number((await this.g(cwd, ["rev-list", "--count", `${baseSha}..HEAD`])).trim());
    if (!Number.isInteger(n))
      throw new WingmateError("git_failed", "git rev-list --count returned no number");
    return n;
  }
  async push(cwd: string, branch: string): Promise<void> {
    await this.g(cwd, ["push", "-u", "origin", `HEAD:refs/heads/${branch}`], 180_000);
  }
  /** The SHA of exactly `refs/heads/<branch>` on origin (`ls-remote` patterns also match `…/<branch>` of other branches). */
  async lsRemoteSha(cwd: string, branch: string): Promise<string | null> {
    const out = await this.g(cwd, ["ls-remote", "--heads", "origin", branch]);
    for (const line of out.split("\n")) {
      const [sha, ref] = line.split("\t");
      if (sha && ref?.trim() === `refs/heads/${branch}`) return sha.trim();
    }
    return null;
  }
}
