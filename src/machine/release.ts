// src/machine/release.ts — the shared stop sequence (§7.4 release, §9.4 handoff, §13.3 i), release and block.
import { z } from "zod";
import { renderBlocked } from "../linear/templates";
import { OrcaError } from "../orca/cli";
import type { LinearIssue, WorkerRow } from "../ports";
import { errorText } from "../shared/errors";
import { newUlid } from "../shared/ids";
import type { WRecord } from "../state/records";
import type { Ctx } from "./context";
import { LinearWrites } from "./linearWrites";
import { worktreeGone } from "./liveness";
import type { Reconciled } from "./reconcile";
import { saveRecord } from "./save";
import { addAttention, dropAttention, endAttempt, transition } from "./states";

const SETTLED = new Set(["completed", "failed"]);
/** F2: a block whose Blocked label or comment has not reached Linear yet (the record is `blocked` on disk already). */
const BLOCK_UNPOSTED = "blocked_unposted";
const BlockNotice = z.object({
  key: z.string(),
  reason: z.string(),
  detail: z.string(),
  nextAction: z.string(),
});
type BlockNotice = z.infer<typeof BlockNotice>;

/** F4: every open claim entry of the issue is closed once its record leaves the claim for good (release, block, archive, reroute). */
export async function closeClaimEntries(ctx: Ctx, identifier: string, why: string): Promise<void> {
  for (const e of await ctx.journal.pending())
    if (e.issue === identifier && e.kind === "claim") await ctx.journal.abandon(e.id, why);
}

/**
 * §7.4: stop every unsettled Dispatch of the child Run (`worker-stop`, then `worker-abandon` when the stop is not proven `exited`),
 * close every terminal of the issue worktree, then sweep its processes. Returns what could not be verified: dispatch ids,
 * `run:<runId>` when the Run's workers could not be listed, and `terminals:<worktreeId>` when the bulk close failed.
 */
export async function stopAgents(ctx: Ctx, r: WRecord): Promise<{ unverifiable: string[] }> {
  const unverifiable: string[] = [];
  if (r.coordinator.childRunId) {
    let rows: WorkerRow[] = [];
    try {
      rows = await ctx.orca.workerList(r.coordinator.childRunId);
    } catch (e) {
      // F8: a Run Orca cannot list never keeps a release, block or handoff from closing the terminals and sweeping the worktree
      if (!(e instanceof OrcaError)) throw e;
      unverifiable.push(`run:${r.coordinator.childRunId}`);
    }
    for (const w of rows) {
      if (w.verdict === "exited" || SETTLED.has(w.dispatchStatus)) continue;
      const s = await ctx.orca.workerStop(w.dispatchId, newUlid());
      if (s.verdict !== "exited") {
        await ctx.orca.workerAbandon(w.dispatchId);
        unverifiable.push(w.dispatchId);
      }
    }
  }
  if (r.worktree) {
    const c = await ctx.orca.terminalClose(r.worktree.id);
    if (!c.ok) unverifiable.push(`terminals:${r.worktree.id}`);
    const swept = await ctx.sweep([r.worktree.path]);
    await ctx.ledger.append({
      at: ctx.now(),
      issue: r.identifier,
      type: "process_sweep",
      data: { killed: swept.killed, commands: swept.commands ?? [], why: "stop" },
    });
  }
  r.coordinator.terminalHandle = null;
  r.coordinator.paneKey = null;
  return { unverifiable };
}

const workersOf = (u: string[]) => u.filter((x) => !x.startsWith("terminals:"));

/** C13: Orca no longer knows the record's worktree (a complete fleet read has no row for it) and its path is gone from disk. */
export function worktreeForgotten(r: WRecord, fleet: Pick<Reconciled, "partial" | "fleet">): boolean {
  const wt = r.worktree;
  if (!wt || fleet.partial) return false;
  return !fleet.fleet.worktrees.some((x) => x.worktreeId === wt.id) && worktreeGone(wt.path);
}

/**
 * §7.4 release, also for Done/Canceled (`owner_done`/`owner_cancel`, without the comment). A failed bulk terminal close keeps the
 * record as it is and returns false: the override is still visible next tick, so the release is retried then. C13: with the tick's
 * fleet read, a worktree Orca no longer knows and that is gone from disk has nothing left to close — its failed close counts as
 * closed, so such a release completes instead of staying `release_unverifiable(terminals)` for good.
 */
