import { expect, test } from "bun:test";
import { existsSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeIntent } from "../../src/kit/intents";
import { readRecord } from "../../src/state/records";
import { OWNER, advance, labeledByOwner, runTick, todo, world } from "./harness";

test("an accepted owner answer that starts activity within 60 seconds is confirmed without reclassification or resend", async () => {
  const w = await world();
  labeledByOwner(w, todo("i1", "JRF-501"));
  await runTick(w);
  const claimed = await readRecord(w.dirs, "JRF-501");
  if (!claimed?.worktree || !claimed.coordinator.paneKey) throw new Error("coordinator required");
  w.orca.setAgentState(claimed.worktree.id, claimed.coordinator.paneKey, "done", w.ctx.now());
  writeFileSync(join(claimed.worktree.path, ".wingmate/q.md"), "Which scoring rule?");
  await writeIntent(claimed.worktree.path, {
    issue: claimed.identifier,
    kind: "ask",
    payload: { questionFile: ".wingmate/q.md", options: ["a", "b"], recommend: 1, append: null, reask: null },
  });
  advance(w, 5);
  await runTick(w);
  const parked = await readRecord(w.dirs, claimed.identifier);
  if (!parked?.questions[0]) throw new Error("open question required");
  advance(w, 5);
  const reply = w.linear.humanComment("i1", "a", OWNER, w.ctx.now(), parked.questions[0].commentId);
  w.orca.nextSendStage = "input_accepted";
  w.clock.advance(5_000);
  await runTick(w);
  const pending = await readRecord(w.dirs, claimed.identifier);
  expect(pending).toMatchObject({ stage: "awaiting-human", attention: ["resume_unconfirmed"] });
  expect(pending?.questions[0]).toMatchObject({ answerCommentId: reply.id, resumeAttempts: 1 });
  const sends = w.orca.calls.filter((c) => c.verb === "terminalSend").length;
  const sweeps = w.sweeps.length;
  w.orca.setAgentState(claimed.worktree.id, claimed.coordinator.paneKey, "working", w.ctx.now());
  w.clock.advance(5_000);
  const settled = await runTick(w);
  expect(settled.resumes).toEqual([claimed.identifier]);
  expect(settled.blocked).toEqual([]);
  expect(w.orca.calls.filter((c) => c.verb === "terminalSend")).toHaveLength(sends);
  expect(w.sweeps).toHaveLength(sweeps);
  const current = await readRecord(w.dirs, claimed.identifier);
  expect(current?.stage).toBe("working");
  expect(current?.questions[0]).toMatchObject({
    status: "answered",
    answerCommentId: reply.id,
    resumeAttempts: 1,
  });
  expect(current?.attention).not.toContain("resume_unconfirmed");
  expect(current?.linear.lastSeenCommentAt).toBe(reply.createdAt);
});

async function awaitingAnswer() {
  const w = await world();
  labeledByOwner(w, todo("i1", "JRF-501"));
  await runTick(w);
  const r = await readRecord(w.dirs, "JRF-501");
  if (!r?.worktree || !r.coordinator.paneKey) throw new Error("coordinator required");
  const wt = r.worktree;
  w.orca.setAgentState(wt.id, r.coordinator.paneKey, "done", w.ctx.now());
  writeFileSync(join(wt.path, ".wingmate/q.md"), "Which scoring rule?");
  await writeIntent(wt.path, {
    issue: r.identifier,
    kind: "ask",
    payload: { questionFile: ".wingmate/q.md", options: ["a", "b"], recommend: 1, append: null, reask: null },
  });
  advance(w, 5);
  await runTick(w);
  const p = await readRecord(w.dirs, r.identifier);
  if (!p?.questions[0]) throw new Error("open question required");
  advance(w, 5);
  w.linear.humanComment("i1", "a", OWNER, w.ctx.now(), p.questions[0].commentId);
  return { w, r, wt };
}

for (const failure of ["deferred", "unsafe", "failed"] as const) {
  test(`a real ${failure} delivery attempt has no accepted-answer exemption`, async () => {
    const { w, r, wt } = await awaitingAnswer();
    if (failure === "deferred") w.orca.nextWaitSatisfied = false;
    if (failure === "failed") w.orca.failNext = "terminalSend";
    if (failure === "unsafe") {
      const target = join(w.root, "unsafe-inbox-target");
      mkdirSync(target);
      const inbox = join(wt.path, ".wingmate/inbox");
      if (existsSync(inbox)) renameSync(inbox, `${inbox}-saved`);
      symlinkSync(target, inbox);
    }
    w.clock.advance(5_000);
    await runTick(w, { allowErrors: failure === "failed" });
    expect(
      (await w.ctx.ledger.readIssue(r.identifier)).some(
        (event) => event.type === "delivered" && event.data.kind === "answer",
      ),
    ).toBe(false);
    w.orca.nextWaitSatisfied = true;
    w.orca.setAgentState(wt.id, r.coordinator.paneKey ?? "", "working", w.ctx.now());
    w.clock.advance(5_000);
    const settled = await runTick(w);
    expect(settled.resumes).toEqual([]);
    expect(settled.blocked).toEqual([r.identifier]);
    expect((await readRecord(w.dirs, r.identifier))?.history.at(-1)?.cause).toBe("self_answer_suspected");
  });
}

test("an actually accepted answer relaunch is also confirmed without resend inside the activity margin", async () => {
  const { w, r, wt } = await awaitingAnswer();
  w.orca.killTerminal(wt.id, r.coordinator.terminalHandle ?? "");
  w.orca.nextSendStage = "input_accepted";
  w.clock.advance(5_000);
  await runTick(w);
  const pending = await readRecord(w.dirs, r.identifier);
  if (!pending?.coordinator.paneKey) throw new Error("successor coordinator required");
  const count = w.orca.calls.filter((call) => call.verb === "terminalSend").length;
  w.orca.setAgentState(wt.id, pending.coordinator.paneKey, "working", w.ctx.now());
  w.clock.advance(5_000);
  const settled = await runTick(w);
  expect(settled.resumes).toEqual([r.identifier]);
  expect(settled.blocked).toEqual([]);
  expect(w.orca.calls.filter((call) => call.verb === "terminalSend")).toHaveLength(count);
  expect((await readRecord(w.dirs, r.identifier))?.questions[0]?.resumeAttempts).toBe(1);
});
