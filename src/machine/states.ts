// src/machine/states.ts — the only edges (§5.2.1; invariant I6 asserts this table) and the record mutations every step shares.
import { capMinFor } from "../policy/timers";
import { WingmateError } from "../shared/errors";
import type { PipelineStage, Stage, WRecord } from "../state/records";
import type { Ctx } from "./context";

/**
 * §5.2.1. `claimed` also takes the blocking causes of `working` that its flows can raise: a record is `claimed` between a handoff
 * and its successor's `turn_started` (§9.4), and integrity, timers and the handoff rule apply to it then too.
 */
export const TRANSITIONS: Record<Stage, Partial<Record<Stage, string[]>>> = {
  claimed: {
    working: ["turn_started"],
    blocked: [
      "launch_failed",
      "setup_failed",
      "base_mismatch", // C30 (Ruling R29): the base did not verify as GitHub's commit (F1/F2: before any create; F3: stale, diverged, unverifiable)
      "launch_not_ready",
      "owner_stop",
      "kit_tampered",
      "cascade_exhausted",
      "provider_unavailable",
      "grace_expired_no_cascade",
    ],
    claimed: ["handoff", "reroute"],
    released: ["override"],
    done: ["owner_done"],
    cancelled: ["owner_cancel"],
  },
  working: {
    "awaiting-human": ["ask"],
    review: ["finish_published"],
    claimed: ["handoff", "reroute"],
    blocked: [
      "cascade_exhausted",
      "provider_unavailable",
      "kit_tampered",
      "budget",
      "grace_expired_no_cascade",
      "owner_stop",
      "publish_guard",
    ],
    released: ["override"],
    done: ["owner_done"],
    cancelled: ["owner_cancel"],
  },
  "awaiting-human": {
    working: ["answer", "confirm_answer"],
    blocked: ["resume_failed", "self_answer_suspected", "worktree_gone", "owner_stop", "kit_tampered"],
    released: ["override"],
    done: ["owner_done"],
    cancelled: ["owner_cancel"],
  },
  review: {
    working: ["review_feedback"],
    released: ["override"],
    done: ["owner_done"],
    cancelled: ["owner_cancel"],
    blocked: ["owner_stop"],
  },
  blocked: {
    working: ["continue", "confirm_answer"],
    released: ["override"],
    done: ["owner_done"],
    cancelled: ["owner_cancel"],
  },
  released: {},
  done: {},
  cancelled: {},
};

export const isEdge = (from: Stage, to: Stage, cause: string): boolean =>
  (TRANSITIONS[from][to] ?? []).includes(cause);

/** Terminal for the current cycle (§5.2): `blocked` keeps its `continue` edge, the rest have none. */
export const TERMINAL: ReadonlySet<Stage> = new Set(["blocked", "released", "done", "cancelled"]);

/** The record's stage and worktree read afresh: steps mutate the record inside awaited calls, which narrowing cannot see. */
export const stageOf = (r: WRecord): Stage => r.stage;
export const worktreeOf = (r: WRecord): WRecord["worktree"] => r.worktree;

/** R20: `attention` is a set — a code is added only when absent, so a condition that persists across ticks never grows it. */
export function addAttention(r: WRecord, code: string): void {
  if (!r.attention.includes(code)) r.attention.push(code);
}
export function dropAttention(r: WRecord, ...codes: string[]): void {
  r.attention = r.attention.filter((a) => !codes.includes(a));
}

/** The one `attempts[]` entry of the current (cycle, attempt) (§5.1), recorded when its coordinator first took a turn. */
export function ensureAttempt(ctx: Ctx, r: WRecord): void {
  const c = r.coordinator;
  if (r.attempts.some((a) => a.cycle === r.cycle && a.attempt === c.attempt)) return;
  r.attempts.push({
    cycle: r.cycle,
    attempt: c.attempt,
    provider: r.provider,
    startedAt: ctx.now(),
    endedAt: null,
    outcome: null,
    reason: null,
    terminalHandle: c.terminalHandle,
  });
}

/** Ends the current attempt (handoff, reroute, release): the open entry gets its end time, outcome and reason. */
export function endAttempt(ctx: Ctx, r: WRecord, outcome: string, reason: string | null): void {
  const last = r.attempts[r.attempts.length - 1];
  if (last && !last.endedAt) {
    last.endedAt = ctx.now();
    last.outcome = outcome;
    last.reason = reason;
  }
}

/** §9.6: a new pipeline stage restarts its timers with that stage's own cap. */
export function enterPipelineStage(ctx: Ctx, r: WRecord, stage: PipelineStage): void {
  const t = ctx.cfg.projects[r.project]?.timers ?? ctx.cfg.defaults.timers;
  const now = ctx.now();
  r.pipelineStage = stage;
  r.timers.capMin = capMinFor(stage, t);
  r.timers.stageStartedAt = now;
  r.timers.lastActivityAt = now;
  r.timers.nudgedAt = null;
  r.timers.nudges = 0;
  r.timers.graceEndsAt = null;
  dropAttention(r, "cap_passed");
}

export async function transition(
  ctx: Ctx,
  r: WRecord,
  to: Stage,
  cause: string,
  evidence: string | null = null,
): Promise<void> {
  if (!isEdge(r.stage, to, cause))
    throw new WingmateError("illegal_transition", `${r.identifier}: ${r.stage} → ${to} (${cause})`);
  const from = r.stage;
  const at = ctx.now();
  r.coordinator.usageSampleAt = at;
  r.coordinator.usageSampleWorking = to === "working";
  r.stage = to;
  r.updatedAt = at;
  r.history.push({ at, from, to, cause, evidence });
  if (to === "working" || to === "claimed") {
    r.timers.stageStartedAt = at;
    r.timers.nudgedAt = null;
    r.timers.nudges = 0;
    r.timers.graceEndsAt = null;
    r.timers.lastActivityAt = at;
  }
  // I10: timers never run while parked, so a grace clock started before the ask does not survive it
  if (to === "awaiting-human") {
    r.timers.graceEndsAt = null;
    dropAttention(r, "cap_passed");
  }
  if (to === "review") r.linear.finishedAt = at;
  await ctx.ledger.append({
    at,
    issue: r.identifier,
    type: "transition",
    data: { from, to, cause, evidence },
  });
}
