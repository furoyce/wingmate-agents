// src/machine/advance.ts — §6.3 for every active record, in order: owner overrides, unfinished claim steps (§6.6 replay), the outbox,
// answers and comments, liveness, timers, kit integrity, budgets. Each record is processed under its lock and in isolation: one
// record's failure is reported and the tick moves on (its state is as a crash would leave it, which the journal replays).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readIntentFiles } from "../kit/intents";
import { resolveTier } from "../policy/providers";
import { errorCode, errorText } from "../shared/errors";
import { stopRequested } from "../state/heartbeat";
import { withRecordLock } from "../state/lock";
import { readRecord, writeRecord } from "../state/records";
import { claimLinear, provisionAndLaunch } from "./claim";
import type { Ctx } from "./context";
import { isTickAbort } from "./guard";
import { doHandoff, doReroute } from "./handoff";
import { comments, reviewFeedback } from "./humans";
import { LinearWrites } from "./linearWrites";
import { syncMirror } from "./mirror";
import { executeOutbox } from "./outbox";
import type { Event, Reconciled } from "./reconcile";
import { block, release, stopAgents } from "./release";
import { addAttention, dropAttention, stageOf } from "./states";
import { addNote, flushNotes, syncStatus } from "./status";
import { type Advance, type StepOut, WORKING } from "./step";
import type { Budget, TickSummary } from "./tick";
import { timers, budgets, integrity, liveness } from "./watch";

const ACTIVE = new Set(["claimed", "working", "awaiting-human", "review", "blocked"]);
const CLOSED = new Set(["completed", "canceled", "duplicate"]);
const LABEL_FOR: Record<string, string> = {
  claimed: "In-Agent",
  working: "In-Agent",
  "awaiting-human": "Needs-Human",
  review: "Review-Ready",
  blocked: "Blocked",
};
const CODE = /^[a-z_]+(\([A-Za-z0-9_,.:-]*\))?$/;
type StateEvent = Extract<Event, { type: "owner_state" }>;
type LabelsEvent = Extract<Event, { type: "owner_labels" }>;

const lifecycleOf = (a: Advance) =>
  a.issue.labels.find((l) => a.ctx.meta.lifecycleIds.has(l.id))?.name ?? null;

/** Whether the latest unconfirmed close is the one already flagged (§7.4: the owner confirms or reopens; a re-read never does). */
async function stillFlagged(a: Advance, st: StateEvent): Promise<boolean> {
  if (!a.r.attention.includes("possible_self_close")) return false;
  const flagged = (await a.ctx.ledger.readIssue(a.r.identifier))
    .filter((e) => e.type === "possible_self_close")
    .at(-1)?.data.at;
  return typeof flagged === "string" && st.at <= flagged;
}

async function releaseFor(
  a: Advance,
  cause: "override" | "owner_done" | "owner_cancel",
  comment: string | null,
) {
  if (await release(a.ctx, a.r, a.issue, cause, comment))
    (cause === "override" ? a.s.released : a.s.done).push(a.r.identifier);
  a.dirty = true;
  return "stop" as const;
}

async function stateOverride(a: Advance, st: StateEvent): Promise<StepOut> {
  const { ctx, r } = a;
  const closing = CLOSED.has(st.stateType);
  if (!st.authorized || (closing && (await stillFlagged(a, st)))) {
    if (!closing) {
      addAttention(r, "unauthorized_state_change"); // ignored, surfaced (§7.4)
      r.linear.state = st.stateName;
      return "stop";
    }
    // Done/Canceled while an agent was active: stop once, keep record and worktree; the mirror keeps the old state, so the
    // close stays visible and only a newer close by an approver (after a reopen) releases the issue
    if (!r.attention.includes("possible_self_close")) {
      addAttention(r, "possible_self_close");
      await ctx.ledger.append({
        at: ctx.now(),
        issue: r.identifier,
        type: "possible_self_close",
        data: { at: st.at },
      });
      const { unverifiable } = await stopAgents(ctx, r);
      if (unverifiable.length) addAttention(r, "release_unverifiable(terminals)");
      a.dirty = true;
    }
    return "stop";
  }
  if (st.stateType === "completed") return releaseFor(a, "owner_done", null);
  if (closing) return releaseFor(a, "owner_cancel", null);
  if (r.stage === "review" && st.stateType === "started" && st.stateName !== "In Review")
    return reviewFeedback(a, st.stateName);
  if (
    (st.stateType === "unstarted" || st.stateType === "backlog") &&
    ["working", "claimed", "awaiting-human"].includes(r.stage)
  )
    return releaseFor(a, "override", "Wingmate released this issue because it was moved out of In Progress.");
  r.linear.state = st.stateName;
  return "next";
}

