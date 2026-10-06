// src/machine/classify.ts — §7.2: what a human comment means, by stage (authorship first, then timing, then text)
import type { LinearComment } from "../ports";
import type { WRecord } from "../state/records";

export type CommentClass =
  | "answer"
  | "unverified_author"
  | "self_answer_suspected"
  | "continue"
  | "note"
  | "ignore";

export function classifyComment(
  c: LinearComment,
  r: WRecord,
  approvers: string[],
  activeAt: (iso: string) => boolean,
): CommentClass {
  if (c.botActorId || c.externalUserId || !c.userId) return "ignore";
  if (!approvers.includes(c.userId)) return "unverified_author";
  const first = c.body.trim().split("\n")[0]?.trim().toLowerCase();
  if (r.stage === "blocked") return first === "continue" ? "continue" : "note";
  if (r.stage === "awaiting-human") {
    const q = r.questions.find((x) => x.status === "open");
    if (!q || c.createdAt <= q.askedAt) return "ignore";
    return activeAt(c.createdAt) ? "self_answer_suspected" : "answer";
  }
  if (r.stage === "claimed" || r.stage === "working") return "note";
  return "ignore";
}
