// src/ports.ts — every DTO and port the machine uses. Later tasks compile against these names verbatim.
export interface LinearLabel {
  id: string;
  name: string;
  parentId: string | null;
  parentName: string | null;
}
export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  trashed: boolean;
  priority: number;
  branchName: string;
  state: { id: string; name: string; type: string };
  projectId: string | null;
  teamId: string;
  assigneeId: string | null;
  delegateId: string | null;
  labels: LinearLabel[];
  subscriberIds: string[];
  parent: { id: string; identifier: string } | null;
  children: { id: string; identifier: string; stateType: string }[];
  prerequisites: { id: string; identifier: string; stateType: string }[];
  attachments: { id: string; url: string; title: string }[];
}
export interface LinearComment {
  id: string;
  issueId: string;
  body: string;
  createdAt: string;
  parentId: string | null;
  userId: string | null;
  botActorId: string | null;
  externalUserId: string | null;
}
export interface LinearHistoryEntry {
  id: string;
  createdAt: string;
  actorId: string | null;
  botActorId: string | null;
  botActorType: string | null;
  addedLabelIds: string[];
  removedLabelIds: string[];
  fromStateId: string | null;
  toStateId: string | null;
}
export interface LinearTeamMeta {
  states: { id: string; name: string; type: string }[];
  labels: LinearLabel[];
}
export interface LinearPort {
  teamMeta(teamKey: string): Promise<LinearTeamMeta>;
  listCandidates(projectIds: string[], labelNames: string[]): Promise<LinearIssue[]>;
  listUpdatedSince(projectIds: string[], sinceIso: string): Promise<LinearIssue[]>;
  getIssues(ids: string[]): Promise<LinearIssue[]>;
  /** One issue by its identifier (`JRF-123`), or null: `doctor --notify-test <identifier>` (§7.5) names the scratch issue so. */
  issueByIdentifier(identifier: string): Promise<LinearIssue | null>;
  listComments(issueIds: string[], sinceIso: string): Promise<LinearComment[]>;
  issueHistory(issueId: string, sinceIso: string): Promise<LinearHistoryEntry[]>;
  updateIssue(
    issueId: string,
    input: { stateId?: string; labelIds?: string[]; subscriberIds?: string[] },
  ): Promise<void>;
  createComment(
    issueId: string,
    body: string,
    opts: { id: string; parentId?: string },
  ): Promise<{ id: string }>;
  updateComment(commentId: string, body: string): Promise<void>;
  createAttachment(issueId: string, url: string, title: string): Promise<void>;
  createIssue(input: {
    id: string;
    teamId: string;
    projectId: string | null;
    parentId: string;
    title: string;
    description: string;
    stateId: string;
  }): Promise<{ id: string; identifier: string }>;
  subscribe(issueId: string, userId: string): Promise<void>;
}

export interface AgentEntry {
  paneKey: string;
  state: string;
  agentType: string | null;
  stateStartedAt: string | null;
  updatedAt: string | null;
}
export interface FleetRow {
  worktreeId: string;
  repoId: string;
  path: string;
  branch: string;
  displayName: string;
  linkedLinearIssue: string | null;
  status: string;
  liveTerminalCount: number;
  lastOutputAt: string | null;
  childWorktreeIds: string[];
  agents: AgentEntry[];
  /** The repo's main checkout (R6: `doctor` reads Claude's folder trust for it); absent means false. */
  isMainWorktree?: boolean;
}
export interface FleetSnapshot {
  worktrees: FleetRow[];
  truncated: boolean;
  omittedHostIds: string[];
}
export interface TerminalRow {
  handle: string;
  tabId: string;
  leafId: string;
  worktreeId: string;
  title: string;
  lastOutputAt: string | null;
}
export interface UsageWindow {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: number | null;
}
export interface ProviderLimits {
  status: "ok" | "unavailable" | "error";
  error: string | null;
  updatedAt: number | null;
  windows: Record<string, UsageWindow>;
  buckets: { name: string; usedPercent: number; windowMinutes: number; resetsAt: number | null }[];
}
export type RateLimits = Record<string, ProviderLimits>;
export interface WorkerRow {
  dispatchId: string;
  taskId: string;
  runId: string;
  workerState: string;
  dispatchStatus: string;
  agentTerminalHandle: string | null;
  verdict: "live" | "unverifiable" | "exited" | null;
}
export interface SendReceipt {
  stage: "input_accepted" | "turn_started";
  requestId: string | null;
}
/**
 * An `automations list` row (spike results §4). `prompt`, `precheckCommand`, `precheckTimeoutSec` and `workspaceMode` are what
 * `doctor` diffs against the install (§4.3); a source that cannot report them leaves them out.
 */
