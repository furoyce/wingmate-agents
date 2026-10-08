// src/git/cli.ts — GitPort over the git binary; never prompts, never writes outside the given cwd.
import type { BranchHistory, GitPort, GitTarget } from "../ports";
import { WingmateError } from "../shared/errors";
import { type RunOptions, type RunResult, run } from "../shared/exec";
import { parseAddedLines } from "./diff";
import { isBranchName } from "./refname";
import { verifyGitLinks } from "./trust";

export type Runner = (argv: string[], opts?: RunOptions) => Promise<RunResult>;
/**
 * Where a command runs: a dispatcher target — an issue worktree whose links are verified and whose git dirs are pinned (C22) — or a
 * plain checkout directory, for the agent's own `gate` inside its sandbox.
 */
export type GitAt = GitTarget | string;

/** A full SHA-1 or SHA-256 object name: nothing else may stand on the source side of a pushed refspec. */
const OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * D14: the environment of every git process the dispatcher starts, directly or through gh (C29: gh runs outside every worktree, so its
 * own git calls find no repository; this stays as a second layer). Its config has command scope,
 * above the repository's own, so no hook and no fsmonitor command runs with the owner's credentials: a relative `core.hooksPath`
 * (husky's `.husky/_`) resolves inside the agent-writable worktree, where an ignored hook is seen by neither git status, the path
 * guard nor the secret scan. Never prompts. F7: never follows a replace ref (`refs/replace/<object>`, which an agent's sandbox can add
 * through the shared packed-refs): one would show the guards another object than the one the push sends (pack-objects never
 * replaces), and the base checks another history than GitHub's.
 */
export const DISPATCHER_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: "/dev/null",
  GIT_CONFIG_KEY_1: "core.fsmonitor",
  GIT_CONFIG_VALUE_1: "false",
};

/**
 * C24 (§13.3 d): text-mode diffs. No `.gitattributes` — committed, or untracked (the work tree's apply to a diff of two commits too) —
 * turns a file into "Binary files differ", and no textconv or external diff driver rewrites what the guards read.
 */
