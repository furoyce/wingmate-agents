// src/machine/cleanup.ts — §6.3 step 7 / §13.3(h): a `done`/`cancelled` record's worktree is removed after the grace hours, by its
// recorded id, never while an open PR references its branch (then retried daily).
import { errorCode, errorText } from "../shared/errors";
import { withRecordLock } from "../state/lock";
import { readRecord, writeRecord } from "../state/records";
import type { Ctx } from "./context";
import { isTickAbort } from "./guard";
import { refreshRepoSiblings } from "./launch";
import type { Reconciled } from "./reconcile";
import { addAttention, dropAttention } from "./states";
import type { TickSummary } from "./tick";

const DAY_MS = 24 * 3_600_000;

async function deferredRecently(ctx: Ctx, identifier: string): Promise<boolean> {
  const last = (await ctx.ledger.readIssue(identifier)).filter((e) => e.type === "cleanup_deferred").at(-1);
  return !!last && Date.parse(ctx.now()) - Date.parse(last.at) < DAY_MS;
}

async function cleanupOne(ctx: Ctx, rec: Reconciled, identifier: string): Promise<void> {
  const r = await readRecord(ctx.dirs, identifier);
  const old = r?.worktree;
  if (!r || !old || (r.stage !== "done" && r.stage !== "cancelled")) return;
  if (await deferredRecently(ctx, identifier)) return;
  const defer = async (why: string) => {
    addAttention(r, "cleanup_failed");
    await ctx.ledger.append({ at: ctx.now(), issue: identifier, type: "cleanup_deferred", data: { why } });
    await writeRecord(ctx.dirs, r);
  };
  for (const pr of r.prs.filter((p) => p.state === "OPEN")) {
    try {
      pr.state = (await ctx.gh.prView(old.path, pr.number)).state;
    } catch (e) {
      ctx.log.warn(
        { issue: identifier, pr: pr.number, err: errorText(e) },
        "PR state unreadable; kept as open",
      );
    }
  }
  if (r.prs.some((p) => p.state === "OPEN")) return defer("open_pr");
  try {
    await ctx.orca.worktreeRm(old.id);
  } catch (e) {
    if (isTickAbort(e)) throw e;
    ctx.log.warn({ issue: identifier, code: errorCode(e), err: errorText(e) }, "worktree remove failed");
    return defer(errorCode(e));
  }
  r.worktree = null;
  dropAttention(r, "cleanup_failed");
  await ctx.ledger.append({ at: ctx.now(), issue: identifier, type: "cleanup", data: { worktree: old.id } });
  await writeRecord(ctx.dirs, r);
  await refreshRepoSiblings(ctx, rec.records, old.gitCommonDir, identifier); // R22/R24: the repo lost a sibling
}

export async function cleanup(ctx: Ctx, rec: Reconciled, s: TickSummary): Promise<void> {
  const graceMs = ctx.cfg.defaults.cleanup.worktreeGraceHours * 3_600_000;
  for (const r of rec.records) {
    if ((r.stage !== "done" && r.stage !== "cancelled") || !r.worktree) continue;
    const last = r.history.at(-1);
    if (!last || Date.parse(ctx.now()) - Date.parse(last.at) < graceMs) continue;
    try {
      await withRecordLock(ctx.dirs, r.identifier, () => cleanupOne(ctx, rec, r.identifier));
    } catch (e) {
      if (isTickAbort(e)) throw e;
      s.attention.push({ identifier: r.identifier, code: "tick_error" });
      const data = { code: errorCode(e), message: errorText(e).slice(0, 300) };
      await ctx.ledger.append({ at: ctx.now(), issue: r.identifier, type: "tick_error", data });
      ctx.log.error({ issue: r.identifier, code: data.code, err: data.message }, "cleanup failed");
    }
  }
}
