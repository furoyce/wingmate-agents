// tests/unit/server/snapshot.test.ts — Unit tests for Wingmate Console snapshot aggregation.
import { describe, expect, test } from "bun:test";
import { buildSnapshot } from "../../../src/server/snapshot";
import { readRecord, writeRecord } from "../../../src/state/records";
import { labeledByOwner, runTick, todo, world } from "../../sim/harness";

describe("server snapshot", () => {
  test("builds empty snapshot cleanly when no active records exist", async () => {
    const w = await world();
    const snap = await buildSnapshot(w.dirs, w.cfg, w.clock, w.linear);

    expect(snap.funnel.inAgent).toBe(0);
    expect(snap.funnel.waitingOnHuman).toBe(0);
    expect(snap.activeWorktrees).toHaveLength(0);
    expect(snap.projects.length).toBeGreaterThan(0);
    expect(snap.automations.length).toBeGreaterThan(0);
  });

  test("aggregates active worktree, coordinator, and gate status", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-801"));
    await runTick(w);

    const record = await readRecord(w.dirs, "JRF-801");
    if (!record) throw new Error("record not created");

    // Add simulated roleJob and gate
    record.roleJobs.push({
      id: "01M4CTVA1ZC6W2RW3K2YS2VWPR",
      mode: "terminal-job",
      role: "plan-verifier",
      cycle: 1,
      attempt: 1,
      provider: "codex",
      status: "succeeded",
      launchUncertain: false,
      terminalHandle: null,
      paneKey: null,
      headSha: "0".repeat(40),
      planHash: "0".repeat(64),
      createdAt: w.ctx.now(),
      completedAt: w.ctx.now(),
      verdict: "PASS",
      reportPath: ".wingmate/evidence/plan.md",
      reportHash: "0".repeat(64),
      notified: true,
    });
    record.gates.plan.verdict = "PASS";
    await writeRecord(w.dirs, record);

    const snap = await buildSnapshot(w.dirs, w.cfg, w.clock, w.linear);

    expect(snap.funnel.inAgent).toBe(1);
    expect(snap.activeWorktrees).toHaveLength(1);
    const item = snap.activeWorktrees[0];
    expect(item?.identifier).toBe("JRF-801");
    expect(item?.provider).toBe("claude");
    expect(item?.roleJobs).toHaveLength(1);
    expect(item?.roleJobs[0]?.role).toBe("plan-verifier");
    expect(item?.gates.plan?.verdict).toBe("PASS");
  });

  test("populates triage items from Linear unassigned Todo issues", async () => {
    const w = await world();
    // Add an unlabeled todo issue in Linear
    const untriaged = todo("triage-1", "JRF-802");
    untriaged.labels = []; // No agent-ready or claude label
    w.linear.issues.set(untriaged.id, untriaged);

    const snap = await buildSnapshot(w.dirs, w.cfg, w.clock, w.linear);

    const found = snap.triage.find((t) => t.identifier === "JRF-802");
    expect(found).toBeDefined();
    expect(found?.recommendedProvider).toBe("claude");
    expect(snap.funnel.todo).toBeGreaterThanOrEqual(1);
  });
});
