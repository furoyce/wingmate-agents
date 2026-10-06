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
export interface OrcaPort {
  worktreePs(): Promise<FleetSnapshot>;
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
  automationsList(): Promise<
    { id: string; name: string; enabled: boolean; nextRunAt: number | null; lastRunAt: number | null }[]
  >;
  automationsCreate(args: string[]): Promise<{ id: string }>;
  automationsEdit(id: string, args: string[]): Promise<void>;
}
export interface GitPort {
  revParse(cwd: string, ref: string): Promise<string>;
  commonDir(cwd: string): Promise<string>;
  changedPaths(cwd: string, baseSha: string): Promise<string[]>;
  addedLines(cwd: string, baseSha: string): Promise<{ path: string; line: string }[]>;
  commitsAhead(cwd: string, baseSha: string): Promise<number>;
  push(cwd: string, branch: string): Promise<void>;
  lsRemoteSha(cwd: string, branch: string): Promise<string | null>;
}
export interface GhPort {
  prCreate(
    cwd: string,
    a: { head: string; base: string; title: string; body: string; draft: boolean },
  ): Promise<{ number: number; url: string }>;
  prView(cwd: string, number: number): Promise<{ state: string; headRefName: string; url: string }>;
}
