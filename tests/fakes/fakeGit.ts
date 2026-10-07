// tests/fakes/fakeGit.ts — in-memory GitPort/GhPort; push records the commit it was given and PR creation reuses an open PR per head (Ruling R2)
import { basename } from "node:path";
import { verifyGitLinks } from "../../src/git/trust";
import type { GhPort, GitPort, GitTarget } from "../../src/ports";

/** A worktree target (C22) or, for test helpers, a bare worktree path. */
type GitAt = GitTarget | string;

/** As GitCli: a target's links are checked on disk before anything runs (the world's worktrees are real), so tampering refuses here too. */
async function pathOf(at: GitAt): Promise<string> {
  if (typeof at === "string") return at;
  await verifyGitLinks(at);
  return at.path;
}

export class FakeGit implements GitPort {
  commits = new Map<string, number>();
  changed = new Map<string, string[]>();
  added = new Map<string, { path: string; line: string }[]>();
  /** What a push of the worktree's branch sends as history (each commit's paths and added lines, and the messages): none by default. */
  history = new Map<string, { paths: string[]; added: { path: string; line: string }[]; messages: string }>();
  pushed: string[] = [];
  /** The remote URL of every push (C23: the configured GitHub URL). */
  pushUrls: string[] = [];
  remoteSha = new Map<string, string>();
  /** Real git dirs of worktrees the fake Orca created on disk (makeWorld wires them); other paths get made-up ones. */
  commonDirs = new Map<string, string>();
  gitDirs = new Map<string, string>();

  async revParse(at: GitAt, ref: string): Promise<string> {
    await pathOf(at);
    return ref === "HEAD" ? "headsha" : "basesha";
  }
  /** Test helpers (no longer on the port: the claim reads the git dirs from the worktree's own links, C22). */
  async commonDir(cwd: string) {
    return this.commonDirs.get(cwd) ?? `${cwd}/.git-common`;
  }
  async gitDir(cwd: string) {
    return this.gitDirs.get(cwd) ?? `${cwd}/.git-common/worktrees/${basename(cwd)}`;
  }
  async changedPaths(at: GitAt, _baseSha: string, _head?: string) {
    return this.changed.get(await pathOf(at)) ?? [];
  }
  async addedLines(at: GitAt, _baseSha: string, _head?: string) {
    return this.added.get(await pathOf(at)) ?? [];
  }
  async commitsAhead(at: GitAt, _baseSha: string, _head?: string) {
    return this.commits.get(await pathOf(at)) ?? 0;
  }
  async historyChanges(at: GitAt, _baseSha: string, _head: string, _since?: string | null) {
    return this.history.get(await pathOf(at)) ?? { paths: [], added: [], messages: "" };
  }
  /** As `git push <url> <sha>:refs/heads/<branch>`: the remote's branch then points at exactly the commit pushed. */
  async push(at: GitTarget, url: string, branch: string, sha: string) {
    this.pushed.push(`${await pathOf(at)}:${branch}`);
    this.pushUrls.push(url);
    this.remoteSha.set(branch, sha);
  }
  async lsRemoteSha(at: GitTarget, _url: string, branch: string) {
    await pathOf(at);
    return this.remoteSha.get(branch) ?? null;
  }
}

export class FakeGh implements GhPort {
  prs: { number: number; url: string; head: string }[] = [];
  /** `gh pr view` state per PR number (default OPEN); tests merge or close PRs here. */
  states = new Map<number, string>();

  async prCreate(
    _cwd: string,
    a: { head: string; base: string; title: string; body: string; draft: boolean },
  ) {
    const existing = this.prs.find((p) => p.head === a.head);
    if (existing) return { number: existing.number, url: existing.url };
    const number = this.prs.length + 1;
    const url = `https://github.com/fake/repo/pull/${number}`;
    this.prs.push({ number, url, head: a.head });
    return { number, url };
  }
  async prView(_cwd: string, number: number) {
    const p = this.prs.find((x) => x.number === number);
    if (!p) throw new Error("no pr");
    return { state: this.states.get(number) ?? "OPEN", headRefName: p.head, url: p.url };
  }
}