const TEXT = ["--text", "--no-textconv", "--no-ext-diff"];
/** C22: a `git log` that never verifies a signature (`log.showSignature` would start gpg on the agent's commits). */
const LOG = ["-c", "log.showSignature=false", "log"];
/** C23: a GitHub repository URL — https, scp-like ssh or ssh:// — and its `owner/name`; GitHub names are case-insensitive. */
const GITHUB_REMOTE =
  /^(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i;
const githubRepo = (url: string): string | null => {
  const m = GITHUB_REMOTE.exec(url.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
};
/** C26: the ref line `git push --porcelain` prints for a non-fast-forward rejection (its status words are not translated). */
const NON_FAST_FORWARD = /^!\t[^\t]*\t\[rejected\] \((?:non-fast-forward|fetch first)\)$/m;
/** SEC-2: a URL's userinfo (`scheme://<userinfo>@host`) — scp-like `user@host:path` carries no scheme and no secret. */
const URL_USERINFO = /^([a-z][a-z0-9+.-]*):\/\/([^/@\s]*)@/i;
/** SEC-2: a URL that carries a credential: any userinfo over http(s) (a token as user name), or a password in any scheme. */
function credentialInUrl(url: string): boolean {
  const m = URL_USERINFO.exec(url.trim());
  return !!m && (/^https?$/i.test(m[1] ?? "") || (m[2] ?? "").includes(":"));
}
/** F7: how many replace refs `replaceRefs` names — one is enough to refuse, and the read stays bounded. */
const REPLACE_REFS_MAX = 10;

/** Not `git_…`: an invalid branch is no infrastructure trouble, so a finish that keeps hitting it is counted (and quarantined). */
function assertBranch(branch: string): void {
  if (!isBranchName(branch))
    throw new WingmateError(
      "branch_invalid",
      "the branch name breaks git's ref-name rules",
      "the record's branch comes from Orca at claim; re-queue the issue",
    );
}

const mismatch = (message: string) =>
  new WingmateError(
    "remote_mismatch",
    message,
    "point the repository's origin at repos.<name>.github in config/projects.yaml (or fix the config), then run finish again",
  );

/** C23: the configured remote, which only ever stands on a command line as a GitHub URL (never a name git reads as an option). */
function assertRemote(url: string): string {
  const repo = githubRepo(url);
  if (!repo) throw mismatch("the configured remote is not a GitHub repository URL; nothing was pushed");
  return repo;
}

export class GitCli implements GitPort {
  constructor(private readonly exec: Runner = run) {}

  /** C22: in a worktree target, only once its gitfile and commondir still name the recorded git dirs — and with those dirs pinned. */
  private async run(at: GitAt, args: string[], timeoutMs: number): Promise<RunResult> {
    if (typeof at === "string")
      return this.exec(["git", "-C", at, ...args], { timeoutMs, env: { ...DISPATCHER_GIT_ENV } });
    await verifyGitLinks(at);
    return this.exec(["git", "-C", at.path, `--git-dir=${at.gitDir}`, `--work-tree=${at.path}`, ...args], {
      timeoutMs,
      env: { ...DISPATCHER_GIT_ENV, GIT_COMMON_DIR: at.commonDir },
    });
  }
  private async g(at: GitAt, args: string[], timeoutMs = 60_000): Promise<string> {
    const r = await this.run(at, args, timeoutMs);
    const verb = args[args[0] === "-c" ? 2 : 0];
    if (r.code !== 0)
      throw new WingmateError(
        "git_failed",
        `git ${verb} failed (${r.code}): ${r.stderr.trim().slice(0, 300)}`,
      );
    // C25: a diff or log cut at the capture cap would leave its later paths and lines unguarded — never read as if complete
    if (r.truncated)
      throw new WingmateError("diff_too_large", `git ${verb} output exceeds the 8 MiB capture`);
    return r.stdout;
  }
  /** Whether this repository has the commit `sha` (C26: a remote tip pushed from elsewhere may be unknown here). */
  private async hasCommit(at: GitAt, sha: string): Promise<boolean> {
    return (await this.run(at, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], 30_000)).code === 0;
  }
  /** F7: the ref is never read as an option; callers pass a full ref (`qualifiedBase`) or HEAD, never a short name to disambiguate. */
  async revParse(at: GitAt, ref: string): Promise<string> {
    return (await this.g(at, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
  }
  /**
   * Reviews run against committed source. Check index and worktree separately: a staged edit followed by restoring the worktree to
   * HEAD still has an unreviewed index. Protocol files are deliberately mutable. Hidden index entries fail closed too because git
   * diff may otherwise ignore changes to assume-unchanged/skip-worktree files. This is a checkpoint, not an immutable snapshot.
   */
  async hasTrackedChanges(at: GitAt): Promise<boolean> {
    const paths = ["--", ".", ":(top,exclude).wingmate"];
    const entries = await this.g(at, ["ls-files", "-v", "-z", ...paths]);
    if (entries.split("\0").some((entry) => entry && /^[a-zS] /.test(entry))) return true;
    for (const compare of [["--cached", "HEAD"], []]) {
      const r = await this.run(
        at,
        [
          "diff",
          "--quiet",
          "--no-ext-diff",
          "--no-textconv",
          "--ignore-submodules=none",
          ...compare,
          ...paths,
        ],
        60_000,
      );
      if (r.timedOut || r.truncated || (r.code !== 0 && r.code !== 1))
        throw new WingmateError("git_failed", "git diff could not verify committed review inputs");
      if (r.code === 1) return true;
    }
    return false;
  }
  async commonDir(at: GitAt): Promise<string> {
    return (await this.g(at, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  }
  /** `git rev-parse --absolute-git-dir`: a linked worktree's admin dir (its basename is the gitdir name; git de-duplicates them). */
  async gitDir(at: GitAt): Promise<string> {
    return (await this.g(at, ["rev-parse", "--absolute-git-dir"])).trim();
  }
  /**
   * `--no-renames`: a rename is reported as the deletion of its old path and the addition of its new one, so a file moved out of a
   * guarded path is still a changed path (and a moved file's lines are all added lines), whatever the owner's `diff.renames` is.
   * C24: `T` too — a symlink replaced by a regular file (or the reverse) is a changed path, and the new file's lines are added lines.
   */
  async changedPaths(at: GitAt, baseSha: string, head = "HEAD"): Promise<string[]> {
    const out = await this.g(at, [
      "diff",
      "--name-only",
      "-z",
      ...TEXT,
      "--no-renames",
      "--diff-filter=ACMRDT",
      `${baseSha}...${head}`,
    ]);
    return out.split("\0").filter(Boolean);
  }
  async addedLines(at: GitAt, baseSha: string, head = "HEAD"): Promise<{ path: string; line: string }[]> {
    const diff = await this.g(
      at,
      [
        "diff",
        ...TEXT,
        "--no-color",
        "--no-renames",
        "--unified=0",
        "--diff-filter=ACMRT",
        `${baseSha}...${head}`,
      ],
      120_000,
    );
    return parseAddedLines(diff);
  }
  async commitsAhead(at: GitAt, baseSha: string, head = "HEAD"): Promise<number> {
    const n = Number((await this.g(at, ["rev-list", "--count", `${baseSha}..${head}`])).trim());
    if (!Number.isInteger(n))
      throw new WingmateError("git_failed", "git rev-list --count returned no number");
    return n;
  }
  /**
   * The push sends every commit of `baseSha..head`, not the net diff: a file or line that one commit added and a later one removed is
   * gone from `baseSha...head` yet still in the pushed pack. Each commit is read against its first parent (a merge too), with the
   * same rename and filter rules as the net diff, and the messages with it. C26: commits reachable from `since` (the remote branch's
   * tip) are on the remote already and are left out — when this repository has that commit; otherwise the whole range is read.
   */
  async historyChanges(
    at: GitAt,
    baseSha: string,
    head: string,
    since: string | null = null,
  ): Promise<BranchHistory> {
    const onRemote = since !== null && OBJECT_NAME.test(since) && (await this.hasCommit(at, since));
    const range = [`${baseSha}..${head}`, ...(onRemote ? [`^${since}`] : [])];
    const log = [...LOG, "--no-color", "--no-renames", "--diff-merges=first-parent", "--format=", ...TEXT];
    const names = await this.g(at, [...log, "--name-only", "-z", "--diff-filter=ACMRDT", ...range]);
    const patch = await this.g(at, [...log, "-p", "--unified=0", "--diff-filter=ACMRT", ...range], 120_000);
    const messages = await this.g(at, [...LOG, "--format=%B", ...range]);
    return {
      paths: [...new Set(names.split("\0").filter(Boolean))],
      added: parseAddedLines(patch),
      messages,
    };
  }
  /**
   * §13.3(d, h): the commit the guards cleared, by its object name, to the record's own branch — never `HEAD` (it could move
   * between the guards and the push), never a `+` (force) refspec, never a name git would read as an option. `-u` records an
   * upstream only for a branch source, so git leaves the config alone for a commit id. C23: to the configured URL, once origin is
   * proven to name the same repository; C26: a non-fast-forward rejection is `push_rejected`, never retried as infrastructure.
   */
  async push(t: GitTarget, url: string, branch: string, sha: string): Promise<void> {
    assertBranch(branch);
    if (!OBJECT_NAME.test(sha))
      throw new WingmateError("sha_invalid", "git push: the commit to publish is not a full object name");
    const repo = assertRemote(url);
    const origin = await this.run(t, ["config", "--get", "remote.origin.url"], 30_000);
    if (origin.code > 1)
      throw new WingmateError(
        "git_failed",
        `git config failed (${origin.code}): ${origin.stderr.trim().slice(0, 300)}`,
      );
    // the origin URL itself is never echoed: it can carry credentials
    if (origin.code === 1 || githubRepo(origin.stdout) !== repo)
      throw mismatch(`remote.origin.url does not name ${repo}; nothing was pushed`);
    const r = await this.run(t, ["push", "--porcelain", "-u", url, `${sha}:refs/heads/${branch}`], 180_000);
    if (r.code === 0) return;
    if (NON_FAST_FORWARD.test(r.stdout))
      throw new WingmateError(
        "push_rejected",
        `${branch}: the remote branch's tip is not an ancestor of the commit to publish (non-fast-forward); nothing is force-pushed`,
      );
    throw new WingmateError("git_failed", `git push failed (${r.code}): ${r.stderr.trim().slice(0, 300)}`);
  }
  /** The SHA of exactly `refs/heads/<branch>` at `url` (`ls-remote` patterns also match `…/<branch>` of other branches). */
  async lsRemoteSha(t: GitTarget, url: string, branch: string): Promise<string | null> {
    assertBranch(branch);
    assertRemote(url);
    const out = await this.g(t, ["ls-remote", "--heads", url, branch]);
    for (const line of out.split("\n")) {
      const [sha, ref] = line.split("\t");
      const s = sha?.trim() ?? "";
      if (ref?.trim() === `refs/heads/${branch}` && OBJECT_NAME.test(s)) return s;
    }
    return null;
  }
  /**
   * C30: the commit `sha`, by its object name, from the configured URL into this repository's object store — only when it is missing.
   * Nothing else changes: no ref (no refspec destination), no FETCH_HEAD, no tags, no submodules, no auto-maintenance.
   */
  async fetchCommit(t: GitTarget, url: string, sha: string): Promise<boolean> {
    if (!OBJECT_NAME.test(sha))
      throw new WingmateError("sha_invalid", "git fetch: the commit to fetch is not a full object name");
    assertRemote(url);
    if (await this.hasCommit(t, sha)) return false;
    const fetch = [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--no-auto-maintenance",
      "--no-recurse-submodules",
    ];
    await this.g(t, [...fetch, url, sha], 180_000);
    if (!(await this.hasCommit(t, sha)))
      throw new WingmateError("git_failed", "git fetch: the commit is still missing after the fetch");
    return true;
  }
  /**
   * F3: `git merge-base --is-ancestor <ancestor> <descendant>` — exit 0 is true, 1 is false, anything else (an object this repository
   * does not have) is null. Both are full object names, so neither can read as an option.
   */
  async isAncestor(t: GitTarget, ancestor: string, descendant: string): Promise<boolean | null> {
    if (!OBJECT_NAME.test(ancestor) || !OBJECT_NAME.test(descendant))
      throw new WingmateError("sha_invalid", "git merge-base: a commit to compare is not a full object name");
    const r = await this.run(t, ["merge-base", "--is-ancestor", ancestor, descendant], 60_000);
    return r.code === 0 ? true : r.code === 1 ? false : null;
  }
  /** F7: `git for-each-ref` of `refs/replace/` on the pinned target — packed and loose refs alike, at most ten names. */
  async replaceRefs(t: GitTarget): Promise<string[]> {
    const args = ["for-each-ref", `--count=${REPLACE_REFS_MAX}`, "--format=%(refname)", "refs/replace/"];
    return (await this.g(t, args)).split("\n").filter(Boolean);
  }
  /**
   * R30: `git for-each-ref --ignore-case` on the pinned target over every ref `refs/<any directories>/<sha>` (one wildmatch pattern; its
   * double-star part also matches no directory), kept to the refs whose last component is the commit. The commit must be a full
   * object name, so the pattern holds no glob of anyone else's.
   */
  async refsNamedAfter(t: GitTarget, sha: string): Promise<string[]> {
    if (!OBJECT_NAME.test(sha))
      throw new WingmateError("sha_invalid", "git for-each-ref: the commit is not a full object name");
    const args = [
      "for-each-ref",
      "--ignore-case",
      `--count=${REPLACE_REFS_MAX}`,
      "--format=%(refname)",
      `refs/**/${sha}`,
    ];
    const named = (ref: string) => ref.split("/").at(-1)?.toLowerCase() === sha;
    return (await this.g(t, args)).split("\n").filter(named);
  }
  /** R30: `git config --local --type=bool --get core.useReplaceRefs` — git's own boolean reading; exit 1 is unset. */
  async useReplaceRefs(t: GitTarget): Promise<boolean | null> {
    const r = await this.run(t, ["config", "--local", "--type=bool", "--get", "core.useReplaceRefs"], 30_000);
    if (r.code === 1) return null;
    const value = r.stdout.trim();
    if (r.code === 0 && (value === "true" || value === "false")) return value === "true";
    throw new WingmateError(
      "git_failed",
      `git config failed (${r.code}): ${r.stderr.trim().slice(0, 300) || "no boolean"}`,
    );
  }
  /**
   * SEC-2: `git config --local --null --list` on the pinned target, reduced to the keys that hand an agent a credential: `credential.*`
   * (a helper there runs for any git in the repository, the agent's too, after the kit's global reset), and a remote URL or an
   * `insteadOf` rewrite with a credential in it. A subsection that is a URL is shown as `*`; no value is ever returned.
   */
  async credentialConfig(t: GitTarget): Promise<string[]> {
    const keys: string[] = [];
    for (const entry of (await this.g(t, ["config", "--local", "--null", "--list"], 30_000)).split("\0")) {
      if (!entry) continue;
      const nl = entry.indexOf("\n");
      const key = nl < 0 ? entry : entry.slice(0, nl);
      const value = nl < 0 ? "" : entry.slice(nl + 1);
      const first = key.indexOf(".");
      const last = key.lastIndexOf(".");
      const section = key.slice(0, first).toLowerCase();
      const name = key.slice(last + 1).toLowerCase();
      const sub = first === last ? null : key.slice(first + 1, last);
      if (section === "credential") keys.push(sub === null ? `credential.${name}` : `credential.*.${name}`);
      else if (section === "remote" && (name === "url" || name === "pushurl") && credentialInUrl(value))
        keys.push(`remote.${sub ?? ""}.${name} (userinfo)`);
      else if (
        section === "url" &&
        (name === "insteadof" || name === "pushinsteadof") &&
        credentialInUrl(sub ?? "")
      )
        keys.push(`url.*.${name} (userinfo)`);
    }
    return [...new Set(keys)];
  }
  /** R30: `git config --local --replace-all core.useReplaceRefs false` — one value left, however many there were (a plain set refuses several). */
  async disableReplaceRefs(t: GitTarget): Promise<void> {
    await this.g(t, ["config", "--local", "--replace-all", "core.useReplaceRefs", "false"], 30_000);
  }
}
