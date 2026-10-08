// tests/fakes/fakeGit.ts — in-memory GitPort/GhPort; push records the commit it was given and PR creation reuses an open PR per head (Ruling R2)
import { basename } from "node:path";
import { GitCli } from "../../src/git/cli";
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
  /** The remote's branch tips: the base branch `main` is at `basesha` (C30), the commit every base ref resolves to here. */
  remoteSha = new Map<string, string>([["main", "basesha"]]);
  /** Every remote read, in order (C30: the claim reads the base branch of the configured URL). */
  remoteReads: { url: string; branch: string }[] = [];
  /** Commits this repository lacks until `fetchCommit` brings them (C30); a ref naming one does not resolve meanwhile. */
  missing = new Set<string>();
  /** What `fetchCommit` fetched, and from where. */
  fetched: { url: string; sha: string }[] = [];
  /** `${ancestor}..${descendant}` pairs where the first is in the second's history (F3: a stale clone); no other pair is. */
  ancestors = new Set<string>();
  /**
   * Refs a test planted, each resolving to its own commit (F1/F2: `refs/heads/<GitHub's commit>`, which Orca takes for the base; F7:
   * `refs/replace/<object>`, which makes git read another object in its place).
   */
  planted = new Map<string, string>();
  /** Real git dirs of worktrees the fake Orca created on disk (makeWorld wires them); other paths get made-up ones. */
  commonDirs = new Map<string, string>();
  gitDirs = new Map<string, string>();
  /**
   * Each worktree's HEAD: where Orca really started it (makeWorld: FakeOrca's `startCommit` at the create), until the agent commits
   * (readyToFinish: `headsha`). Any other path's HEAD is `headsha`.
   */
  heads = new Map<string, string>();
  /** `core.useReplaceRefs` in each repository's own config, by main checkout path (R30); absent: unset. */
  replaceRefsConfig = new Map<string, boolean>();
  /** The main checkout of every `disableReplaceRefs` write, in order (R30: `install` writes only when the value is not false). */
  configWrites: string[] = [];
  /** SEC-2: the credential-bearing keys each repository's own config holds, by main checkout path; absent: none. */
  credentialKeys = new Map<string, string[]>();

  async revParse(at: GitAt, ref: string): Promise<string> {
    const path = await pathOf(at);
    const planted = this.planted.get(ref);
    if (planted !== undefined) return planted;
    // a branch named after a remote tip's commit exists only when a test plants it: git never makes one
    if (
      ref.startsWith("refs/heads/") &&
      [...this.remoteSha.values()].includes(ref.slice("refs/heads/".length))
    )
      throw new Error(`git rev-parse failed (128): fatal: ${ref}: Needed a single revision`);
    const sha = ref === "HEAD" ? (this.heads.get(path) ?? "headsha") : "basesha";
    if (this.missing.has(sha))
      throw new Error(`git rev-parse failed (128): fatal: ${ref}: bad object ${sha}`);
    return sha;
  }
  /** Role review cleanliness is checked on the real fixture worktree/index, rather than inferred from fake committed diffs. */
  async hasTrackedChanges(at: GitAt): Promise<boolean> {
    return new GitCli().hasTrackedChanges(at);
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
  async lsRemoteSha(at: GitTarget, url: string, branch: string) {
    await pathOf(at);
    this.remoteReads.push({ url, branch });
    return this.remoteSha.get(branch) ?? null;
  }
  /** As GitCli: nothing when the commit is here; else it is fetched from `url` (and is here afterwards). */
  async fetchCommit(at: GitTarget, url: string, sha: string) {
    await pathOf(at);
    if (!this.missing.delete(sha)) return false;
    this.fetched.push({ url, sha });
    return true;
  }
  async isAncestor(at: GitTarget, ancestor: string, descendant: string) {
    await pathOf(at);
    return this.ancestors.has(`${ancestor}..${descendant}`);
  }
  /** As GitCli: the planted refs under `refs/replace/`, sorted, at most ten (F7). */
  async replaceRefs(at: GitTarget) {
    await pathOf(at);
    return [...this.planted.keys()]
      .filter((ref) => ref.startsWith("refs/replace/"))
      .sort()
      .slice(0, 10);
  }
  /** As GitCli (R30): the planted refs whose last path component is `sha`, in any case, sorted, at most ten. */
  async refsNamedAfter(at: GitTarget, sha: string) {
    await pathOf(at);
    return [...this.planted.keys()]
      .filter((ref) => ref.split("/").at(-1)?.toLowerCase() === sha.toLowerCase())
      .sort()
      .slice(0, 10);
  }
  /** As GitCli (R30): the repository's own `core.useReplaceRefs`, null when unset. */
  async useReplaceRefs(at: GitTarget) {
    return this.replaceRefsConfig.get(await pathOf(at)) ?? null;
  }
  /** As GitCli (SEC-2): the credential-bearing keys of the repository's own config. */
  async credentialConfig(at: GitTarget) {
    return [...(this.credentialKeys.get(await pathOf(at)) ?? [])];
  }
  async disableReplaceRefs(at: GitTarget) {
    const path = await pathOf(at);
    this.configWrites.push(path);
    this.replaceRefsConfig.set(path, false);
  }
}

export class FakeGh implements GhPort {
  prs: { number: number; url: string; head: string }[] = [];
  /** `gh pr view` state per PR number (default OPEN); tests merge or close PRs here. */
  states = new Map<number, string>();
  /** The repository each call named, in order (C29: `repos.<name>.github`, never a worktree path). */
  repos: string[] = [];

  async prCreate(
    repo: string,
    a: { head: string; base: string; title: string; body: string; draft: boolean },
  ) {
    this.repos.push(repo);
    const existing = this.prs.find((p) => p.head === a.head);
    if (existing) return { number: existing.number, url: existing.url };
    const number = this.prs.length + 1;
    const url = `https://github.com/fake/repo/pull/${number}`;
    this.prs.push({ number, url, head: a.head });
    return { number, url };
  }
  async prView(repo: string, number: number) {
    this.repos.push(repo);
    const p = this.prs.find((x) => x.number === number);
    if (!p) throw new Error("no pr");
    return { state: this.states.get(number) ?? "OPEN", headRefName: p.head, url: p.url };
  }
}
