// tests/sim/scenarios.test.ts — §14.3 minimum scenario set; every runTick also asserts I1–I10
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeIntent } from "../../src/kit/intents";
import { block } from "../../src/machine/release";
import { type WRecord, readRecord, writeRecord } from "../../src/state/records";
import { OWNER, type World, advance, labeledByOwner, readyToFinish, runTick, todo, world } from "./harness";
import { assertInvariants, noAgentActivityWhileParked } from "./invariants";

async function rec(w: World, identifier = "JRF-501"): Promise<WRecord> {
  const r = await readRecord(w.dirs, identifier);
  if (!r) throw new Error(`no record ${identifier}`);
  return r;
}
async function claimed(w: World, id = "i1", identifier = "JRF-501"): Promise<WRecord> {
  labeledByOwner(w, todo(id, identifier));
  const s = await runTick(w);
  expect(s.claims).toEqual([identifier]);
  const r = await rec(w, identifier);
  expect(r.stage).toBe("working");
  return r;
}
const ask = async (_w: World, path: string, identifier: string) => {
  mkdirSync(join(path, ".wingmate"), { recursive: true });
  writeFileSync(join(path, ".wingmate", "q.md"), "Milliseconds or microseconds?");
  await writeIntent(path, {
    issue: identifier,
    kind: "ask",
    payload: {
      questionFile: ".wingmate/q.md",
      options: ["ms", "us"],
      recommend: 1,
      append: null,
      reask: null,
    },
  });
};
const statusCount = (w: World) =>
  w.linear.comments.filter((c) => c.body.startsWith("<!-- wingmate:status -->")).length;
const pane = (r: WRecord) => r.coordinator.paneKey ?? "";
const wtOf = (r: WRecord) => {
  if (!r.worktree) throw new Error(`${r.identifier} has no worktree`);
  return r.worktree;
};

