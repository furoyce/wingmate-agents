// src/machine/release.ts — the shared stop sequence (§7.4 release, §9.4 handoff, §13.3 i), release and block.
import { renderBlocked } from "../linear/templates";
import type { LinearIssue } from "../ports";
import { errorText } from "../shared/errors";
import { newUlid } from "../shared/ids";
import type { WRecord } from "../state/records";
import type { Ctx } from "./context";
import { LinearWrites } from "./linearWrites";
import { saveRecord } from "./save";
import { addAttention, endAttempt, transition } from "./states";

const SETTLED = new Set(["completed", "failed"]);

/**
 * §7.4: stop every unsettled Dispatch of the child Run (`worker-stop`, then `worker-abandon` when the stop is not proven `exited`),
 * close every terminal of the issue worktree, then sweep its processes. Returns what could not be verified: dispatch ids, and
 * `terminals:<worktreeId>` when the bulk close failed.
 */
export async function stopAgents(ctx: Ctx, r: WRecord): Promise<{ unverifiable: string[] }> {
  const unverifiable: string[] = [];
  if (r.coordinator.childRunId) {
    for (const w of await ctx.orca.workerList(r.coordinator.childRunId)) {
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

/**
 * §7.4 release, also for Done/Canceled (`owner_done`/`owner_cancel`, without the comment). A failed bulk terminal close keeps the
 * record as it is and returns false: the override is still visible next tick, so the release is retried then.
 */
export async function release(
  ctx: Ctx,
  r: WRecord,
  issue: LinearIssue,
  cause: "override" | "owner_done" | "owner_cancel",
  comment: string | null,
): Promise<boolean> {
  const { unverifiable } = await stopAgents(ctx, r);
  const workers = workersOf(unverifiable);
  if (workers.length) addAttention(r, `release_unverifiable(${workers.join(",")})`);
  if (workers.length !== unverifiable.length) {
    addAttention(r, "release_unverifiable(terminals)");
    await saveRecord(ctx, r);
    return false;
  }
  const w = new LinearWrites(ctx);
  await w.setLifecycle(
    r,
    issue,
    cause === "override" && r.linear.lifecycleLabelAtClaim === "Ready" ? "Ready" : null,
  );
  const to = cause === "override" ? "released" : cause === "owner_done" ? "done" : "cancelled";
  await transition(ctx, r, to, cause);
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

/** Stop, `blocked`, the `Blocked` Lifecycle label and exactly one blocked comment (§7.5 step 2). */
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
  const w = new LinearWrites(ctx);
  await w.setLifecycle(r, issue, "Blocked");
  const retained = r.worktree ? [`branch ${r.worktree.branch}`, `worktree ${r.worktree.path}`] : [];
  await w.postComment(
    r,
    issue,
    renderBlocked({ identifier: r.identifier, reason, detail, retained, nextAction }),
    {
      key: `blocked:${r.identifier}:${r.cycle}:${r.history.length}`,
    },
  );
  await saveRecord(ctx, r);
}