export async function release(
  ctx: Ctx,
  r: WRecord,
  issue: LinearIssue,
  cause: "override" | "owner_done" | "owner_cancel",
  comment: string | null,
  fleet?: Pick<Reconciled, "partial" | "fleet">,
): Promise<boolean> {
  const { unverifiable } = await stopAgents(ctx, r);
  const workers = workersOf(unverifiable);
  if (workers.length) addAttention(r, `release_unverifiable(${workers.join(",")})`);
  const closed = workers.length === unverifiable.length || (!!fleet && worktreeForgotten(r, fleet));
  if (!closed) {
    addAttention(r, "release_unverifiable(terminals)");
    await saveRecord(ctx, r);
    return false;
  }
  dropAttention(r, "release_unverifiable(terminals)");
  const w = new LinearWrites(ctx);
  await w.setLifecycle(
    r,
    issue,
    cause === "override" && r.linear.lifecycleLabelAtClaim === "Ready" ? "Ready" : null,
  );
  const to = cause === "override" ? "released" : cause === "owner_done" ? "done" : "cancelled";
  await transition(ctx, r, to, cause);
  await closeClaimEntries(ctx, r.identifier, `${to}:${cause}`);
  dropAttention(r, BLOCK_UNPOSTED);
  if (comment) await w.postComment(r, issue, comment, { key: `release:${r.identifier}:${r.cycle}` });
  endAttempt(ctx, r, to, cause);
  if (r.worktree)
    await ctx.orca
      .worktreeSet(r.worktree.id, {
        workspaceStatus: to === "done" ? "completed" : "todo",
        comment: `wingmate: ${to}`,
      })
      .catch((e: unknown) => ctx.log.warn({ issue: r.identifier, err: errorText(e) }, "worktree set failed"));
  await saveRecord(ctx, r);
  return true;
}

/** The Blocked label (unless the owner changed the issue since: Linear wins) and the one keyed blocked comment; then the marker goes. */
async function postBlockNotice(
  ctx: Ctx,
  r: WRecord,
  issue: LinearIssue,
  n: BlockNotice,
  label: boolean,
): Promise<void> {
  const w = new LinearWrites(ctx);
  if (label) await w.setLifecycle(r, issue, "Blocked");
  const retained = r.worktree ? [`branch ${r.worktree.branch}`, `worktree ${r.worktree.path}`] : [];
  const { reason, detail, nextAction } = n;
  const body = renderBlocked({ identifier: r.identifier, reason, detail, retained, nextAction });
  await w.postComment(r, issue, body, { key: n.key });
  dropAttention(r, BLOCK_UNPOSTED);
  await saveRecord(ctx, r);
}

/**
 * Stop, `blocked`, the `Blocked` Lifecycle label and exactly one blocked comment (§7.5 step 2). F2: the record is written `blocked`
 * (with its open claim entries closed) before any Linear write, so a failed label or comment can never let it escape to a relaunch;
 * its next processing finishes them (`finishBlock`).
 */
export async function block(
  ctx: Ctx,
  r: WRecord,
  issue: LinearIssue,
  reason: string,
  detail: string,
  nextAction: string,
): Promise<void> {
  const { unverifiable } = await stopAgents(ctx, r);
  if (unverifiable.length)
    addAttention(r, `release_unverifiable(${unverifiable.map((u) => u.split(":")[0]).join(",")})`);
  await transition(ctx, r, "blocked", reason, detail);
  // a pause holds an active record (§7.4); a blocked one is re-queued by the owner, so removing Blocked never "unpauses" it (C19)
  r.paused = false;
  r.linear.pausedWith = null;
  const notice: BlockNotice = {
    key: `blocked:${r.identifier}:${r.cycle}:${r.history.length}`,
    reason,
    detail,
    nextAction,
  };
  await ctx.ledger.append({ at: ctx.now(), issue: r.identifier, type: "block_notice", data: notice });
  addAttention(r, BLOCK_UNPOSTED);
  await closeClaimEntries(ctx, r.identifier, `blocked:${reason}`);
  await saveRecord(ctx, r);
  await postBlockNotice(ctx, r, issue, notice, true);
}

/**
 * F2: a block whose Blocked label or comment did not reach Linear is finished on the record's next processing — the comment once
 * (keyed), the label only while the owner has not changed the issue since. Returns whether there was one to finish.
 */
export async function finishBlock(
  ctx: Ctx,
  r: WRecord,
  issue: LinearIssue,
  ownerChanged: boolean,
): Promise<boolean> {
  if (r.stage !== "blocked" || !r.attention.includes(BLOCK_UNPOSTED)) return false;
  const last = (await ctx.ledger.readIssue(r.identifier)).filter((e) => e.type === "block_notice").at(-1);
  const parsed = BlockNotice.safeParse(last?.data);
  const h = [...r.history].reverse().find((x) => x.to === "blocked");
  const notice: BlockNotice = parsed.success
    ? parsed.data
    : {
        key: `blocked:${r.identifier}:${r.cycle}:${r.history.length}`,
        reason: h?.cause ?? "unknown",
        detail: h?.evidence ?? "",
        nextAction: "see the issue's record in the Console",
      };
  await postBlockNotice(ctx, r, issue, notice, !ownerChanged);
  return true;
}
