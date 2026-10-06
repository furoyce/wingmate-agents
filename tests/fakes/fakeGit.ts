// tests/fakes/fakeGit.ts — in-memory GitPort/GhPort; push records the current HEAD and PR creation reuses an open PR per head (Ruling R2)
import { basename } from "node:path";
import type { GhPort, GitPort } from "../../src/ports";

export class FakeGit implements GitPort {
  commits = new Map<string, number>();
  changed = new Map<string, string[]>();
  added = new Map<string, { path: string; line: string }[]>();
  pushed: string[] = [];
  remoteSha = new Map<string, string>();
  /** Real git dirs of worktrees the fake Orca created on disk (makeWorld wires them); other paths get made-up ones. */
  commonDirs = new Map<string, string>();
  gitDirs = new Map<string, string>();

  async revParse(_cwd: string, ref: string) {
    return ref === "HEAD" ? "headsha" : "basesha";
  }
  async commonDir(cwd: string) {
    return this.commonDirs.get(cwd) ?? `${cwd}/.git-common`;
  }
  async gitDir(cwd: string) {
    return this.gitDirs.get(cwd) ?? `${cwd}/.git-common/worktrees/${basename(cwd)}`;
  }
  async changedPaths(cwd: string) {
    return this.changed.get(cwd) ?? [];
  }
  async addedLines(cwd: string) {
    return this.added.get(cwd) ?? [];
  }
  async commitsAhead(cwd: string) {
    return this.commits.get(cwd) ?? 0;
  }
  async push(cwd: string, branch: string) {
    this.pushed.push(`${cwd}:${branch}`);
    this.remoteSha.set(branch, await this.revParse(cwd, "HEAD"));
  }
  async lsRemoteSha(_cwd: string, branch: string) {
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
