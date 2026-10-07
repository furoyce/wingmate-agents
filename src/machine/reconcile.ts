// src/machine/reconcile.ts — §6.1: reads only. Fleet, quota, candidates with verdicts, and the events a tick acts on.
import { join } from "node:path";
import { OrcaError } from "../orca/cli";
import { type Verdict, evaluateCandidate } from "../policy/eligibility";
import { orderCandidates } from "../policy/priority";
import type {
  FleetSnapshot,
  LinearComment,
  LinearHistoryEntry,
  LinearIssue,
  RateLimits,
  TerminalRow,
  WorkerRow,
} from "../ports";
import { readText } from "../state/fs";
import { type WRecord, listRecords } from "../state/records";
import { type CommentClass, classifyComment } from "./classify";
import type { Ctx } from "./context";
import { type Liveness, agentActiveAt, coordinatorLiveness, coordinatorRow } from "./liveness";

export type Event =
  | {
      type: "owner_state";
      identifier: string;
      stateType: string;
      stateName: string;
      authorized: boolean;
      at: string;
    }
  | {
      type: "owner_labels";
      identifier: string;
      lifecycle: string | null;
      agent: string[];
      authorized: boolean;
      at: string;
    }
  | { type: "comment"; identifier: string; commentId: string; cls: CommentClass; body: string; at: string }
  | { type: "answer"; identifier: string; commentId: string; questionId: string; body: string; at: string }
  | { type: "liveness"; identifier: string; liveness: Liveness }
  | { type: "attachment"; identifier: string; url: string };

export interface Candidate {
  issue: LinearIssue;
  verdict: Verdict;
}

export interface Reconciled {
  records: WRecord[];
  issuesById: Map<string, LinearIssue>;
  candidates: Candidate[];
  fleet: FleetSnapshot;
  terminals: Map<string, TerminalRow[]>;
  workers: Map<string, WorkerRow[]>;
  rateLimits: RateLimits;
  partial: boolean;
  liveness: Map<string, Liveness>;
  events: Event[];
  pausedScopes: string[];
}

const ACTIVE = new Set(["claimed", "working", "awaiting-human", "review", "blocked"]);
const EPOCH = "1970-01-01T00:00:00.000Z";
const ACTIVITY_MARGIN_SEC = 60;

async function readPausedScopes(ctx: Ctx): Promise<string[]> {
  const text = await readText(join(ctx.dirs.state, "pause.json"));
  if (!text) return [];
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) {
    throw new Error(`pause.json is not a string array: ${text.slice(0, 80)}`);
  }
  return parsed;
}

