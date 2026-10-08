// src/machine/humans.ts — §6.3 step 3 and §7: answers resume a parked issue, notes reach a working coordinator, `continue` lifts a
// block, review feedback resumes a review. Every resume counts against the tick's budget and is deferred in reconcile-only ticks.
import { resetMirrorGates } from "../kit/local";
import type { LinearIssue } from "../ports";
import type { WRecord } from "../state/records";
import type { Ctx } from "./context";
import { LinearWrites } from "./linearWrites";
import type { Event } from "./reconcile";
import { block } from "./release";
import { deliver, persistInbox, relaunch, sendPointerDetailed } from "./resume";
import { addAttention, dropAttention, enterPipelineStage, transition } from "./states";
import { addNote } from "./status";
import { type Advance, type StepOut, WORKING } from "./step";

type AnswerEvent = Extract<Event, { type: "answer" }>;
type CommentEvent = Extract<Event, { type: "comment" }>;
type Question = WRecord["questions"][number];
/** `defer`: leave the comment unseen so the next tick reads it again (deferred, or classified for a stage that just changed). */
type Seen = "done" | "defer";

/** §7.2 `blocked`: `continue` lifts only these blocks. */
const CONTINUABLE = new Set(["budget", "resume_failed", "self_answer_suspected"]);

async function resumed(a: Advance, q: Question, commentId: string): Promise<Seen> {
  q.status = "answered";
  q.answeredAt = a.ctx.now();
  q.answerCommentId = commentId;
  dropAttention(a.r, "resume_unconfirmed");
  await new LinearWrites(a.ctx).setLifecycle(a.r, a.issue, "In-Agent");
  await transition(a.ctx, a.r, "working", "answer");
  a.s.resumes.push(a.r.identifier);
  a.dirty = true;
  return "done";
}

/** §7.1 step 4: persist, deliver (a successor when the terminal is gone), at most two attempts per answer, then `resume_failed`. */
async function answer(a: Advance, e: AnswerEvent): Promise<Seen> {
  const { ctx, r } = a;
  if (r.stage !== "awaiting-human") return "defer"; // re-read next tick, classified for the stage it now has
  const q = r.questions.find((x) => x.id === e.questionId);
  if (!q) return "done";
  if (a.ro || a.budget.resumes <= 0) return "defer";
  // an earlier delivery whose turn was unconfirmed is judged from the pane before anything is sent again
  if (r.attention.includes("resume_unconfirmed") && a.live === "working") return resumed(a, q, e.commentId);
  a.budget.resumes -= 1;
  q.answerCommentId = e.commentId;
  q.resumeAttempts += 1;
  let d = await deliver(ctx, r, "answer", e.body, a.live ?? "exited", r.pipelineStage);
  if (d === "exited") d = (await relaunch(ctx, r, "answer")) ? "turn_started" : "input_accepted";
  a.launched = true;
  if (d === "turn_started") return resumed(a, q, e.commentId);
  if (q.resumeAttempts >= 2) {
    await block(
      ctx,
      r,
      a.issue,
      "resume_failed",
      "the coordinator did not accept the answer twice",
      "fix the worktree or terminal, then comment `continue`",
    );
    a.s.blocked.push(r.identifier);
    a.dirty = true;
    return "done";
  }
  addAttention(r, "resume_unconfirmed");
  a.dirty = true;
  return "defer"; // offered once more next tick
}

async function commentBody(ctx: Ctx, issue: LinearIssue, id: string, since: string): Promise<string | null> {
  const from = new Date(Date.parse(since) - 1).toISOString();
  return (await ctx.linear.listComments([issue.id], from)).find((c) => c.id === id)?.body ?? null;
}

/**
 * §7.1 step 3 / §7.2: an approver's `continue` lifts a budget block, re-runs a failed resume with the answer it carried, or confirms
 * a suspected self-answer — the most recent flagged comment becomes the answer.
 */
async function continueBlocked(a: Advance, e: CommentEvent): Promise<Seen> {
  const { ctx, r } = a;
  const cause = [...r.history].reverse().find((h) => h.to === "blocked")?.cause ?? "";
  if (!CONTINUABLE.has(cause)) return "done";
  if (a.ro || a.budget.resumes <= 0) return "defer";
  a.budget.resumes -= 1;
  const q = r.questions.find((x) => x.status === "open");
  const answerId =
    cause === "self_answer_suspected"
      ? q?.nonAnswerCommentIds.at(-1)
      : cause === "resume_failed"
        ? q?.answerCommentId
        : null;
  const answerText = q && answerId ? await commentBody(ctx, a.issue, answerId, q.askedAt) : null;
  if (cause === "budget") r.budget.capLifted = true;
  await new LinearWrites(ctx).setLifecycle(r, a.issue, "In-Agent");
  await transition(ctx, r, "working", "continue");
  if (q && answerId && answerText !== null)
    Object.assign(q, { status: "answered", answeredAt: ctx.now(), answerCommentId: answerId });
  const kind = answerText !== null ? "answer" : "note";
  const d = await deliver(ctx, r, kind, answerText ?? e.body, a.live ?? "exited", r.pipelineStage);
  if (d === "exited") await relaunch(ctx, r, "continue");
  dropAttention(r, "possible_self_answer");
  a.s.resumes.push(r.identifier);
  a.launched = true;
  a.dirty = true;
  return "done";
}