async function labelOverride(a: Advance, lb: LabelsEvent): Promise<StepOut> {
  const { ctx, r } = a;
  if (!lb.authorized) {
    addAttention(r, "unauthorized_label_change");
    return "next";
  }
  if (lb.agent.includes(ctx.cfg.labels.agent.human))
    return releaseFor(a, "override", "Wingmate released this issue because the `human` label was added.");
  if (r.paused && (lb.lifecycle === null || lb.lifecycle === "Ready")) {
    r.paused = false;
    r.linear.pausedWith = null;
    const now = ctx.now(); // §9.6: timers restart when the issue resumes
    Object.assign(r.timers, {
      stageStartedAt: now,
      lastActivityAt: now,
      nudgedAt: null,
      nudges: 0,
      graceEndsAt: null,
    });
    await new LinearWrites(ctx).setLifecycle(r, a.issue, LABEL_FOR[r.stage] ?? "In-Agent");
    addNote(r, "unpaused by owner");
    a.dirty = true;
    return "next";
  }
  const pausing =
    lb.lifecycle === "Blocked" || (lb.lifecycle === "Needs-Human" && r.stage !== "awaiting-human");
  if (!r.paused && pausing && ["working", "claimed", "review"].includes(r.stage)) {
    r.paused = true;
    r.linear.pausedWith = lb.lifecycle;
    r.linear.lifecycleLabel = lb.lifecycle;
    addNote(r, `paused by owner (${lb.lifecycle})`);
    a.dirty = true;
    return "next";
  }
  if (!r.paused && lb.lifecycle === null && r.linear.lifecycleLabel !== null && r.stage !== "blocked")
    return releaseFor(a, "override", "Wingmate released this issue because its lifecycle label was removed.");
  if (r.stage === "blocked" && lb.lifecycle === null) r.linear.lifecycleLabel = null; // "blocked — move to Todo to re-queue"
  return "next";
}

/** §6.3 step 1 (§7.4); R20: once the record's mirror matches the issue again, its history window starts at the issue's updatedAt. */
async function overrides(a: Advance): Promise<StepOut> {
  const st = a.evs.find((e): e is StateEvent => e.type === "owner_state");
  const lb = a.evs.find((e): e is LabelsEvent => e.type === "owner_labels");
  if (!st) dropAttention(a.r, "possible_self_close"); // reopened (or never closed): nothing left to confirm
  if (st && (await stateOverride(a, st)) === "stop") return "stop";
  if (lb && (await labelOverride(a, lb)) === "stop") return "stop";
  if (a.issue.state.name === a.r.linear.state && lifecycleOf(a) === a.r.linear.lifecycleLabel)
    a.r.linear.lastSeenUpdatedAt = a.issue.updatedAt;
  return a.r.paused ? "stop" : "next"; // paused: no outbox, resume, relaunch, nudge or timers (§7.4)
}

/** §6.6 replay of an unfinished claim (or reroute) entry: the same steps again; a second failure blocks (`launch_failed`). */
async function replayClaim(a: Advance): Promise<StepOut> {
  const { ctx, r } = a;
  if (r.stage !== "claimed" || a.ro) return "next";
  const open = (await ctx.journal.pending()).find((e) => e.issue === r.identifier && e.kind === "claim");
  if (!open) return "next";
  if (open.attempts >= 2) {
    await ctx.journal.abandon(open.id, "launch_failed");
    const next = "check Orca, then move the issue back to Todo to re-queue it";
    await block(ctx, r, a.issue, "launch_failed", `a claim step failed ${open.attempts} times`, next);
    a.s.blocked.push(r.identifier);
    a.dirty = true;
    return "stop";
  }
  if (a.budget.resumes <= 0) return "stop";
  const l = r.coordinator.launch;
  const tier =
    l.model && l.effort
      ? { model: l.model, effort: l.effort }
      : await resolveTier(r.provider, { home: ctx.home });
  if (!tier) {
    addAttention(r, "model_unresolved");
    return "stop";
  }
  a.budget.resumes -= 1;
  try {
    if (open.steps.find((x) => x.name === "linear")?.state === "pending")
      await claimLinear(ctx, r, a.issue, open.id);
    await provisionAndLaunch(ctx, r, a.issue, a.project, open.id, tier);
    if (stageOf(r) === "working") a.s.resumes.push(r.identifier);
  } catch (e) {
    if (isTickAbort(e)) throw e;
    await ctx.journal.failed(open.id, errorText(e));
    r.coordinator.launchRetries += 1;
    addAttention(r, "claim_step_failed");
    ctx.log.warn({ issue: r.identifier, code: errorCode(e), err: errorText(e) }, "claim replay failed");
  }
  a.launched = true;
  a.dirty = true;
  return "stop";
}

