import { expect, test } from "bun:test";
import { acceptedAnswerKeys, answerDeliveryKey } from "../../../src/machine/answerDelivery";
import { classifyComment } from "../../../src/machine/classify";
import type { LinearComment } from "../../../src/ports";
import type { LedgerEvent } from "../../../src/state/ledger";
import { newRecord } from "../../../src/state/records";
import { makeWorld } from "../../fakes/world";

const OWNER = "71aef180-1742-4a76-8d49-51f14e8ada1e";
async function pending() {
  const w = await makeWorld();
  const r = newRecord({
    identifier: "JRF-501",
    linearId: "i1",
    project: "bouncr",
    repo: "api",
    provider: "claude",
    autonomy: "ask-first",
    now: "2026-10-06T09:00:00.000Z",
  });
  r.stage = "awaiting-human";
  r.attention = ["resume_unconfirmed"];
  const q = {
    id: "q1",
    commentId: "question-comment",
    askedAt: "2026-10-06T09:05:00.000Z",
    status: "open" as const,
    answerCommentId: "answer-comment",
    answeredAt: null,
    resumeAttempts: 1,
    nonAnswerCommentIds: [],
  };
  r.questions = [q];
  const c: LinearComment = {
    id: "answer-comment",
    issueId: "i1",
    parentId: q.commentId,
    body: "Keep rule a.",
    createdAt: "2026-10-06T09:40:00.000Z",
    userId: OWNER,
    botActorId: null,
    externalUserId: null,
  };
  const key = () =>
    answerDeliveryKey(r, q, {
      commentId: c.id,
      userId: c.userId ?? "",
      at: c.createdAt,
      body: c.body,
    });
  const common = { cycle: r.cycle, attempt: r.coordinator.attempt, deliveryKey: key() };
  const authenticated: LedgerEvent = {
    at: w.ctx.now(),
    issue: r.identifier,
    type: "answer_authenticated",
    data: { ...common, kind: "answer", questionId: q.id, askedAt: q.askedAt, commentId: c.id },
  };
  const delivered: LedgerEvent = {
    at: w.ctx.now(),
    issue: r.identifier,
    type: "delivered",
    data: { ...common, kind: "answer", stage: "input_accepted", requestId: "accepted-request" },
  };
  const classify = async () =>
    classifyComment(c, r, [OWNER], () => true, (await acceptedAnswerKeys(w.ctx, r)).has(key()));
  return { w, r, q, c, authenticated, delivered, classify };
}

for (const stage of ["input_accepted", "turn_started"] as const) {
  test(`exact protected authentication and ${stage} delivery survive later activity`, async () => {
    const f = await pending();
    f.delivered.data.stage = stage;
    await f.w.ctx.ledger.append(f.authenticated);
    await f.w.ctx.ledger.append(f.delivered);
    expect(await f.classify()).toBe("answer");
  });
}

const invalid: [string, (f: Awaited<ReturnType<typeof pending>>) => LedgerEvent[]][] = [
  ["Console-style record flags without any protected receipt", () => []],
  ["authentication without terminal acceptance", (f) => [f.authenticated]],
  ["acceptance without original authentication", (f) => [f.delivered]],
  ["acceptance before authentication", (f) => [f.delivered, f.authenticated]],
  [
    "deferred delivery",
    (f) => {
      f.delivered.data.stage = "deferred";
      return [f.authenticated, f.delivered];
    },
  ],
  [
    "failed delivery",
    (f) => {
      f.delivered.data.stage = "failed";
      return [f.authenticated, f.delivered];
    },
  ],
  [
    "missing accepted request identity",
    (f) => {
      f.delivered.data.requestId = undefined;
      return [f.authenticated, f.delivered];
    },
  ],
  [
    "different delivery correlation",
    (f) => {
      f.delivered.data.deliveryKey = "0".repeat(64);
      return [f.authenticated, f.delivered];
    },
  ],
  [
    "unrelated note delivery",
    (f) => {
      f.delivered.data.kind = "note";
      return [f.authenticated, f.delivered];
    },
  ],
  [
    "old delivery cycle",
    (f) => {
      f.delivered.data.cycle = f.r.cycle + 1;
      return [f.authenticated, f.delivered];
    },
  ],
  [
    "old delivery attempt",
    (f) => {
      f.delivered.data.attempt = f.r.coordinator.attempt + 1;
      return [f.authenticated, f.delivered];
    },
  ],
  [
    "different authentication question",
    (f) => {
      f.authenticated.data.questionId = "q-other";
      return [f.authenticated, f.delivered];
    },
  ],
  [
    "different authentication askedAt",
    (f) => {
      f.authenticated.data.askedAt = "2026-10-06T09:06:00.000Z";
      return [f.authenticated, f.delivered];
    },
  ],
];
for (const [name, entries] of invalid) {
  test(`${name} cannot exempt an active comment`, async () => {
    const f = await pending();
    for (const entry of entries(f)) await f.w.ctx.ledger.append(entry);
    expect(await f.classify()).toBe("self_answer_suspected");
  });
}

for (const [name, change] of [
  [
    "body edit",
    (f) => {
      f.c.body = "Publish rule b instead.";
    },
  ],
  [
    "different comment",
    (f) => {
      f.c.id = "new-comment";
    },
  ],
  [
    "createdAt change",
    (f) => {
      f.c.createdAt = "2026-10-06T09:41:00.000Z";
    },
  ],
  [
    "re-asked question",
    (f) => {
      f.q.askedAt = "2026-10-06T09:06:00.000Z";
    },
  ],
  [
    "new cycle",
    (f) => {
      f.r.cycle += 1;
    },
  ],
  [
    "new attempt",
    (f) => {
      f.r.coordinator.attempt += 1;
    },
  ],
] satisfies [string, (f: Awaited<ReturnType<typeof pending>>) => void][]) {
  test(`${name} does not inherit an earlier accepted answer`, async () => {
    const f = await pending();
    await f.w.ctx.ledger.append(f.authenticated);
    await f.w.ctx.ledger.append(f.delivered);
    change(f);
    expect(await f.classify()).toBe("self_answer_suspected");
  });
}

test("authorship checks run before even a supplied pending-answer exemption", () => {
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
  r.questions = [
    {
      id: "q",
      commentId: "cq",
      askedAt: "2026-10-06T09:05:00.000Z",
      status: "open",
      answerCommentId: "c",
      answeredAt: null,
      resumeAttempts: 1,
      nonAnswerCommentIds: [],
    },
  ];
  const c: LinearComment = {
    id: "c",
    issueId: "l",
    body: "a",
    createdAt: "2026-10-06T09:40:00.000Z",
    parentId: "cq",
    userId: "guest",
    botActorId: null,
    externalUserId: null,
  };
  expect(classifyComment(c, r, [OWNER], () => true, true)).toBe("unverified_author");
  expect(classifyComment({ ...c, userId: OWNER, botActorId: "app" }, r, [OWNER], () => true, true)).toBe(
    "ignore",
  );
  expect(
    classifyComment({ ...c, userId: OWNER, externalUserId: "external" }, r, [OWNER], () => true, true),
  ).toBe("ignore");
});