describe("simulation", () => {
  test("S1 golden path: claim → ask → park (3 idle ticks) → answer → resume same handle → finish → review", async () => {
    const w = await world();
    const r = await claimed(w);
    const wt = wtOf(r);
    w.orca.setAgentState(wt.id, pane(r), "done", w.ctx.now());
    await ask(w, wt.path, r.identifier);
    advance(w, 5);
    let s = await runTick(w);
    expect(s.parked).toEqual([r.identifier]);
    const parked = await rec(w);
    expect(parked.stage).toBe("awaiting-human");
    expect(w.linear.issues.get("i1")?.labels.map((l) => l.name)).toContain("Needs-Human");
    const mark = w.orca.calls.length;
    for (let i = 0; i < 3; i++) {
      advance(w, 5);
      s = await runTick(w);
      expect(s.outcome).toBe("idle");
    }
    noAgentActivityWhileParked(w, mark, r.identifier);
    advance(w, 5);
    w.linear.humanComment("i1", "1", OWNER, w.ctx.now(), parked.questions[0]?.commentId ?? null);
    advance(w, 5);
    s = await runTick(w);
    expect(s.resumes).toEqual([r.identifier]);
    const resumed = await rec(w);
    expect(resumed.stage).toBe("working");
    expect(resumed.coordinator.terminalHandle).toBe(r.coordinator.terminalHandle);
    expect(resumed.questions[0]?.status).toBe("answered");
    await readyToFinish(w, r.identifier);
    await writeIntent(wt.path, {
      issue: r.identifier,
      kind: "finish",
      payload: { summaryFile: ".wingmate/s.md", title: null, draft: false, repos: [] },
    });
    w.orca.setAgentState(wt.id, pane(r), "done", w.ctx.now());
    advance(w, 5);
    s = await runTick(w);
    expect(s.finished).toEqual([r.identifier]);
    expect((await rec(w)).stage).toBe("review");
    expect(w.linear.issues.get("i1")?.state.name).toBe("In Review");
    await assertInvariants(w);
  });

  test("S2 answer with the terminal gone → successor in the same worktree", async () => {
    const w = await world();
    const r = await claimed(w);
    const wt = wtOf(r);
    w.orca.setAgentState(wt.id, pane(r), "done", w.ctx.now());
    await ask(w, wt.path, r.identifier);
    advance(w, 5);
    await runTick(w);
    w.orca.killTerminal(wt.id, r.coordinator.terminalHandle ?? "");
    const q = (await rec(w)).questions[0];
    advance(w, 5);
    w.linear.humanComment("i1", "2", OWNER, w.ctx.now(), q?.commentId ?? null);
    advance(w, 5);
    const s = await runTick(w);
    expect(s.resumes).toEqual([r.identifier]);
    const after = await rec(w);
    expect(after.coordinator.terminalHandle).not.toBe(r.coordinator.terminalHandle);
    expect(after.worktree?.id).toBe(wt.id);
    expect(after.coordinator.relaunches).toBe(1);
    expect(after.stage).toBe("working");
    await assertInvariants(w);
  });

  test("S3 exited → relaunch → exited → handoff → exited → relaunch → exited → blocked, no launch after", async () => {
    const w = await world();
    const r = await claimed(w);
    const wt = wtOf(r);
    const launches = () => w.orca.calls.filter((c) => c.verb === "terminalCreate").length;
    w.orca.killTerminal(wt.id, r.coordinator.terminalHandle ?? "");
    advance(w, 5);
    let s = await runTick(w);
    expect(s.relaunches).toEqual([r.identifier]);
    let cur = await rec(w);
    w.orca.killTerminal(wt.id, cur.coordinator.terminalHandle ?? "");
    advance(w, 5);
    s = await runTick(w);
    expect(s.handoffs).toEqual([r.identifier]);
    cur = await rec(w);
    expect(cur.provider).toBe("codex");
    expect(cur.coordinator.attempt).toBe(2);
    expect(w.linear.comments.filter((c) => c.body.startsWith("<!-- wingmate:handoff -->"))).toHaveLength(1);
    w.orca.killTerminal(wt.id, cur.coordinator.terminalHandle ?? "");
    advance(w, 5);
    s = await runTick(w);
    expect(s.relaunches).toEqual([r.identifier]);
    cur = await rec(w);
    w.orca.killTerminal(wt.id, cur.coordinator.terminalHandle ?? "");
    advance(w, 5);
    s = await runTick(w);
    expect(s.blocked).toEqual([r.identifier]);
    expect((await rec(w)).history.at(-1)?.cause).toBe("cascade_exhausted");
    const n = launches();
    advance(w, 5);
    await runTick(w);
    expect(launches()).toBe(n);
    expect((await rec(w)).stage).toBe("blocked");
    await assertInvariants(w);
  });

  test("S4 owner adds `human` mid-run with live workers → full release", async () => {
    const w = await world();
    const r = await claimed(w);
    const run = "run_child";
    const cur = await rec(w);
    cur.coordinator.childRunId = run;
    await writeRecord(w.dirs, cur);
    w.orca.workers.set(run, [
      {
        dispatchId: "ctx_1",
        taskId: "task_1",
        runId: run,
        workerState: "running",
        dispatchStatus: "active",
        agentTerminalHandle: "term_w",
        verdict: "live",
      },
    ]);
    advance(w, 5);
    w.linear.setLabels("i1", ["human"], OWNER, w.ctx.now());
    advance(w, 5);
    const s = await runTick(w);
    expect(s.released).toEqual([r.identifier]);
    expect(w.orca.calls.some((c) => c.verb === "workerStop")).toBe(true);
    expect(w.orca.closed).toContain(wtOf(r).id);
    expect(w.swept).toContain(wtOf(r).path);
    expect((await rec(w)).stage).toBe("released");
    await assertInvariants(w);
  });

  test("S5 answer by a non-approver is never forwarded", async () => {
    const w = await world();
    const r = await claimed(w);
    const wt = wtOf(r);
    w.orca.setAgentState(wt.id, pane(r), "done", w.ctx.now());
    await ask(w, wt.path, r.identifier);
    advance(w, 5);
    await runTick(w);
    const q = (await rec(w)).questions[0];
    advance(w, 5);
    w.linear.humanComment("i1", "1", "guest-user", w.ctx.now(), q?.commentId ?? null);
    advance(w, 5);
    const mark = w.orca.calls.length;
    const s = await runTick(w);
    expect(s.resumes).toEqual([]);
    noAgentActivityWhileParked(w, mark, r.identifier);
    expect((await rec(w)).attention.some((a) => a.startsWith("unverified_input"))).toBe(true);
    await assertInvariants(w);
  });

  test("S6 answer created while an agent was working → self-answer suspected → blocked until confirmed", async () => {
    const w = await world();
    const r = await claimed(w);
    const wt = wtOf(r);
    w.orca.setAgentState(wt.id, pane(r), "done", w.ctx.now());
    await ask(w, wt.path, r.identifier);
    advance(w, 5);
    await runTick(w);
    const q = (await rec(w)).questions[0];
    advance(w, 5);
    w.orca.setAgentState(wt.id, pane(r), "working", w.ctx.now());
    w.linear.humanComment("i1", "1", OWNER, w.ctx.now(), q?.commentId ?? null);
    const s = await runTick(w);
    expect(s.blocked).toEqual([r.identifier]);
    const b = await rec(w);
    expect(b.history.at(-1)?.cause).toBe("self_answer_suspected");
    expect(b.questions[0]?.nonAnswerCommentIds).toHaveLength(1);
    advance(w, 5);
    w.orca.setAgentState(wt.id, pane(r), "done", w.ctx.now());
    advance(w, 5);
    w.linear.humanComment("i1", "continue", OWNER, w.ctx.now());
    advance(w, 5);
    const s2 = await runTick(w);
    expect(s2.resumes).toEqual([r.identifier]);
    expect(s2.handoffs).toEqual([]);
    const resumed = await rec(w);
    expect(resumed.stage).toBe("working");
    expect(resumed.questions[0]?.status).toBe("answered");
    await assertInvariants(w);
  });

  test("S7 crash between claim steps → replay completes without a second worktree or status comment", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-501"));
    w.orca.nextWaitSatisfied = false;
    await runTick(w); // launch_not_ready → record stays claimed
    expect((await rec(w)).stage).toBe("claimed");
    w.orca.nextWaitSatisfied = true;
    advance(w, 5);
    const s = await runTick(w);
    expect(s.resumes).toEqual(["JRF-501"]);
    expect(w.orca.calls.filter((c) => c.verb === "worktreeCreate").length).toBe(1);
    expect(w.orca.calls.filter((c) => c.verb === "terminalCreate").length).toBe(1);
    expect(statusCount(w)).toBe(1);
    expect((await rec(w)).stage).toBe("working");
    await assertInvariants(w);
  });

  test("S7b terminal create fails after the worktree and kit steps → the replay launches once; one worktree, one status comment", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-501"));
    w.orca.failNext = "terminalCreate";
    const s1 = await runTick(w);
    expect(s1.attention).toContainEqual({ identifier: "JRF-501", code: "claim_failed" });
    const half = await rec(w);
    expect(half.stage).toBe("claimed");
    expect(half.worktree).not.toBeNull();
    advance(w, 5);
    const s2 = await runTick(w);
    expect(s2.resumes).toEqual(["JRF-501"]);
    expect(w.orca.calls.filter((c) => c.verb === "worktreeCreate").length).toBe(1);
    expect(statusCount(w)).toBe(1);
    expect((await rec(w)).stage).toBe("working");
  });

  test("S7c crash between worktree create and its record write → the replay adopts the issue's worktree", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-501"));
    w.orca.failNext = "worktreeShow";
    await runTick(w);
    expect((await rec(w)).worktree).toBeNull();
    advance(w, 5);
    await runTick(w);
    expect(w.orca.calls.filter((c) => c.verb === "worktreeCreate").length).toBe(1);
    expect((await rec(w)).stage).toBe("working");
    expect(statusCount(w)).toBe(1);
  });

  test("F4: a re-queued issue's new cycle replays its own claim entry, never the stuck one of the previous cycle", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-501"));
    w.orca.nextWaitSatisfied = false;
    await runTick(w);
    advance(w, 5);
    await runTick(w); // cycle 1: two failed launch steps (its entry at attempts 2)
    const c1 = await rec(w);
    w.orca.setAgentState(wtOf(c1).id, pane(c1), "done", w.ctx.now());
    advance(w, 5);
    w.linear.setState("i1", "Todo", OWNER, w.ctx.now());
    advance(w, 5);
    expect((await runTick(w)).released).toEqual(["JRF-501"]);
    advance(w, 5);
    expect((await runTick(w)).claims).toEqual(["JRF-501"]); // cycle 2: one failed launch step
    expect((await rec(w)).cycle).toBe(2);
    w.orca.nextWaitSatisfied = true;
    advance(w, 5);
    const s = await runTick(w);
    expect(s.blocked).toEqual([]);
    const r = await rec(w);
    expect(r).toMatchObject({ stage: "working", cycle: 2 });
    expect(r.history.map((h) => h.cause)).not.toContain("launch_failed");
    const claims = (await w.ctx.journal.all()).filter((e) => e.kind === "claim");
    expect(claims.map((e) => [e.key, e.state])).toEqual([
      ["claim:JRF-501:1:1", "abandoned"],
      ["claim:JRF-501:2:1", "confirmed"],
    ]);
  });

  test("F4: a new cycle whose Linear step failed gets that step on replay (the stale cycle's step states are never used)", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-501"));
    w.orca.nextWaitSatisfied = false;
    await runTick(w); // cycle 1: Linear done, launch not ready
    const c1 = await rec(w);
    w.orca.setAgentState(wtOf(c1).id, pane(c1), "done", w.ctx.now());
    advance(w, 5);
    w.linear.setState("i1", "Todo", OWNER, w.ctx.now());
    advance(w, 5);
    expect((await runTick(w)).released).toEqual(["JRF-501"]);
    w.orca.nextWaitSatisfied = true;
    w.linear.failNext = "issueUpdate";
    advance(w, 5);
    const claim2 = await runTick(w);
    expect(claim2.attention).toContainEqual({ identifier: "JRF-501", code: "claim_failed" });
    expect(w.linear.issues.get("i1")?.state.name).toBe("Todo");
    advance(w, 5);
    await runTick(w);
    expect(await rec(w)).toMatchObject({ stage: "working", cycle: 2 });
    expect(w.linear.issues.get("i1")?.state.name).toBe("In Progress");
    expect(w.linear.issues.get("i1")?.labels.map((l) => l.name)).toContain("In-Agent");
  });

  test("S8 cap + grace: activity prevents the stop; silence hands off", async () => {
    const w = await world();
    const r = await claimed(w);
    const cur = await rec(w);
    cur.pipelineStage = "plan";
    cur.timers.capMin = 45;
    cur.timers.stageStartedAt = w.ctx.now();
    await writeRecord(w.dirs, cur);
    for (let m = 0; m < 50; m += 5) {
      advance(w, 5);
      await runTick(w);
    }
    expect((await rec(w)).attention).toContain("cap_passed");
    // the coordinator keeps working through the grace period: never stopped by a timer (§9.6)
    w.orca.setAgentState(wtOf(r).id, pane(r), "working", w.ctx.now());
    for (let m = 0; m < 35; m += 5) {
      advance(w, 5);
      const s = await runTick(w);
      expect(s.handoffs).toEqual([]);
      expect(s.blocked).toEqual([]);
      expect(s.reconcileOnly).toBe(false);
    }
    const quiet = await rec(w);
    quiet.timers.graceEndsAt = new Date(Date.parse(w.ctx.now()) - 60_000).toISOString();
    quiet.timers.lastActivityAt = new Date(Date.parse(w.ctx.now()) - 60 * 60_000).toISOString();
    await writeRecord(w.dirs, quiet);
    w.orca.setAgentState(wtOf(r).id, pane(r), "done", quiet.timers.lastActivityAt);
    advance(w, 5);
    const s = await runTick(w);
    expect(s.handoffs).toEqual([r.identifier]);
    await assertInvariants(w);
  });

  test("S9 Linear write fails mid-finish → retried next tick, exactly one completion comment", async () => {
    const w = await world();
    const r = await claimed(w);
    await readyToFinish(w, r.identifier);
    await writeIntent(wtOf(r).path, {
      issue: r.identifier,
      kind: "finish",
      payload: { summaryFile: ".wingmate/s.md", title: null, draft: false, repos: [] },
    });
    w.linear.failNext = "issueUpdate";
    advance(w, 5);
    let s = await runTick(w);
    expect(s.finished).toEqual([]);
    advance(w, 5);
    s = await runTick(w);
    expect(s.finished).toEqual([r.identifier]);
    expect(
      w.linear.comments.filter((c) => c.body.startsWith("<!-- wingmate:completion -->")).length,
    ).toBeLessThanOrEqual(1);
    await assertInvariants(w);
  });

  test("S10 re-claim of a blocked issue after the owner re-queues it reuses the worktree and starts a new cycle", async () => {
    const w = await world();
    const r = await claimed(w);
    const [snapshotIssue] = await w.linear.getIssues(["i1"]);
    if (!snapshotIssue) throw new Error("issue missing");
    await block(w.ctx, await rec(w), snapshotIssue, "cascade_exhausted", "test", "re-queue");
    advance(w, 5);
    w.linear.setLabels("i1", ["agent-ready"], OWNER, w.ctx.now());
    w.linear.setState("i1", "Todo", OWNER, w.ctx.now());
    w.linear.history.get("i1")?.push({
      id: "hx",
      createdAt: w.ctx.now(),
      actorId: OWNER,
      botActorId: null,
      botActorType: null,
      addedLabelIds: ["lb-agent-ready"],
      removedLabelIds: [],
      fromStateId: null,
      toStateId: null,
    });
    advance(w, 5);
    const s = await runTick(w);
    expect(s.claims).toEqual([r.identifier]);
    const again = await rec(w);
    expect(again.cycle).toBe(2);
    expect(again.worktree?.id).toBe(wtOf(r).id);
    expect(again.linear.statusCommentId).toBe(r.linear.statusCommentId);
    expect(w.orca.calls.filter((c) => c.verb === "worktreeCreate").length).toBe(1);
    await assertInvariants(w);
  });

  test("S11 partial fleet read → reconcile-only tick (no claims, no relaunch of an unverifiable coordinator)", async () => {
    const w = await world();
    const r = await claimed(w);
    w.orca.killTerminal(wtOf(r).id, r.coordinator.terminalHandle ?? "");
    labeledByOwner(w, todo("i2", "JRF-502"));
    w.orca.partial = true;
    advance(w, 5);
    const s = await runTick(w);
    expect(s.reconcileOnly).toBe(true);
    expect(s.reason).toBe("partial_fleet");
    expect(s.claims).toEqual([]);
    expect(s.relaunches).toEqual([]);
    expect((await rec(w)).attention).toContain("liveness_unverifiable");
  });

  test("S12 default provider over quota at claim → cascade picks the other provider", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-501"));
    const claude = w.orca.rateLimits.claude;
    if (!claude) throw new Error("claude limits missing");
    claude.windows.weekly = { usedPercent: 95, windowMinutes: 10080, resetsAt: null };
    const s = await runTick(w);
    expect(s.claims).toEqual(["JRF-501"]);
    expect((await rec(w)).provider).toBe("codex");
  });

  test("S13 first launch blocked by the folder-trust dialog → Down, Enter, never the brief; then working", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-501"));
    w.orca.nextWaitSatisfied = false;
    w.orca.nextBlockedReason = "agent-trust-workspace";
    const s = await runTick(w);
    expect(s.claims).toEqual(["JRF-501"]);
    const verbs = w.orca.calls.map((c) => c.verb);
    expect(verbs.filter((v) => v === "terminalKeys").length).toBe(2);
    expect(verbs.indexOf("terminalSend")).toBeGreaterThan(verbs.lastIndexOf("terminalKeys"));
    expect((await rec(w)).stage).toBe("working");
    await assertInvariants(w);
  });

  test("Review Focus 2: a parked issue does not hold the project slot", async () => {
    const w = await world();
    const r = await claimed(w);
    const wt = wtOf(r);
    w.orca.setAgentState(wt.id, pane(r), "done", w.ctx.now());
    await ask(w, wt.path, r.identifier);
    advance(w, 5);
    await runTick(w);
    labeledByOwner(w, todo("i2", "JRF-502"));
    advance(w, 5);
    const s = await runTick(w);
    expect(s.claims).toEqual(["JRF-502"]);
    await assertInvariants(w);
  });

  test("Review Focus 2b: while one Bouncr issue works, a second waits with cap_project naming the slot holder", async () => {
    const w = await world();
    await claimed(w);
    labeledByOwner(w, todo("i2", "JRF-502"));
    advance(w, 5);
    const s = await runTick(w);
    expect(s.claims).toEqual([]);
    expect(s.skipped).toContainEqual({ identifier: "JRF-502", reason: "cap_project" });
  });
});
