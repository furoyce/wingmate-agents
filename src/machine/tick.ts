// src/machine/tick.ts — one dispatcher tick (§6): lock, reconcile, advance every active record, clean up, claim within caps,
// queue + heartbeat. Bounded per §4.3; the summary carries identifiers, enumerated codes and counts only.
import { join } from "node:path";
import type { Config } from "../config/schema";
import { OrcaError } from "../orca/cli";
import { type QuotaNotices, launchableProviders, quotaAttention } from "../policy/quota";
import { errorCode, errorText } from "../shared/errors";
import { writeAtomic } from "../state/fs";
import { type Heartbeat, readLastTick, stopRequested, writeHeartbeat } from "../state/heartbeat";
import { TickLock } from "../state/lock";
import { writeQueue } from "../state/queue";
import { advanceAll, planOnly } from "./advance";
import { claimCandidates } from "./claims";
import { cleanup } from "./cleanup";
import type { Ctx, TickDeadline } from "./context";
import { TickAbort, guardedCtx, isTickAbort } from "./guard";
import { type Reconciled, reconcile } from "./reconcile";

export interface TickSummary {
  at: string;
  outcome: Heartbeat["outcome"];
  reason: string | null;
  reconcileOnly: boolean;
  claims: string[];
  resumes: string[];
  relaunches: string[];
  handoffs: string[];
  blocked: string[];
  released: string[];
  done: string[];
  parked: string[];
  finished: string[];
  skipped: { identifier: string; reason: string }[];
  attention: { identifier: string; code: string }[];
  /** F10 (§9.1): availability()'s advisory codes per provider the config can start (`quota_stale`) with the snapshot's age; `{}` when none. */
  quota: QuotaNotices;
  counts: Record<string, number>;
  durationMs: number;
}
export interface TickOptions {
  /** Plan only (`scan`, `tick --dry-run`): reads, the queue plan and the summary; no record, Linear or Orca write. */
  dryRun: boolean;
  precheck: boolean;
  /** The tick lock's heartbeat period (tests shorten it; production keeps 30 s). */
  lockHeartbeatMs?: number;
  /** REL-1: when the precheck process began (epoch ms; `tickCommand` passes it), so the deadline covers the context build too. */
  startedAt?: number;
  /** REL-1: the deadline itself (tests inject one with their own clock); absent → `startedAt` + `tickBudgetMs`. */
  deadline?: TickDeadline;
}
/** §4.3 per-tick bounds beyond claims: resumes and relaunches together, and one handoff. */
export interface Budget {
  resumes: number;
  handoffs: number;
}

const CADENCE_MS = 5 * 60_000;
/**
 * REL-1: what a tick leaves of the precheck timeout — for its own end (heartbeat, queue, lock) and for an external call already in
 * flight when the deadline passes. With the default 240 s precheck the tick's budget is §4.3's 180 s (Ruling R10).
 */
const DEADLINE_MARGIN_SEC = 60;
export const tickBudgetMs = (cfg: Config): number =>
  Math.max(30, cfg.defaults.dispatcher.precheckTimeoutSec - DEADLINE_MARGIN_SEC) * 1000;
/** §4.3: the precheck exits 1 after acting or when idle, 2 on error or pause (never 0: the automation's agent must never start). */
const EXIT_2 = new Set<Heartbeat["outcome"]>(["error", "orca_unreachable", "linear_error", "paused"]);
export const exitCodeFor = (o: Heartbeat["outcome"]): 1 | 2 => (EXIT_2.has(o) ? 2 : 1);

const newSummary = (at: string): TickSummary => ({
  at,
  outcome: "idle",
  reason: null,
  reconcileOnly: false,
  claims: [],
  resumes: [],
  relaunches: [],
  handoffs: [],
  blocked: [],
  released: [],
  done: [],
  parked: [],
  finished: [],
  skipped: [],
  attention: [],
  quota: {},
  counts: {},
  durationMs: 0,
});
const ACTED: (keyof TickSummary)[] = [
  "claims",
  "resumes",
  "relaunches",
  "handoffs",
  "blocked",
  "released",
  "done",
  "parked",
  "finished",
];

function reconcileOutcome(e: unknown): Heartbeat["outcome"] {
  if (e instanceof OrcaError) return "orca_unreachable";
  return errorCode(e).startsWith("linear_") ? "linear_error" : "error";
}

/**
 * §6.7: after a long gap (Mac asleep, Orca down), on a partial fleet read, or while paused, a tick starts no agent. C17: the gap runs
 * from the last tick's heartbeat — a `scan` heartbeat written since never shortens it.
 */
