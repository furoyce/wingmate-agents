// Dispatcher and CLI share every eligibility predicate, including grace and complete resource evidence.
import { runCleanup } from "../ops/cleanup";
import { errorCode, errorText } from "../shared/errors";
import type { Ctx } from "./context";
import { isRecordAbort, isTickAbort } from "./guard";
import { refreshRepoSiblings } from "./launch";
import type { Reconciled } from "./reconcile";
import type { TickSummary } from "./tick";

export async function cleanup(ctx: Ctx, rec: Reconciled, s: TickSummary): Promise<void> {
  // A partial reconcile is never rehabilitated into authority by a later narrower inventory.
  if (rec.partial) return;
  for (const r of rec.records) {
    if (!r.worktree || (r.stage !== "done" && r.stage !== "cancelled")) continue;
    try {
      const report = await runCleanup(ctx, { scope: { kind: "issue", key: r.identifier } });
      if (report.cleaned.some((result) => result.outcome === "removed"))
        await refreshRepoSiblings(ctx, rec.records, r.worktree.gitCommonDir, r.identifier);
    } catch (e) {
      if (isRecordAbort(e)) {
        s.skipped.push({ identifier: r.identifier, reason: e.code });
        continue;
      }
      if (isTickAbort(e)) throw e;
      s.attention.push({ identifier: r.identifier, code: "tick_error" });
      const data = { code: errorCode(e), message: errorText(e).slice(0, 300) };
      await ctx.ledger.append({ at: ctx.now(), issue: r.identifier, type: "tick_error", data });
      ctx.log.error({ issue: r.identifier, ...data }, "cleanup failed");
    }
  }
}
