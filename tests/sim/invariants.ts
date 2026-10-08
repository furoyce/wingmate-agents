// tests/sim/invariants.ts — §14.3 invariants I1–I10, asserted after every simulated tick (runTick) and at the end of scenarios.
import { expect } from "bun:test";
import { type Liveness, coordinatorLiveness, roleHandles } from "../../src/machine/liveness";
import { isEdge } from "../../src/machine/states";
import type { TickSummary } from "../../src/machine/tick";
import type { JournalEntry } from "../../src/state/journal";
import { type Stage, type WRecord, listRecords } from "../../src/state/records";
import type { World } from "../fakes/world";

const ACTIVE = new Set(["claimed", "working", "awaiting-human", "review", "blocked"]);
const WORKING = new Set(["claimed", "working"]);
/** §11.2: the only state moves Wingmate makes — Todo → In Progress at claim, In Progress → In Review at finish. */
const STATE_MOVES = new Set(["st-todo->st-prog", "st-prog->st-review"]);
const AGENT_CALLS = new Set(["terminalCreate", "terminalSend", "terminalKeys", "orchestrationSend"]);

export interface Snapshot {
  records: WRecord[];
  calls: number;
  liveness: Map<string, Liveness>;
  ledger: Map<string, number>;
}

/** What the tick will see: records, the Orca call count, each active record's liveness (as reconcile computes it) and ledger sizes. */
export async function snapshot(w: World): Promise<Snapshot> {
  const records = await listRecords(w.dirs);
  const liveness = new Map<string, Liveness>();
  const ledger = new Map<string, number>();
  for (const r of records) {
    ledger.set(r.identifier, (await w.ctx.ledger.readIssue(r.identifier)).length);
    if (!ACTIVE.has(r.stage) || !r.worktree) continue;
    const row = w.orca.rows.get(r.worktree.id);
    const terms = w.orca.terminals.get(r.worktree.id) ?? [];
    const handle = r.coordinator.terminalHandle;
    const preview =
      row && handle && !row.agents.some((a) => a.paneKey === r.coordinator.paneKey)
        ? (w.orca.previews.get(handle) ?? "")
        : undefined;
    const roles = roleHandles(r, w.orca.workers, terms);
    liveness.set(
      r.identifier,
      w.orca.partial ? "unverifiable" : coordinatorLiveness(r, terms, row, preview, roles),
    );
  }
  return { records: structuredClone(records), calls: w.orca.calls.length, liveness, ledger };
}

/** The journal key a Linear write maps to (Appendix D): Wingmate ids for creates, the comment id for edits, the input for updates. */
function writeKey(kind: string, args: unknown): string {
  const a = args as Record<string, unknown> & { opts?: { id?: string }; input?: unknown };
  switch (kind) {
    case "issueUpdate":
      return `issueUpdate:${JSON.stringify(a.input)}`;
    case "commentCreate":
      return `commentCreate:${a.opts?.id}`;
    case "commentUpdate":
      return `commentUpdate:${String(a.id)}`;
    case "subscribe":
      return `subscribe:${String(a.userId)}`;
    case "attachment":
      return `attachmentLinkURL:${String(a.url)}`;
    case "issueCreate":
      return `issueCreate:${String(a.id)}`;
    default:
      return `${kind}:?`;
  }
}
function entryKey(e: JournalEntry): string {
  const i = e.input as Record<string, unknown>;
  switch (e.kind) {
    case "issueUpdate":
      return `issueUpdate:${JSON.stringify(i)}`;
    case "commentCreate":
    case "issueCreate":
      return `${e.kind}:${String(i.id)}`;
    case "commentUpdate":
      return `commentUpdate:${String(i.commentId)}`;
    case "subscribe":
      return `subscribe:${String(i.owner)}`;
    case "attachmentLinkURL":
      return `attachmentLinkURL:${String(i.url)}`;
    default:
      return `${e.kind}:${e.key}`;
  }
}
const count = (keys: string[]) =>
  keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>());

/**
 * I2, as slice 1 builds it (F9): no Linear write without a journal entry that reached confirmed, and no entry left acted or poisoned.
 * Orca mutations are ledgered rather than journaled (`JOURNAL_KINDS` reserves their kinds; `--retry-request` replay is not built),
 * so for Orca this asserts what the journal and the record guarantee instead: every worktree create belongs to a claim entry, and no
 * worktree is ever removed twice.
 */