export interface AutomationRow {
  id: string;
  name: string;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  prompt?: string | null;
  precheckCommand?: string | null;
  precheckTimeoutSec?: number | null;
  workspaceMode?: string | null;
}
export interface OrcaPort {
  worktreePs(): Promise<FleetSnapshot>;
  /**
   * `orca worktree current --json` run in `cwd` (spike §4: `result.worktree.{id, repoId, path, head}`): the worktree that directory is
   * in; `head` is the commit it is at, only as a full object id (R34), else null.
   */
  worktreeCurrent(
    cwd: string,
  ): Promise<{ repoId: string; worktreeId: string; path: string; head: string | null }>;
  terminalList(worktreeId: string): Promise<TerminalRow[]>;
  accountList(): Promise<RateLimits>;
  worktreeCreate(a: {
    repoId: string;
    name: string;
    baseBranch: string;
    linearIssue: string;
    comment: string;
  }): Promise<{ id: string; path: string }>;
  worktreeShow(id: string): Promise<{ id: string; path: string; branch: string; head: string }>;
  worktreeSet(
    id: string,
    a: { workspaceStatus?: string; comment?: string; linearIssue?: string | null },
  ): Promise<void>;
  worktreeRm(id: string): Promise<void>;
  terminalCreate(
    worktreeId: string,
    title: string,
    command: string,
  ): Promise<{ handle: string; tabId: string; leafId: string }>;
  terminalWait(
    handle: string,
    forWhat: "tui-idle" | "exit",
    timeoutMs: number,
  ): Promise<{ satisfied: boolean; blockedReason?: string }>;
  /** Raw keystrokes without --wait-submit; used only to answer Claude's folder-trust dialog (spike 2026-10-06 §3.2). */
  terminalKeys(handle: string, keys: { text?: string; enter?: boolean }): Promise<void>;
  terminalSend(
    handle: string,
    text: string,
    waitSubmitSec: number,
    retryRequest?: string,
  ): Promise<SendReceipt>;
  terminalClose(worktreeId: string): Promise<{ ok: boolean }>;
  terminalShowPreview(handle: string): Promise<string>;
  workerList(runId: string): Promise<WorkerRow[]>;
  workerStop(dispatchId: string, retryRequest: string): Promise<{ verdict: string }>;
  workerAbandon(dispatchId: string): Promise<void>;
  workerRelease(dispatchId: string): Promise<void>;
  orchestrationSend(to: string, subject: string, body: string): Promise<void>;
  runList(): Promise<{ id: string; coordinatorHandle: string | null }[]>;
  automationsList(): Promise<AutomationRow[]>;
  /** `orca automations create <flags>`: `flags` follow the verb (the client adds `automations create`). */
  automationsCreate(flags: string[]): Promise<{ id: string }>;
  /** `orca automations edit <id> <flags>`: `edit` accepts every flag `create` does (spike results §5). */
  automationsEdit(id: string, flags: string[]): Promise<void>;
}
export interface BranchHistory {
  paths: string[];
  added: { path: string; line: string }[];
  messages: string;
}
/**
 * C22 (§13.3 d): where a dispatcher git command runs — the issue worktree, its own gitdir (`<commonDir>/worktrees/<gitdirName>`) and
 * the repo's common dir, as the claim recorded them. The worktree's gitfile and its gitdir's `commondir` must still name these two,
 * and git runs with them pinned (`--git-dir`, `--work-tree`, `GIT_COMMON_DIR`). F1/F2: or the repository's main checkout, whose
 * `.git` directory is its git dir and its common dir both (`mainCheckoutTarget`).
 */