export async function reconcile(ctx: Ctx): Promise<Reconciled> {
  const records = await listRecords(ctx.dirs);
  const projectIds = Object.values(ctx.cfg.projects).map((p) => p.linearProject);
  const pausedScopes = await readPausedScopes(ctx);
  const [fleet, rateLimits] = await Promise.all([ctx.orca.worktreePs(), ctx.orca.accountList()]);
  const partial = fleet.truncated || fleet.omittedHostIds.length > 0;

  // Per active record: terminals, workers and liveness.
  const terminals = new Map<string, TerminalRow[]>();
  const workers = new Map<string, WorkerRow[]>();
  const liveness = new Map<string, Liveness>();
  for (const r of records) {
    if (!ACTIVE.has(r.stage) || !r.worktree) continue;
    const wt = r.worktree;
    const t = await ctx.orca.terminalList(wt.id);
    terminals.set(wt.id, t);
    if (r.coordinator.childRunId) {
      try {
        workers.set(r.coordinator.childRunId, await ctx.orca.workerList(r.coordinator.childRunId));
      } catch (e) {
        // F8: a Run Orca cannot list (deleted, never this issue's) makes only this record's liveness unverifiable (§5.5), never the tick
        if (!(e instanceof OrcaError)) throw e;
        ctx.log.warn({ issue: r.identifier, code: e.code }, "worker-list failed; liveness unverifiable");
        liveness.set(r.identifier, "unverifiable");
        continue;
      }
    }
    const row = fleet.worktrees.find((w) => w.worktreeId === wt.id);
    let preview: string | undefined;
    // INT-2: the coordinator's row as re-resolved this tick (a restart may have re-issued its handle and pane)
    const own = coordinatorRow(r, t, row);
    if (row && own && !row.agents.some((a) => a.paneKey === `${own.tabId}:${own.leafId}`)) {
      preview = await ctx.orca.terminalShowPreview(own.handle);
    }
    liveness.set(r.identifier, partial ? "unverifiable" : coordinatorLiveness(r, t, row, preview));
  }

  // Candidates (cheap pre-check first; history only for the eligible ones).
  const candidateLabels = [
    ...ctx.cfg.labels.agent.supported,
    ...ctx.cfg.labels.agent.unsupported,
    ctx.cfg.labels.agent.human,
  ];
  const activeRecords = records.filter((r) => ACTIVE.has(r.stage));
  const [cands, recorded] = await Promise.all([
    ctx.linear.listCandidates(projectIds, candidateLabels),
    activeRecords.length ? ctx.linear.getIssues(activeRecords.map((r) => r.linearId)) : Promise.resolve([]),
  ]);
  const issuesById = new Map<string, LinearIssue>();
  for (const i of [...cands, ...recorded]) issuesById.set(i.id, i);
  const labelIds = new Map(ctx.meta.labels.map((l) => [l.name, l.id]));
  const liveCoordinator = (r: WRecord) => {
    const l = liveness.get(r.identifier);
    return l === "working" || l === "idle" || l === "unverifiable";
  };
  const baseCtx = {
    cfg: ctx.cfg,
    agentLabelIds: labelIds,
    lifecycleGroupId: ctx.meta.lifecycleGroupId,
    agentGroupId: ctx.meta.agentGroupId,
    fleet,
    records,
    pausedScopes,
    liveCoordinator,
  };
  const candidates: Candidate[] = [];
  for (const issue of orderCandidates(cands)) {
    const pre = evaluateCandidate(issue, { ...baseCtx, history: null });
    if (pre.status !== "eligible") {
      candidates.push({ issue, verdict: pre });
      continue;
    }
    const history: LinearHistoryEntry[] = await ctx.linear.issueHistory(issue.id, EPOCH);
    candidates.push({ issue, verdict: evaluateCandidate(issue, { ...baseCtx, history }) });
  }

  // Events for active records: owner overrides, comments/answers, PR attachments, liveness.
  const events: Event[] = [];
  const approvers = ctx.cfg.workspace.approvers;
  // Comment window: from the oldest "last seen" across active records; a record that has not seen any
  // comment yet starts at its claim time (never at now, which would hide an answer already posted).
  const seenFrom = (r: WRecord) => r.linear.lastSeenCommentAt ?? r.claimedAt;
  const since = activeRecords.reduce<string | null>(
    (m, r) => (m === null || seenFrom(r) < m ? seenFrom(r) : m),
    null,
  );
  const comments: LinearComment[] =
    activeRecords.length && since !== null
      ? await ctx.linear.listComments(
          activeRecords.map((r) => r.linearId),
          since,
        )
      : [];
  const agentGroupLabelIds = new Set(
    ctx.meta.labels.filter((l) => l.parentId === ctx.meta.agentGroupId).map((l) => l.id),
  );
  const groupLabelIds = new Set([...ctx.meta.lifecycleIds, ...agentGroupLabelIds]);
  const humanLabelId = ctx.meta.labels.find((l) => l.name === ctx.cfg.labels.agent.human)?.id;
  for (const r of activeRecords) {
    const issue = issuesById.get(r.linearId);
    if (!issue) continue;
    const row = fleet.worktrees.find((w) => w.worktreeId === r.worktree?.id);
    const terms = r.worktree ? (terminals.get(r.worktree.id) ?? []) : [];
    const activeAt = (iso: string) => agentActiveAt(row, terms, iso, ACTIVITY_MARGIN_SEC);
    const hist = await ctx.linear.issueHistory(issue.id, r.linear.lastSeenUpdatedAt ?? r.claimedAt);
    // §7.4 authorship is resolved by WHAT changed, never by when the issue was last touched: the latest history
    // entry that produced the observed change must be an approver (or the GitHub integration) and no agent of
    // this issue may have been active at that entry's own time. No matching entry → not authorized.
    const latestEntry = (pred: (h: LinearHistoryEntry) => boolean): LinearHistoryEntry | undefined => {
      for (let i = hist.length - 1; i >= 0; i--) {
        const h = hist[i];
        if (h && pred(h)) return h;
      }
      return undefined;
    };
    const byApprover = (h: LinearHistoryEntry) =>
      !h.botActorId && !!h.actorId && approvers.includes(h.actorId);
    const authorizedBy = (h: LinearHistoryEntry | undefined) => {
      if (!h) return false;
      const byGithub = h.botActorType === "integration";
      return (byApprover(h) || byGithub) && !activeAt(h.createdAt);
    };
    if (issue.state.name !== r.linear.state) {
      const entry = latestEntry((h) => h.toStateId === issue.state.id);
      events.push({
        type: "owner_state",
        identifier: r.identifier,
        stateType: issue.state.type,
        stateName: issue.state.name,
        authorized: authorizedBy(entry),
        at: entry?.createdAt ?? issue.updatedAt,
      });
    }
    const life = issue.labels.find((l) => ctx.meta.lifecycleIds.has(l.id))?.name ?? null;
    const agents = issue.labels.filter((l) => l.parentId === ctx.meta.agentGroupId).map((l) => l.name);
    // The `human` label is the owner's kill switch (§7.4): report it even when the Lifecycle label is unchanged,
    // otherwise a release request that leaves Lifecycle alone would never reach the tick.
    const humanAdded = agents.includes(ctx.cfg.labels.agent.human);
    if (life !== r.linear.lifecycleLabel || humanAdded) {
      const entry = latestEntry(
        (h) =>
          h.addedLabelIds.some((id) => groupLabelIds.has(id)) ||
          h.removedLabelIds.some((id) => groupLabelIds.has(id)),
      );
      // §13.3(i): `human` is the owner's kill switch, "honored at the next tick". Stopping work is the safe direction, so an
      // approver adding it counts whatever an agent was doing at the time; the activity rule guards answers and closes.
      const humanEntry =
        humanAdded && humanLabelId ? latestEntry((h) => h.addedLabelIds.includes(humanLabelId)) : undefined;
      events.push({
        type: "owner_labels",
        identifier: r.identifier,
        lifecycle: life,
        agent: agents,
        authorized: humanEntry ? byApprover(humanEntry) : authorizedBy(entry),
        at: (humanEntry ?? entry)?.createdAt ?? issue.updatedAt,
      });
    }
    const fresh = comments
      .filter((x) => x.issueId === r.linearId && x.createdAt > seenFrom(r))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const c of fresh) {
      const cls = classifyComment(c, r, approvers, activeAt);
      if (cls === "ignore") continue;
      const openQuestion = r.questions.find((x) => x.status === "open");
      if (cls === "answer" && openQuestion) {
        events.push({
          type: "answer",
          identifier: r.identifier,
          commentId: c.id,
          questionId: openQuestion.id,
          body: c.body,
          at: c.createdAt,
        });
      } else {
        events.push({
          type: "comment",
          identifier: r.identifier,
          commentId: c.id,
          cls,
          body: c.body,
          at: c.createdAt,
        });
      }
    }
    const known = new Set(r.prs.map((p) => p.url));
    for (const a of issue.attachments) {
      if (/github\.com\/.+\/pull\/\d+/.test(a.url) && !known.has(a.url)) {
        events.push({ type: "attachment", identifier: r.identifier, url: a.url });
      }
    }
    const l = liveness.get(r.identifier);
    if (l) events.push({ type: "liveness", identifier: r.identifier, liveness: l });
  }

  return {
    records,
    issuesById,
    candidates,
    fleet,
    terminals,
    workers,
    rateLimits,
    partial,
    liveness,
    events,
    pausedScopes,
  };
}