async function assertJournal(w: World): Promise<void> {
  const journal = await w.ctx.journal.all();
  expect(
    journal.filter((e) => e.state === "acted" || e.state === "poisoned").map((e) => `${e.kind}:${e.key}`),
  ).toEqual([]);
  const confirmed = count(journal.filter((e) => e.state === "confirmed").map(entryKey));
  const writes = count(w.linear.writes.map((x) => writeKey(x.kind, x.args)));
  const unjournaled = [...writes].filter(([k, n]) => n > (confirmed.get(k) ?? 0)).map(([k]) => k);
  expect(unjournaled).toEqual([]);
  for (const c of w.orca.calls.filter((x) => x.verb === "worktreeCreate")) {
    const issue = (c.args as { linearIssue: string }).linearIssue;
    // an issue worktree; `install`'s dispatcher worktree and `doctor`'s probe worktree belong to no issue (Task 12)
    if (issue) expect(journal.some((e) => e.kind === "claim" && e.issue === issue)).toBe(true);
  }
  const removed = w.orca.removed; // removals that took effect (a call that failed before acting may be retried)
  expect(removed.filter((id, i) => removed.indexOf(id) !== i)).toEqual([]);
}

/** I5: Wingmate's issue writes only replace Lifecycle labels and only make the two §11.2 state moves. */
function assertOwnerIntent(w: World): void {
  const lifecycle = new Set(w.linear.meta.labels.filter((l) => l.parentId === "grp-life").map((l) => l.id));
  for (const iw of w.linear.issueWrites) {
    const kept = iw.before.labelIds.filter((id) => !lifecycle.has(id));
    expect(kept.filter((id) => !iw.after.labelIds.includes(id))).toEqual([]);
    if (iw.before.stateId !== iw.after.stateId)
      expect(STATE_MOVES.has(`${iw.before.stateId}->${iw.after.stateId}`)).toBe(true);
  }
}

function assertRecord(w: World, r: WRecord): void {
  for (const h of r.history) // I6
    expect({
      r: r.identifier,
      edge: `${h.from} -> ${h.to} (${h.cause})`,
      legal: isEdge(h.from as Stage, h.to as Stage, h.cause),
    }).toMatchObject({ legal: true });
  if (r.worktree) {
    // I1: at most one live coordinator per issue worktree — a terminal running a live Claude or Codex agent that is no role agent of
    // the child Run and no session of the owner's own (N3: Orca lists the title the agent set, so titles prove nothing)
    const roles = new Set([
      ...(r.coordinator.childRunId ? (w.orca.workers.get(r.coordinator.childRunId) ?? []) : []).map(
        (x) => x.agentTerminalHandle,
      ),
      ...w.orca.foreignAgents,
      ...w.orca.roleTerminals,
      ...roleHandles(r, w.orca.workers, w.orca.terminals.get(r.worktree.id) ?? []),
    ]);
    const agents = new Set(
      (w.orca.rows.get(r.worktree.id)?.agents ?? [])
        .filter((a) => a.agentType === "claude" || a.agentType === "codex")
        .map((a) => a.paneKey),
    );
    const coordinators = (w.orca.terminals.get(r.worktree.id) ?? []).filter(
      (t) => agents.has(`${t.tabId}:${t.leafId}`) && !roles.has(t.handle),
    );
    expect(coordinators.length).toBeLessThanOrEqual(1);
  }
  // I4: exactly one status comment (once one exists) and at most one completion comment per issue
  const status = w.linear.comments.filter(
    (c) => c.issueId === r.linearId && c.body.startsWith("<!-- wingmate:status -->"),
  );
  expect(status.length).toBeLessThanOrEqual(1);
  if (r.linear.statusCommentId) expect(status.map((c) => c.id)).toEqual([r.linear.statusCommentId]);
  const completion = w.linear.comments.filter(
    (c) => c.issueId === r.linearId && c.body.startsWith("<!-- wingmate:completion -->"),
  );
  expect(completion.length).toBeLessThanOrEqual(1);
  if (r.stage === "awaiting-human") expect(r.timers.graceEndsAt).toBeNull(); // I10
}

function agentCallsFor(w: World, since: number, r: WRecord, prior: WRecord | undefined) {
  const handles = new Set([r.coordinator.terminalHandle, prior?.coordinator.terminalHandle].filter(Boolean));
  const runs = new Set(
    [r.coordinator.childRunId, prior?.coordinator.childRunId].filter(Boolean).map((x) => `run:${x}`),
  );
  return w.orca.calls.slice(since).filter((c) => {
    if (!AGENT_CALLS.has(c.verb)) return false;
    const a = c.args as { wt?: string; h?: string; to?: string };
    return (
      a.wt === r.worktree?.id ||
      (a.h !== undefined && handles.has(a.h)) ||
      (a.to !== undefined && runs.has(a.to))
    );
  });
}

