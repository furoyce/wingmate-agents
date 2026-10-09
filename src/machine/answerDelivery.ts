import { createHash } from "node:crypto";
import type { WRecord } from "../state/records";
import type { Ctx } from "./context";

export interface AnswerIdentity {
  commentId: string;
  userId: string;
  body: string;
  at: string;
}

/** Exact trusted authentication/delivery correlation, never derived from an advisory inbox or Console flag. */
export function answerDeliveryKey(
  r: WRecord,
  q: WRecord["questions"][number],
  answer: AnswerIdentity,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        r.identifier,
        r.linearId,
        r.cycle,
        r.coordinator.attempt,
        q.id,
        q.askedAt,
        answer.commentId,
        answer.userId,
        answer.at,
        answer.body,
      ]),
    )
    .digest("hex");
}

/** Only a protected authentication receipt followed by actual terminal acceptance can settle a pending answer. */
export async function acceptedAnswerKeys(ctx: Ctx, r: WRecord): Promise<Set<string>> {
  const accepted = new Set<string>();
  const q = r.questions.find((question) => question.status === "open");
  if (
    r.stage !== "awaiting-human" ||
    !r.attention.includes("resume_unconfirmed") ||
    !q?.answerCommentId ||
    q.resumeAttempts < 1
  )
    return accepted;
  const authenticated = new Set<string>();
  for (const event of await ctx.ledger.readIssue(r.identifier)) {
    const data = event.data;
    const key = data.deliveryKey;
    if (
      data.cycle !== r.cycle ||
      data.attempt !== r.coordinator.attempt ||
      typeof key !== "string" ||
      !/^[0-9a-f]{64}$/.test(key)
    )
      continue;
    if (
      event.type === "answer_authenticated" &&
      data.questionId === q.id &&
      data.askedAt === q.askedAt &&
      data.commentId === q.answerCommentId
    ) {
      authenticated.add(key);
      continue;
    }
    if (
      authenticated.has(key) &&
      ((event.type === "delivered" && data.kind === "answer") ||
        (event.type === "relaunch" && data.reason === "answer")) &&
      (data.stage === "input_accepted" || data.stage === "turn_started") &&
      typeof data.requestId === "string" &&
      data.requestId.length > 0
    )
      accepted.add(key);
  }
  return accepted;
}
