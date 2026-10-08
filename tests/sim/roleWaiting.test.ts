import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { listIntents, writeIntent } from "../../src/kit/intents";
import { roleJobDir } from "../../src/machine/roles";
import { readRecord, writeRecord } from "../../src/state/records";
import { OWNER, type World, advance, labeledByOwner, runTick, todo, world } from "./harness";

const ID = "JRF-501";
async function record(w: World) {
  const r = await readRecord(w.dirs, ID);
  if (!r?.worktree) throw new Error("working fixture missing");
  return { r, wt: r.worktree };
}
const calls = (w: World, verb: string) => w.orca.calls.filter((c) => c.verb === verb).length;
async function setup() {
  const w = await world();
  labeledByOwner(w, todo("i1", ID));
  await runTick(w);
  const { r, wt } = await record(w);
  if (!r.coordinator.paneKey) throw new Error("coordinator pane missing");
  w.orca.setAgentState(wt.id, r.coordinator.paneKey, "done", w.ctx.now());
  r.timers.capMin = 2;
  await writeRecord(w.dirs, r);
  writeFileSync(join(wt.path, ".wingmate/plan.md"), "Review the scoring rule and tie tests.");
  const request = await writeIntent(wt.path, {
    issue: ID,
    kind: "spawn",
    payload: { role: "plan-verifier", spec: "Verify the plan.", prefer: null, deps: [] },
  });
  return { w, request };
}
async function finish(w: World, id: string) {
  const { r } = await record(w);
  const dir = roleJobDir(w.ctx, r, id);
  writeFileSync(
    join(dir, "stdout"),
    [
      { type: "item.completed", item: { type: "agent_message", text: "PASS\nReviewed the plan." } },
      { type: "turn.completed", usage: { input_tokens: 12, output_tokens: 4 } },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n"),
  );
  writeFileSync(join(dir, "exit"), "0\n");
}

describe("review waves intentionally idle the coordinator", () => {
  test("a live review defers idle recovery and owner notes across stage and grace caps", async () => {
    const { w, request } = await setup();
    const sent = calls(w, "terminalSend");
    advance(w, 5);
    await runTick(w);
    expect((await record(w)).r.roleJobs[0]?.status).toBe("running");
    advance(w, 1);
    w.linear.humanComment("i1", "Keep the existing scoring API.", OWNER, w.ctx.now());
    for (let n = 0; n < 12; n++) {
      advance(w, 5);
      const summary = await runTick(w);
      expect(summary.relaunches).toEqual([]);
      expect(summary.handoffs).toEqual([]);
      expect(summary.resumes).toEqual([]);
    }
    const waiting = (await record(w)).r;
    expect(waiting.stage).toBe("working");
    expect(waiting.timers.nudges).toBe(0);
    expect(waiting.timers.graceEndsAt).toBeNull();
    expect(waiting.attention).not.toContain("cap_passed");
    expect(calls(w, "terminalSend")).toBe(sent);
    expect(calls(w, "terminalCreate")).toBe(2);
    expect(
      (await w.ctx.ledger.readIssue(ID)).filter((e) => e.type === "delivered" && e.data.kind === "note"),
    ).toHaveLength(0);
    await finish(w, request.id);
    advance(w, 5);
    expect((await runTick(w)).resumes).toEqual([ID]);
    const resumed = (await record(w)).r;
    expect(resumed.roleJobs[0]?.notified).toBe(true);
    expect(resumed.timers.stageStartedAt).toBe(w.ctx.now());
    expect(resumed.timers.lastActivityAt).toBe(w.ctx.now());
    expect(resumed.linear.lastSeenCommentAt).not.toBe(waiting.linear.lastSeenCommentAt);
  });

  test("quota-deferred requests do not nudge, relaunch or hand off before launching and settling", async () => {
    const { w, request } = await setup();
    const sent = calls(w, "terminalSend");
    for (const limits of Object.values(w.orca.rateLimits))
      if (limits?.windows.weekly) limits.windows.weekly.usedPercent = 100;
    for (let n = 0; n < 14; n++) {
      advance(w, 5);
      const summary = await runTick(w);
      expect(summary.relaunches).toEqual([]);
      expect(summary.handoffs).toEqual([]);
      expect(summary.resumes).toEqual([]);
    }
    const { r, wt } = await record(w);
    expect(r.stage).toBe("working");
    expect(r.roleJobs).toEqual([]);
    expect(r.timers.nudges).toBe(0);
    expect(r.timers.graceEndsAt).toBeNull();
    expect(calls(w, "terminalSend")).toBe(sent);
    expect(calls(w, "terminalCreate")).toBe(1);
    expect((await listIntents(wt.path)).map((i) => i.id)).toEqual([request.id]);
    for (const limits of Object.values(w.orca.rateLimits))
      if (limits?.windows.weekly) limits.windows.weekly.usedPercent = 0;
    advance(w, 5);
    await runTick(w);
    expect(calls(w, "terminalCreate")).toBe(2);
    await finish(w, request.id);
    advance(w, 5);
    expect((await runTick(w)).resumes).toEqual([ID]);
  });

  test("stale jobs from an earlier attempt do not suppress ordinary coordinator recovery", async () => {
    const { w } = await setup();
    advance(w, 5);
    await runTick(w);
    const { r } = await record(w);
    const job = r.roleJobs[0];
    if (!job) throw new Error("review job missing");
    job.attempt = r.coordinator.attempt - 1;
    r.timers.capMin = 600;
    await writeRecord(w.dirs, r);
    const sent = calls(w, "terminalSend");
    advance(w, 15);
    await runTick(w);
    expect(calls(w, "terminalSend")).toBe(sent + 1);
    expect((await record(w)).r.timers.nudges).toBe(1);
  });

  test("waiting for a review retains integrity and hard-budget blocking controls", async () => {
    for (const cause of ["kit_tampered", "budget"] as const) {
      const { w } = await setup();
      advance(w, 5);
      await runTick(w);
      const { r, wt } = await record(w);
      if (cause === "kit_tampered") writeFileSync(join(wt.path, ".wingmate/PROTOCOL.md"), "tampered");
      else {
        r.budget.hardTokens = 1;
        r.usage.bySession = [
          {
            role: "coordinator",
            provider: r.provider,
            sessionRef: r.coordinator.sessionId ?? r.coordinator.terminalHandle ?? "coordinator",
            tokens: 2,
            costUsd: null,
            agentMinutes: 0,
            provenance: "measured-transcript",
          },
        ];
        await writeRecord(w.dirs, r);
      }
      advance(w, 5);
      expect((await runTick(w)).blocked).toEqual([ID]);
      const blocked = (await record(w)).r;
      expect(blocked.stage).toBe("blocked");
      expect(blocked.history.at(-1)?.cause).toBe(cause);
      expect(blocked.roleJobs[0]?.status).toBe("failed");
    }
  });
});