async function comment(a: Advance, e: CommentEvent): Promise<Seen> {
  const { ctx, r } = a;
  switch (e.cls) {
    case "self_answer_suspected": {
      if (r.stage !== "awaiting-human") return "defer";
      r.questions.find((x) => x.status === "open")?.nonAnswerCommentIds.push(e.commentId);
      addAttention(r, "possible_self_answer");
      await block(
        ctx,
        r,
        a.issue,
        "self_answer_suspected",
        "a comment arrived while an agent of this issue was active",
        "confirm the answer in the Console, or comment `continue`",
      );
      a.s.blocked.push(r.identifier);
      a.dirty = true;
      return "done";
    }
    case "continue":
      return r.stage === "blocked" ? continueBlocked(a, e) : "done";
    case "note":
      if (WORKING.has(r.stage)) {
        if (a.ro) return "defer"; // C16 (§6.7): a reconcile-only tick starts no turn; the note stays unseen for the next normal tick
        const mailbox = a.live === "working" && Boolean(r.coordinator.childRunId);
        if (!mailbox && a.budget.resumes <= 0) return "defer";
        const inbox = await persistInbox(ctx, r, "note", e.body, r.pipelineStage);
        if (typeof inbox === "string") return "defer";
        const pointer = `note ${inbox.id} — read ${inbox.rel} and continue from stage ${r.pipelineStage}.`;
        const d = await sendPointerDetailed(ctx, r, "note", inbox, pointer, a.live ?? "exited");
        if (d === "deferred" || d === "exited") return "defer";
        if (!mailbox) {
          // An accepted terminal input may start a turn even before Orca confirms it; do not reuse this idle snapshot.
          a.budget.resumes -= 1;
          a.s.resumes.push(r.identifier);
          a.launched = true;
        }
        addNote(r, "owner note delivered");
        a.dirty = true;
      }
      return "done";
    case "unverified_author":
      addAttention(r, `unverified_input(${e.commentId})`);
      return "done";
    default:
      return "done";
  }
}

/**
 * §6.3 step 3. `lastSeenCommentAt` advances past each comment handled (Ruling R20) and stops at the first deferred one, so nothing
 * is skipped; in `review` nothing advances — the comments are the feedback a later move back to In Progress delivers (§7.3).
 */
export async function comments(a: Advance): Promise<StepOut> {
  // An earlier resume invalidated this tick's liveness snapshot; leave comments unseen until the next reconcile.
  if (a.launched) return "next";
  const { r } = a;
  let advance = r.stage !== "review";
  for (const e of a.evs) {
    if (e.type !== "answer" && e.type !== "comment") continue;
    const stage = r.stage;
    const seen = e.type === "answer" ? await answer(a, e) : await comment(a, e);
    if (seen === "defer") advance = false;
    if (advance) r.linear.lastSeenCommentAt = e.at;
    // A resumed coordinator needs fresh liveness; a deferred note keeps the rest queued behind its unchanged cursor.
    if (a.launched || (e.type === "comment" && e.cls === "note" && seen === "defer")) break;
    if (r.stage !== stage) break; // the rest were classified for the old stage: read them again next tick
    // F6: one answer delivery per tick — later answers wait for the next tick, which re-reads the pane first (§7.1 step 4)
    if (e.type === "answer" && seen === "defer") break;
  }
  return "next";
}

/** §7.3: the gates a move back to In Progress resets; the agent's own gates.json has no `pr` (the `gate` verb never writes one). */
const REVIEW_RESET = ["implement", "validate", "ui", "security", "pr"] as const;
const RESET_NOTE = (id: string) =>
  `Gates implement, validate, ui and security were reset with this move, on the dispatcher's record and in .wingmate/gates.json: re-run \`wingmate issue ${id} gate implement\` with fresh evidence first, then gate validate, ui and security again at the new HEAD, then finish.`;

/**
 * §7.3: In Review → In Progress resumes at `implement`, gates `implement`…`pr` pending, with every approver comment since finish.
 * INT-1: the agent's own gates.json is reset with the record (`resetMirrorGates`), so its local order checks agree with the dispatcher's
 * and it re-gates `implement` first; the delivered note says so.
 */
export async function reviewFeedback(a: Advance, stateName: string): Promise<StepOut> {
  const { ctx, r } = a;
  if (a.ro || a.budget.resumes <= 0) return "stop"; // deferred: the mirror keeps the old state, so the move is seen again
  a.budget.resumes -= 1;
  await new LinearWrites(ctx).setLifecycle(r, a.issue, "In-Agent");
  await transition(ctx, r, "working", "review_feedback");
  enterPipelineStage(ctx, r, "implement");
  for (const g of REVIEW_RESET) r.gates[g].verdict = null;
  const mirror = r.worktree ? await resetMirrorGates(r.worktree.path, REVIEW_RESET) : "unreadable";
  await ctx.ledger.append({ at: ctx.now(), issue: r.identifier, type: "gates_reset", data: { mirror } });
  const since = r.linear.finishedAt ?? r.claimedAt;
  const notes = a.evs.filter(
    (e): e is CommentEvent => e.type === "comment" && e.cls === "note" && e.at > since,
  );
  const text = notes.length
    ? `${RESET_NOTE(r.identifier)}\n\nReview feedback from the owner (the issue moved back to In Progress):\n\n${notes.map((e) => e.body).join("\n\n---\n\n")}`
    : `The owner moved the issue back to In Progress without a comment; re-check the PR. ${RESET_NOTE(r.identifier)}`;
  const d = await deliver(ctx, r, "note", text, a.live ?? "exited", "implement");
  if (d === "exited") await relaunch(ctx, r, "review_feedback");
  r.linear.state = stateName;
  const last = a.evs.filter((e): e is CommentEvent => e.type === "comment").at(-1);
  if (last) r.linear.lastSeenCommentAt = last.at;
  a.s.resumes.push(r.identifier);
  a.launched = true;
  a.dirty = true;
  return "stop";
}
