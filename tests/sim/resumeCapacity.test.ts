// §9.5 working caps gate new claims; owned answers resume first, within the shared per-tick budget.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeIntent } from "../../src/kit/intents";
import { type WRecord, listRecords, readRecord } from "../../src/state/records";
import { OWNER, type World, advance, labeledByOwner, runTick, todo, world } from "./harness";

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) rmSync(w.root, { recursive: true, force: true });
});

async function scenario() {
  const w = await world();
  worlds.push(w);
  return w;
}

async function record(w: World, identifier: string): Promise<WRecord> {
  const r = await readRecord(w.dirs, identifier);
  if (!r?.worktree || !r.coordinator.terminalHandle) throw new Error(`${identifier}: no coordinator`);
  return r;
}

function candidate(w: World, id: string, identifier: string, project: string) {
  const cfg = w.cfg.projects[project];
  if (!cfg) throw new Error(`unknown project ${project}`);
  labeledByOwner(w, todo(id, identifier, { projectId: cfg.linearProject }));
}

async function claim(w: World, id: string, identifier: string, project: string) {
  candidate(w, id, identifier, project);
  advance(w, 5);
  expect((await runTick(w)).claims).toEqual([identifier]);
  const r = await record(w, identifier);
  expect(r).toMatchObject({ stage: "working", provider: "claude" });
  return r;
}

async function park(w: World, r: WRecord) {
  const wt = r.worktree;
  if (!wt) throw new Error("worktree required");
  w.orca.setAgentState(wt.id, r.coordinator.paneKey ?? "", "done", w.ctx.now());
  writeFileSync(join(wt.path, ".wingmate", "question.md"), "Which scoring rule should the tests preserve?");
  await writeIntent(wt.path, {
    issue: r.identifier,
    kind: "ask",
    payload: {
      questionFile: ".wingmate/question.md",
      options: ["existing rule", "revised rule"],
      recommend: 1,
      append: null,
      reask: null,
    },
  });
  advance(w, 5);
  expect((await runTick(w)).parked).toEqual([r.identifier]);
  const parked = await record(w, r.identifier);
  expect(parked).toMatchObject({ stage: "awaiting-human" });
  expect(parked.questions[0]?.status).toBe("open");
  return parked;
}

function answer(w: World, r: WRecord) {
  const question = r.questions[0];
  if (!question) throw new Error("open question required");
  return w.linear.humanComment(
    r.linearId,
    `Preserve the existing rule for ${r.identifier}.`,
    OWNER,
    w.ctx.now(),
    question.commentId,
  );
}

function sends(w: World, r: WRecord) {
  return w.orca.calls.filter(
    (c) => c.verb === "terminalSend" && (c.args as { h: string }).h === r.coordinator.terminalHandle,
  ).length;
}

function inboxAnswers(r: WRecord) {
  if (!r.worktree) throw new Error("worktree required");
  return readdirSync(join(r.worktree.path, ".wingmate", "inbox")).filter((name) =>
    name.startsWith("answer-"),
  );
}

