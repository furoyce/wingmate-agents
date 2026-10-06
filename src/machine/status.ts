// src/machine/status.ts — one status comment per issue, edited in place (§11.2), with the last five activity notes.
import { MARK } from "../linear/markers";
import { renderStatus } from "../linear/templates";
import type { LinearIssue } from "../ports";
import { errorText } from "../shared/errors";
import { PIPELINE, type WRecord } from "../state/records";
import type { Ctx } from "./context";
import { LinearWrites } from "./linearWrites";

const EPOCH = "1970-01-01T00:00:00.000Z";
const NOTE_MAX = 300;

/**
 * Activity notes added while a record is processed; `flushNotes` persists them to the issue's ledger (`activity` events), so the
 * status comment shows the last five across ticks and processes. Keyed by the record object: nothing leaks between records,
 * ticks or test worlds.
 */
const pending = new WeakMap<WRecord, string[]>();

export function addNote(r: WRecord, note: string): void {
  const n = pending.get(r) ?? [];
  n.push(note.replace(/\s+/g, " ").trim().slice(0, NOTE_MAX));
  pending.set(r, n);
}

export async function flushNotes(ctx: Ctx, r: WRecord): Promise<void> {
  const n = pending.get(r);
  if (!n?.length) return;
  pending.delete(r);
  for (const note of n)
    await ctx.ledger.append({ at: ctx.now(), issue: r.identifier, type: "activity", data: { note } });
}

async function recentNotes(ctx: Ctx, r: WRecord): Promise<string[]> {
  return (await ctx.ledger.readIssue(r.identifier))
    .filter((e) => e.type === "activity" && typeof e.data.note === "string")
    .slice(-5)
    .map((e) => `${e.at.slice(11, 16)} ${String(e.data.note)}`);
}

/** Who the issue waits on and what happens next, by stage (§11.2 header line). */
function statusLine(r: WRecord): { waitingOn: string | null; nextAction: string } {
  const lastBlock = [...r.history].reverse().find((x) => x.to === "blocked");
  if (r.paused)
    return {
      waitingOn: `owner (paused with ${r.linear.pausedWith ?? "a label"})`,
      nextAction: "remove the pausing label to continue",
    };
  switch (r.stage) {
    case "claimed":
      return { waitingOn: null, nextAction: "launching the coordinator" };
    case "working":
      return { waitingOn: null, nextAction: `pipeline stage ${r.pipelineStage}` };
    case "awaiting-human":
      return { waitingOn: "owner (question)", nextAction: "answer the question in its thread" };
    case "review":
      return {
        waitingOn: "owner (review)",
        nextAction: "review the PR; move the issue to In Progress to request changes",
      };
    case "blocked":
      return {
        waitingOn: "owner",
        nextAction: `blocked (${lastBlock?.cause ?? "unknown"}); see the blocked comment`,
      };
    default:
      return { waitingOn: null, nextAction: "none" };
  }
}

/** Wingmate's existing status comment on the issue (re-claim, or a crash before its id was recorded). */
async function findStatusComment(ctx: Ctx, issue: LinearIssue): Promise<string | null> {
  const mine = (await ctx.linear.listComments([issue.id], EPOCH))
    .filter((c) => c.body.startsWith(MARK.status) && c.botActorId !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return mine[0]?.id ?? null; // the oldest: the status comment keeps one identity
}

const deleted = (e: unknown) => /not found|does not exist|entity.*(missing|deleted)/i.test(errorText(e));

/**
 * Renders and writes the status comment: edited in place; created only when the issue has none. A failed edit is rethrown (the
 * next tick retries) unless Linear reports the comment gone, in which case a replacement is created and the old id ledgered.
 */
export async function syncStatus(
  ctx: Ctx,
  r: WRecord,
  issue: LinearIssue,
  waitingOn?: string | null,
  nextAction?: string,
): Promise<void> {
  await flushNotes(ctx, r);
  const line = statusLine(r);
  const body = renderStatus({
    identifier: r.identifier,
    stage: r.stage,
    pipelineStage: r.pipelineStage,
    waitingOn: waitingOn === undefined ? line.waitingOn : waitingOn,
    nextAction: nextAction ?? line.nextAction,
    provider: r.provider,
    model: r.coordinator.launch.model,
    effort: r.coordinator.launch.effort,
    worktree: r.worktree?.path ?? null,
    branch: r.worktree?.branch ?? null,
    agents: { coordinator: r.stage === "working" || r.stage === "claimed" ? 1 : 0, workers: 0 },
    gates: PIPELINE.map(
      (s) =>
        [s, r.gates[s].verdict, r.gates[s].failCount + (r.gates[s].verdict ? 1 : 0)] as [
          string,
          string | null,
          number,
        ],
    ),
    pr: r.prs[0]?.url ?? null,
    cost: {
      tokens: r.usage.tokens,
      costUsd: r.usage.costUsd,
      provenance: r.usage.bySession[0]?.provenance ?? "unknown",
    },
    updatedAt: ctx.now(),
    notes: await recentNotes(ctx, r),
  });
  const w = new LinearWrites(ctx);
  if (!r.linear.statusCommentId) r.linear.statusCommentId = await findStatusComment(ctx, issue);
  const id = r.linear.statusCommentId;
  if (id) {
    try {
      await w.editComment(r, id, body);
      return;
    } catch (e) {
      if (!deleted(e)) throw e;
      await ctx.ledger.append({
        at: ctx.now(),
        issue: r.identifier,
        type: "status_comment_replaced",
        data: { old: id },
      });
    }
  }
  r.linear.statusCommentId = await w.postComment(r, issue, body);
}
