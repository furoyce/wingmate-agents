import { describe, expect, test } from "bun:test";
import { classifyComment } from "../../../src/machine/classify";
import { newRecord } from "../../../src/state/records";

const OWNER = "71aef180-1742-4a76-8d49-51f14e8ada1e";
const approvers = [OWNER];
const parked = () => {
  const r = newRecord({
    identifier: "JRF-1",
    linearId: "l",
    project: "bouncr",
    repo: "api",
    provider: "claude",
    autonomy: "ask-first",
    now: "2026-10-06T09:00:00.000Z",
  });
  r.stage = "awaiting-human";
  r.questions.push({
    id: "q1",
    commentId: "cq",
    askedAt: "2026-10-06T09:05:00.000Z",
    status: "open",
    answerCommentId: null,
    answeredAt: null,
    resumeAttempts: 0,
    nonAnswerCommentIds: [],
  });
  return r;
};
const c = (
  over: Partial<{
    userId: string | null;
    botActorId: string | null;
    externalUserId: string | null;
    createdAt: string;
    body: string;
  }>,
) => ({
  id: "c1",
  issueId: "l",
  body: "2",
  createdAt: "2026-10-06T09:30:00.000Z",
  parentId: "cq",
  userId: OWNER,
  botActorId: null,
  externalUserId: null,
  ...over,
});

describe("classifyComment", () => {
  test("owner comment after askedAt with no agent active is an answer", () => {
    expect(classifyComment(c({}), parked(), approvers, () => false)).toBe("answer");
  });
  test("answer during agent activity is not an answer", () => {
    expect(classifyComment(c({}), parked(), approvers, () => true)).toBe("self_answer_suspected");
  });
  test("app or external authorship is ignored; non-approver humans are unverified", () => {
    expect(classifyComment(c({ userId: null, botActorId: "app" }), parked(), approvers, () => false)).toBe(
      "ignore",
    );
    expect(classifyComment(c({ externalUserId: "ext-1" }), parked(), approvers, () => false)).toBe("ignore");
    expect(classifyComment(c({ userId: "guest" }), parked(), approvers, () => false)).toBe(
      "unverified_author",
    );
  });
  test("comments before askedAt are ignored; continue on blocked; notes on working", () => {
    expect(
      classifyComment(c({ createdAt: "2026-10-06T09:01:00.000Z" }), parked(), approvers, () => false),
    ).toBe("ignore");
    const b = parked();
    b.stage = "blocked";
    expect(classifyComment(c({ body: "Continue" }), b, approvers, () => false)).toBe("continue");
    expect(classifyComment(c({ body: "  continue\nwith the plan" }), b, approvers, () => false)).toBe(
      "continue",
    );
    expect(classifyComment(c({ body: "any thoughts?" }), b, approvers, () => false)).toBe("note");
    const w = parked();
    w.stage = "working";
    expect(classifyComment(c({ body: "please also handle dark mode" }), w, approvers, () => false)).toBe(
      "note",
    );
  });
  test("parked without an open question, or in terminal stages, is ignored", () => {
    const noQ = parked();
    noQ.questions = [];
    expect(classifyComment(c({}), noQ, approvers, () => false)).toBe("ignore");
    for (const stage of ["released", "done", "cancelled"] as const) {
      const r = parked();
      r.stage = stage;
      expect(classifyComment(c({}), r, approvers, () => false)).toBe("ignore");
    }
  });
});

describe("classifyComment in review (fix round 1)", () => {
  test("an approver's comment in review is a note; others keep their authorship class", () => {
    const r = parked();
    r.stage = "review";
    expect(classifyComment(c({ body: "please rename the hook" }), r, approvers, () => false)).toBe("note");
    expect(classifyComment(c({ userId: "guest" }), r, approvers, () => false)).toBe("unverified_author");
    expect(classifyComment(c({ userId: null, botActorId: "app" }), r, approvers, () => false)).toBe("ignore");
  });
});