describe("§9.5 owned answers and claim admission", () => {
  const cases = [
    {
      name: "global cap already full",
      caps: { global: 2, perProvider: 2, perProject: 1 },
      workingProjects: ["smart-dispatcher", "jr-learning-plus"],
      candidateProject: "jr-travel-atlas",
      reason: "cap_global",
    },
    {
      name: "fresh post-resume counts fill the global cap",
      caps: { global: 3, perProvider: 4, perProject: 1 },
      workingProjects: ["smart-dispatcher", "jr-learning-plus"],
      candidateProject: "jr-travel-atlas",
      reason: "cap_global",
    },
    {
      name: "provider cap already full",
      caps: { global: 4, perProvider: 2, perProject: 1 },
      workingProjects: ["smart-dispatcher", "jr-learning-plus"],
      candidateProject: "jr-travel-atlas",
      reason: "cap_provider",
    },
    {
      name: "project cap already full",
      caps: { global: 4, perProvider: 4, perProject: 1 },
      workingProjects: ["bouncr", "smart-dispatcher"],
      candidateProject: "bouncr",
      reason: "cap_project",
    },
  ];

  for (const c of cases) {
    test(`${c.name}: authenticated answer resumes; a new claim waits`, async () => {
      const w = await scenario();
      w.cfg.defaults.concurrency.maxWorking = { ...c.caps };
      for (const p of Object.values(w.cfg.projects)) p.concurrency.maxWorking = { ...c.caps };

      const parked = await park(w, await claim(w, "parked", "JRF-901", "bouncr"));
      for (const [i, project] of c.workingProjects.entries())
        await claim(w, `working-${i}`, `JRF-${902 + i}`, project);
      expect((await listRecords(w.dirs)).filter((r) => r.stage === "working")).toHaveLength(2);

      candidate(w, "new", "JRF-904", c.candidateProject);
      advance(w, 1);
      const reply = answer(w, parked);
      const before = sends(w, parked);
      const launches = w.orca.calls.filter((call) => call.verb === "terminalCreate").length;
      advance(w, 4);
      const tick = await runTick(w);

      expect(tick.resumes).toEqual([parked.identifier]);
      expect(tick.claims).toEqual([]);
      expect(tick.skipped).toContainEqual({ identifier: "JRF-904", reason: c.reason });
      expect(await readRecord(w.dirs, "JRF-904")).toBeNull();
      const resumed = await record(w, parked.identifier);
      expect(resumed).toMatchObject({ stage: "working", cycle: parked.cycle, provider: "claude" });
      expect(resumed.coordinator.terminalHandle).toBe(parked.coordinator.terminalHandle);
      expect(resumed.questions[0]).toMatchObject({ status: "answered", answerCommentId: reply.id });
      expect(sends(w, parked)).toBe(before + 1);
      expect(w.orca.calls.filter((call) => call.verb === "terminalCreate")).toHaveLength(launches);
      const working = (await listRecords(w.dirs)).filter((r) => r.stage === "working");
      expect(working).toHaveLength(3);
      expect(working.every((r) => r.provider === "claude")).toBe(true);
      if (c.reason === "cap_project") expect(working.filter((r) => r.project === "bouncr")).toHaveLength(2);
    });
  }

  test("one resume per tick preserves the second authenticated answer until the next tick", async () => {
    const w = await scenario();
    const first = await park(w, await claim(w, "first", "JRF-901", "bouncr"));
    const second = await park(w, await claim(w, "second", "JRF-902", "smart-dispatcher"));
    w.cfg.defaults.dispatcher.resumesPerTick = 1;
    advance(w, 1);
    const parked = [first, second];
    const replies = new Map(parked.map((r) => [r.identifier, answer(w, r)]));
    const before = new Map(parked.map((r) => [r.identifier, sends(w, r)]));
    advance(w, 4);
    const tick = await runTick(w);
    expect(tick.resumes).toHaveLength(1);
    // Record iteration order is not part of the contract: whichever answer is second must remain durable.
    const delivered = parked.find((r) => tick.resumes.includes(r.identifier));
    const waiting = parked.find((r) => !tick.resumes.includes(r.identifier));
    if (!delivered?.worktree || !waiting?.worktree)
      throw new Error("one delivered and one deferred required");
    expect((await record(w, delivered.identifier)).questions[0]).toMatchObject({
      status: "answered",
      answerCommentId: replies.get(delivered.identifier)?.id,
    });
    w.orca.setAgentState(delivered.worktree.id, delivered.coordinator.paneKey ?? "", "working", w.ctx.now());
    const deferred = await record(w, waiting.identifier);
    expect(deferred).toMatchObject({ stage: "awaiting-human" });
    expect(deferred.questions[0]).toMatchObject({ status: "open", resumeAttempts: 0, answerCommentId: null });
    expect(deferred.linear.lastSeenCommentAt).toBe(waiting.linear.lastSeenCommentAt);
    expect(sends(w, waiting)).toBe(before.get(waiting.identifier) ?? 0);
    expect(inboxAnswers(deferred)).toEqual([]);

    // No new owner comment: the same durable second answer is picked up from the unchanged cursor.
    advance(w, 5);
    expect((await runTick(w)).resumes).toEqual([waiting.identifier]);
    const resumed = await record(w, waiting.identifier);
    expect(resumed.stage).toBe("working");
    expect(resumed.coordinator.terminalHandle).toBe(waiting.coordinator.terminalHandle);
    expect(resumed.questions[0]).toMatchObject({
      status: "answered",
      resumeAttempts: 1,
      answerCommentId: replies.get(waiting.identifier)?.id,
    });
    for (const r of parked) {
      const current = await record(w, r.identifier);
      const reply = replies.get(r.identifier);
      if (!current.worktree || !reply) throw new Error("original question and answer required");
      expect(current.questions[0]).toMatchObject({
        status: "answered",
        resumeAttempts: 1,
        answerCommentId: reply.id,
      });
      expect(sends(w, r)).toBe((before.get(r.identifier) ?? 0) + 1);
      const files = inboxAnswers(current);
      expect(files).toHaveLength(1);
      expect(
        readFileSync(join(current.worktree.path, ".wingmate", "inbox", files[0] ?? ""), "utf8"),
      ).toContain(reply.body);
    }
    expect(
      w.linear.comments.filter((c) => [...replies.values()].some((reply) => reply.id === c.id)),
    ).toHaveLength(2);
    w.orca.setAgentState(waiting.worktree.id, waiting.coordinator.paneKey ?? "", "working", w.ctx.now());

    advance(w, 5);
    expect((await runTick(w)).resumes).toEqual([]);
    for (const r of parked) expect(sends(w, r)).toBe((before.get(r.identifier) ?? 0) + 1);
    expect(inboxAnswers(await record(w, waiting.identifier))).toHaveLength(1);
  });
});