/** §6.3 step 2; a `handoff` intent is performed here (one per tick, none in reconcile-only ticks — it stays pending otherwise). */
async function outbox(a: Advance): Promise<StepOut> {
  const { ctx, r } = a;
  if (!WORKING.has(r.stage) || !r.worktree) return "next";
  const o = await executeOutbox(ctx, r, a.issue, a.rec, { canHandoff: !a.ro && a.budget.handoffs > 0 });
  if (o.parked) a.s.parked.push(r.identifier);
  if (o.finished) a.s.finished.push(r.identifier);
  if (o.handoff) {
    a.budget.handoffs -= 1;
    const reason = o.handoff.payload.reason.slice(0, 120);
    if (o.handoff.payload.repo) await doReroute(a, o.handoff.payload.repo);
    else await doHandoff(a, "agent_request", /^[\w .,:-]*$/.test(reason) ? reason : null);
    a.launched = true;
    a.dirty = true;
    return "stop";
  }
  return o.parked || o.finished || !WORKING.has(r.stage) ? "stop" : "next";
}

const STEPS = [overrides, replayClaim, outbox, comments, liveness, timers, integrity, budgets];

/** The mirror, the record, then the status comment when a tick-level change made it stale (once per tick, Ruling R1). */
async function settle(a: Advance, before: string[]): Promise<void> {
  const { ctx, r } = a;
  await syncMirror(r);
  await writeRecord(ctx.dirs, r);
  if (a.dirty) {
    await syncStatus(ctx, r, a.issue);
    await writeRecord(ctx.dirs, r);
  } else await flushNotes(ctx, r);
  for (const code of r.attention)
    if (!before.includes(code))
      a.s.attention.push({
        identifier: r.identifier,
        code: CODE.test(code) ? code : (code.split("(")[0] ?? "attention"),
      });
}

async function advanceLocked(ctx: Ctx, rec: Reconciled, identifier: string, s: TickSummary, budget: Budget) {
  const r0 = rec.records.find((x) => x.identifier === identifier);
  const r = await readRecord(ctx.dirs, identifier);
  // written by another process (stop, Console) since reconcile read it: the events no longer apply; next tick re-derives
  if (!r || !r0 || JSON.stringify(r) !== JSON.stringify(r0)) {
    await ctx.ledger.append({ at: ctx.now(), issue: identifier, type: "record_changed", data: {} });
    return;
  }
  const issue = rec.issuesById.get(r.linearId);
  const project = ctx.cfg.projects[r.project];
  if (!issue || !project) {
    await ctx.ledger.append({
      at: ctx.now(),
      issue: identifier,
      type: "record_skipped",
      data: { issue: !!issue, project: !!project },
    });
    return;
  }
  const a: Advance = {
    ctx,
    rec,
    r,
    issue,
    s,
    budget,
    project,
    evs: rec.events.filter((e) => e.identifier === identifier),
    live: rec.liveness.get(identifier),
    ro: s.reconcileOnly,
    launched: false,
    dirty: false,
  };
  const before = [...r.attention];
  for (const step of STEPS) if ((await step(a)) === "stop") break;
  await settle(a, before);
}

export async function advanceAll(ctx: Ctx, rec: Reconciled, s: TickSummary, budget: Budget): Promise<void> {
  for (const r0 of rec.records) {
    if (!ACTIVE.has(r0.stage)) continue;
    if (await stopRequested(ctx.dirs, r0.project, r0.identifier)) {
      s.skipped.push({ identifier: r0.identifier, reason: "stop_requested" });
      continue;
    }
    try {
      await withRecordLock(ctx.dirs, r0.identifier, () => advanceLocked(ctx, rec, r0.identifier, s, budget));
    } catch (e) {
      if (isTickAbort(e)) throw e;
      s.attention.push({ identifier: r0.identifier, code: "tick_error" });
      const data = { code: errorCode(e), message: errorText(e).slice(0, 300) };
      await ctx.ledger.append({ at: ctx.now(), issue: r0.identifier, type: "tick_error", data });
      ctx.log.error({ issue: r0.identifier, code: data.code, err: data.message }, "record step failed");
    }
  }
}

/** `scan` / `--dry-run`: what the advance would act on, counted without touching anything. */
export async function planOnly(rec: Reconciled, s: TickSummary): Promise<void> {
  const byId = new Map(rec.records.map((r) => [r.identifier, r]));
  let actionable = 0;
  let pendingIntents = 0;
  for (const e of rec.events) {
    const r = byId.get(e.identifier);
    if (e.type === "owner_state" || e.type === "owner_labels" || e.type === "answer") actionable += 1;
    else if (e.type === "comment" && e.cls !== "ignore" && e.cls !== "unverified_author") actionable += 1;
    else if (e.type === "liveness" && e.liveness === "exited" && r && WORKING.has(r.stage)) actionable += 1;
  }
  for (const r of rec.records) {
    if (!r.worktree || !WORKING.has(r.stage) || !existsSync(join(r.worktree.path, ".wingmate", "outbox")))
      continue;
    pendingIntents += (await readIntentFiles(r.worktree.path)).intents.length;
  }
  s.counts.actionable = actionable + pendingIntents;
  s.counts.pendingIntents = pendingIntents;
}