export interface GitTarget {
  readonly path: string;
  readonly gitDir: string;
  readonly commonDir: string;
}
export interface GitPort {
  revParse(t: GitTarget, ref: string): Promise<string>;
  /** Paths changed from `baseSha` to `head` (default `HEAD`), both sides of a rename, deletions and type changes included (§13.3 d). */
  changedPaths(t: GitTarget, baseSha: string, head?: string): Promise<string[]>;
  addedLines(t: GitTarget, baseSha: string, head?: string): Promise<{ path: string; line: string }[]>;
  commitsAhead(t: GitTarget, baseSha: string, head?: string): Promise<number>;
  /**
   * What a push of `head` sends beyond the net diff: every commit of `baseSha..head` not reachable from `since` (C26: the remote
   * branch's tip, when this worktree has that commit; a merge read against its first parent) — the paths each touched (both sides of
   * a rename, deletions and type changes included), the lines each added, and the commit messages.
   */
  historyChanges(t: GitTarget, baseSha: string, head: string, since?: string | null): Promise<BranchHistory>;
  /**
   * `git push -u <url> <sha>:refs/heads/<branch>` (C23: the configured GitHub URL, once `remote.origin.url` is proven to name the same
   * repository): exactly the commit the publish guards cleared, never forced. A non-fast-forward rejection is `push_rejected` (C26).
   */
  push(t: GitTarget, url: string, branch: string, sha: string): Promise<void>;
  /** The commit `refs/heads/<branch>` points at on `url`, or null when that branch is not there. */
  lsRemoteSha(t: GitTarget, url: string, branch: string): Promise<string | null>;
  /**
   * C30: the commit `sha` present in this repository — nothing when it is here already, else exactly that object fetched from `url`
   * (the configured GitHub URL): no ref moves, no FETCH_HEAD, no tags, no submodules, no maintenance. True when it fetched.
   */
  fetchCommit(t: GitTarget, url: string, sha: string): Promise<boolean>;
  /**
   * F3: whether commit `ancestor` is in the history of commit `descendant` (`git merge-base --is-ancestor`); null when git cannot tell
   * (an object it does not have). A clone that has not fetched holds an ancestor of GitHub's base; a rewritten ref need not.
   */
  isAncestor(t: GitTarget, ancestor: string, descendant: string): Promise<boolean | null>;
  /**
   * F7: the refs under `refs/replace/` (`git replace`), packed or loose, at most ten. Each makes git read another object wherever the
   * one it names is read — a commit, a tree, a file — while every ref and HEAD still name the original. Orca's `git worktree add`
   * honors them unless the repository's config says `core.useReplaceRefs=false` (R30); the dispatcher's own git never does
   * (DISPATCHER_GIT_ENV).
   */
  replaceRefs(t: GitTarget): Promise<string[]>;
  /**
   * R30: the refs whose last path component is `sha` — in any namespace (`refs/heads/`, `refs/tags/`, …), packed or loose, in any case
   * (a case-insensitive disk finds a loose ref so) — at most ten. Orca resolves a base given as a commit through `refs/heads/<commit>`.
   */
  refsNamedAfter(t: GitTarget, sha: string): Promise<string[]>;
  /**
   * R30 (D14): `core.useReplaceRefs` as the repository's own config file holds it (`<common>/config`), read as git reads a boolean;
   * null when unset. False there makes every git of the repository — Orca's `git worktree add` too — ignore refs/replace/.
   */
  useReplaceRefs(t: GitTarget): Promise<boolean | null>;
  /** R30: `core.useReplaceRefs=false` in the repository's own config, every earlier value replaced — the one setting `install` makes there. */
  disableReplaceRefs(t: GitTarget): Promise<void>;
  /**
   * SEC-2: the credential-bearing keys of the repository's own config, which an agent can read (its sandbox reads the common dir): any
   * `credential.*` key, and a remote URL or `insteadOf` rewrite whose URL carries a credential. Names only, never a value.
   */
  credentialConfig(t: GitTarget): Promise<string[]>;
}
/**
 * C29: `repo` is the configured `repos.<name>.github`. gh is told the repository (`--repo`) and runs outside every worktree, so it never
 * resolves the repository — or runs git — through a worktree's agent-writable links.
 */
export interface GhPort {
  prCreate(
    repo: string,
    a: { head: string; base: string; title: string; body: string; draft: boolean },
  ): Promise<{ number: number; url: string }>;
  prView(repo: string, number: number): Promise<{ state: string; headRefName: string; url: string }>;
}