async function reconcileOnly(ctx: Ctx, rec: Reconciled, at: string): Promise<string | null> {
  if (rec.partial) return "partial_fleet";
  if (rec.pausedScopes.includes("global")) return "paused";
  const prev = await readLastTick(ctx.dirs).catch((e: unknown) => {
    ctx.log.warn({ err: errorText(e) }, "last tick heartbeat unreadable; treating as the first tick");
    return null;
  });
  return prev && Date.parse(at) - Date.parse(prev.at) > 3 * CADENCE_MS ? "gap" : null;
}

export async function tick(base: Ctx, opts: TickOptions): Promise<TickSummary> {
  const started = Date.now();
  const s = newSummary(base.now());
  let pausedScopes: string[] = [];
  const finish = async (
    outcome: Heartbeat["outcome"],
    reason: string | null = null,
  ): Promise<TickSummary> => {
    s.outcome = outcome;
    s.reason = reason;
    s.durationMs = Date.now() - started;
    if (!opts.dryRun)
      await writeHeartbeat(base.dirs, {
        kind: "tick",
        at: s.at,
        exitCode: exitCodeFor(outcome),
        outcome,
        reason,
        durationMs: s.durationMs,
        pausedScopes,
        linearAuth: { ok: outcome !== "linear_error", expiresAt: null },
        orcaReachable: outcome !== "orca_unreachable",
        counts: s.counts,
        quota: s.quota,
      });
    return s;
  };
  if (await stopRequested(base.dirs)) return finish("stopped", "stop_requested");
  const lock = opts.dryRun
    ? null
    : await TickLock.acquire(
        base.dirs,
        base.clock,
        opts.lockHeartbeatMs ? { heartbeatMs: opts.lockHeartbeatMs } : {},
      );
  if (lock?.kind === "held") return finish("lock_held");
  const deadline: TickDeadline = opts.deadline ?? {
    at: (opts.startedAt ?? started) + tickBudgetMs(base.cfg),
    now: Date.now,
  };
  // §6.0 + Ruling R16: before every external action, a lost lock or a stop for everything aborts the tick; REL-1: so does the deadline
  const ctx = guardedCtx({ ...base, deadline }, async () => {
    if (lock?.lost()) throw new TickAbort("lock_lost", "lock_lost");
    if (await stopRequested(base.dirs)) throw new TickAbort("stopped", "stop_requested");
    if (deadline.now() >= deadline.at) throw new TickAbort("error", "tick_deadline");
  });
  try {
    let rec: Reconciled;
    try {
      rec = await reconcile(ctx);
    } catch (e) {
      if (isTickAbort(e)) throw e;
      ctx.log.error({ code: errorCode(e), err: errorText(e) }, "reconcile failed");
      return await finish(reconcileOutcome(e), errorCode(e));
    }
    pausedScopes = rec.pausedScopes;
    // F10 (§9.1, Review Focus 3): a stale snapshot stays available, and the tick records it per provider for status and the run history
    s.quota = quotaAttention(
      rec.rateLimits,
      launchableProviders(ctx.cfg.defaults.providers),
      ctx.cfg.defaults.quota,
      Date.parse(ctx.now()),
    );
    s.reason = await reconcileOnly(ctx, rec, s.at);
    s.reconcileOnly = s.reason !== null;
    const budget: Budget = { resumes: ctx.cfg.defaults.dispatcher.resumesPerTick, handoffs: 1 };
    if (opts.dryRun) await planOnly(rec, s);
    else {
      await advanceAll(ctx, rec, s, budget);
      await cleanup(ctx, rec, s);
    }
    const queue = await claimCandidates(ctx, rec, s, opts);
    if (opts.dryRun)
      await writeAtomic(join(ctx.dirs.state, "queue.dryrun.json"), JSON.stringify(queue, null, 2));
    else await writeQueue(ctx.dirs, queue);
    s.counts = {
      ...s.counts,
      records: rec.records.length,
      candidates: rec.candidates.length,
      eligible: queue.items.filter((q) => q.status === "eligible").length,
      events: rec.events.length,
    };
    const acted = ACTED.some((k) => (s[k] as string[]).length > 0) || (s.counts.actionable ?? 0) > 0;
    const outcome = rec.pausedScopes.includes("global") ? "paused" : acted ? "work" : "idle";
    return await finish(outcome, s.reason);
  } catch (e) {
    if (isTickAbort(e)) return finish(e.outcome, e.reason);
    base.log.error({ code: errorCode(e), err: errorText(e) }, "tick failed");
    return finish("error", errorCode(e));
  } finally {
    if (lock) await lock.release();
  }
}