/** I3, I7, I8 and I10 need the tick's own before and after. */
async function assertTick(
  w: World,
  records: WRecord[],
  t: { pre: Snapshot; summary: TickSummary },
): Promise<void> {
  const before = new Map(t.pre.records.map((r) => [r.identifier, r]));
  for (const r of records) {
    const prior = before.get(r.identifier);
    if (prior?.stage === "awaiting-human" && r.stage === "awaiting-human") {
      // I3: parked and still parked → nothing reached the agent, unless it was the delivery of a verified answer whose turn
      // is not confirmed yet (§7.1 step 4: resume_unconfirmed, re-evaluated next tick)
      const fresh = (await w.ctx.ledger.readIssue(r.identifier)).slice(t.pre.ledger.get(r.identifier) ?? 0);
      const answering = fresh.some(
        (e) => e.data.kind === "answer" || (e.type === "relaunch" && e.data.reason === "answer"),
      );
      if (!answering) expect(agentCallsFor(w, t.pre.calls, r, prior)).toEqual([]);
      expect(r.timers).toEqual(prior.timers); // I10: timers never advance while parked
    }
    if (t.pre.liveness.get(r.identifier) === "unverifiable") {
      // I8: unverifiable liveness never causes a stop, relaunch, handoff or a liveness/timer block
      const fresh = (await w.ctx.ledger.readIssue(r.identifier)).slice(t.pre.ledger.get(r.identifier) ?? 0);
      expect(fresh.filter((e) => e.type === "relaunch").length).toBe(0);
      const causes = fresh.filter((e) => e.type === "transition").map((e) => String(e.data.cause));
      expect(
        causes.filter((c) => ["handoff", "cascade_exhausted", "grace_expired_no_cascade"].includes(c)),
      ).toEqual([]);
      expect(
        w.orca.calls
          .slice(t.pre.calls)
          .filter((c) => c.verb === "terminalCreate" && (c.args as { wt: string }).wt === r.worktree?.id),
      ).toEqual([]);
    }
  }
  if (!t.summary.claims.length) return;
  // I7: caps are never exceeded by a claim (resumes may exceed them; a tick that claimed saw every resume first)
  const cfg = w.cfg;
  const working = records.filter((r) => WORKING.has(r.stage));
  expect(working.length).toBeLessThanOrEqual(cfg.defaults.concurrency.maxWorking.global);
  expect(
    records.filter((r) => WORKING.has(r.stage) || r.stage === "awaiting-human").length,
  ).toBeLessThanOrEqual(cfg.defaults.concurrency.maxInFlight);
  for (const id of t.summary.claims) {
    const r = records.find((x) => x.identifier === id);
    if (!r) continue;
    const c = cfg.projects[r.project]?.concurrency ?? cfg.defaults.concurrency;
    expect(working.filter((x) => x.project === r.project).length).toBeLessThanOrEqual(
      c.maxWorking.perProject,
    );
    expect(working.filter((x) => x.provider === r.provider).length).toBeLessThanOrEqual(
      c.maxWorking.perProvider,
    );
  }
  const live = [...w.orca.rows.values()].filter((row) => row.displayName.startsWith("wm-")).length;
  expect(live).toBeLessThanOrEqual(cfg.defaults.concurrency.maxLiveWorktrees);
}

export async function assertInvariants(w: World, t?: { pre: Snapshot; summary: TickSummary }): Promise<void> {
  const records = await listRecords(w.dirs);
  for (const r of records) assertRecord(w, r);
  await assertJournal(w);
  assertOwnerIntent(w);
  // I9: every push is a publish the guards cleared (Task 11 opens the publish journal entry only after runGuards passes)
  const journal = await w.ctx.journal.all();
  for (const p of w.git.pushed) {
    const r = records.find((x) => x.worktree && p.startsWith(`${x.worktree.path}:`));
    expect(journal.some((e) => e.kind === "publish" && e.issue === r?.identifier)).toBe(true);
  }
  if (t) await assertTick(w, records, t);
}

/** I3 for a window of a scenario: no launch, resume, keystroke or send reached the parked issue's terminals or Run. */
export function noAgentActivityWhileParked(w: World, sinceCallIndex: number, identifier: string): void {
  const rows = [...w.orca.rows.values()].filter((row) => row.linkedLinearIssue === identifier);
  const wts = new Set(rows.map((row) => row.worktreeId));
  const handles = new Set(
    rows.flatMap((row) => (w.orca.terminals.get(row.worktreeId) ?? []).map((t) => t.handle)),
  );
  const calls = w.orca.calls.slice(sinceCallIndex).filter((c) => {
    if (!AGENT_CALLS.has(c.verb)) return false;
    const a = c.args as { wt?: string; h?: string; title?: string };
    return (
      (a.wt !== undefined && wts.has(a.wt)) ||
      (a.h !== undefined && handles.has(a.h)) ||
      JSON.stringify(c.args).includes(identifier)
    );
  });
  expect(calls).toEqual([]);
}
