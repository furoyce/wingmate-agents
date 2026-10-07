// src/machine/scan.ts — the plan-only tick (§4 box, Appendix A): no record, Linear or Orca write; the queue plan goes to
// queue.dryrun.json and the heartbeat records kind `scan`. Exit 0 when a tick would act, 1 when idle/paused/lock held, 2 on errors.
import { writeHeartbeat } from "../state/heartbeat";
import type { Ctx } from "./context";
import { type TickSummary, tick } from "./tick";

const ERRORS = new Set(["error", "orca_unreachable", "linear_error"]);

export async function scan(ctx: Ctx): Promise<{ exitCode: 0 | 1 | 2; summary: TickSummary }> {
  const summary = await tick(ctx, { dryRun: true, precheck: false });
  const exitCode: 0 | 1 | 2 = summary.outcome === "work" ? 0 : ERRORS.has(summary.outcome) ? 2 : 1;
  await writeHeartbeat(ctx.dirs, {
    kind: "scan",
    at: summary.at,
    exitCode,
    outcome: summary.outcome,
    reason: summary.reason,
    durationMs: summary.durationMs,
    pausedScopes: [],
    linearAuth: { ok: summary.outcome !== "linear_error", expiresAt: null },
    orcaReachable: summary.outcome !== "orca_unreachable",
    counts: summary.counts,
    quota: summary.quota,
  });
  return { exitCode, summary };
}
