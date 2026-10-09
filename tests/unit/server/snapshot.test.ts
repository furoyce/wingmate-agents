import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildSnapshot } from "../../../src/server/snapshot";
import { writeAtomic } from "../../../src/state/fs";
import { writeHeartbeat } from "../../../src/state/heartbeat";
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
    expect(item?.linearUrl).toBe("https://linear.app/jrf/issue/JRF-801");
    expect(item?.provider).toBe("claude");
    expect(item?.roleJobs).toHaveLength(1);
    expect(item?.roleJobs[0]?.role).toBe("plan-verifier");
    expect(item?.gates.plan?.verdict).toBe("PASS");

    // Agent Roster verification
    expect(item?.roster).toBeDefined();
    expect(item?.roster).toHaveLength(2); // 1 coordinator + 1 roleJob
    expect(item?.rosterSummary.total).toBe(2);

    const coord = item?.roster.find((a) => a.role === "coordinator");
    expect(coord).toBeDefined();
    expect(coord?.provider).toBe("claude");
    expect(coord?.assignedStatus).toBe("running");
    expect(coord?.provenance).toBe("record");
    expect(coord?.currentAction).toContain("Recorded pipeline stage: intake");
    expect(coord?.recordedRoleStage).toBe("Recorded pipeline stage: intake");

    const verifier = item?.roster.find((a) => a.role === "plan-verifier");
    expect(verifier).toBeDefined();
    expect(verifier?.provider).toBe("codex");
    expect(verifier?.assignedStatus).toBe("completed");
    expect(verifier?.verdict).toBe("PASS");
    expect(verifier?.provenance).toBe("terminal-job");
    expect(verifier?.livenessVerified).toBe(false);
    expect(verifier?.currentAction).toContain("Recorded role result: plan-verifier succeeded (PASS)");

    // Automation provenance check (never fabricates timestamps)
    const claudeAuto = snap.automations.find((a) => a.harness === "claude-code");
    expect(claudeAuto).toBeDefined();
    expect(claudeAuto?.configured).toBe(false);
    expect(claudeAuto?.lastRunAt).toBeNull();
    expect(claudeAuto?.lastRunStatus).toContain("Adapter not implemented / unobserved");
    expect(claudeAuto?.schedule).toContain("Unobserved");
    expect(claudeAuto?.provenance).toContain("No adapter implemented");

    const codexAuto = snap.automations.find((a) => a.harness === "codex");
    expect(codexAuto).toBeDefined();
    expect(codexAuto?.configured).toBe(false);
    expect(codexAuto?.lastRunAt).toBeNull();
    expect(codexAuto?.lastRunStatus).toContain("Adapter not implemented / unobserved");

    expect(snap.automations.map((a) => a.harness)).toEqual(["orca", "claude-code", "codex"]);
    expect((snap.automations as Array<{ harness: string }>).some((a) => a.harness === "antigravity")).toBe(
      false,
    );
  });

  test("answer links use the existing Linear issue URL or fall back without an unsafe invented target", async () => {
    const w = await world();
    const issue = todo("link-1", "JRF-803");
    labeledByOwner(w, issue);
    await runTick(w);
    expect((await buildSnapshot(w.dirs, w.cfg, w.clock, null)).activeWorktrees[0]?.linearUrl).toBeNull();
    for (const url of [
      "javascript:alert(1)",
      "https://linear.app.evil.test/issue/JRF-803",
      "https://user@linear.app/issue/JRF-803",
    ]) {
      const stored = w.linear.issues.get(issue.id);
      if (!stored) throw new Error("issue missing");
      stored.url = url;
      expect(
        (await buildSnapshot(w.dirs, w.cfg, w.clock, w.linear)).activeWorktrees[0]?.linearUrl,
      ).toBeNull();
    }
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
    expect(found?.project).toBeDefined();
    expect(found?.priority).toBe(2);
    expect(snap.funnel.todo).toBeGreaterThanOrEqual(1);
  });

  test("evaluates scheduler installation and heartbeat states correctly", async () => {
    const w = await world();

    // 1. No install.json, heartbeat present (manual tick)
    await writeHeartbeat(w.dirs, {
      kind: "tick",
      at: "2026-10-09T08:00:00.000Z",
      exitCode: 1,
      outcome: "idle",
      reason: null,
      durationMs: 1200,
      pausedScopes: [],
      linearAuth: { ok: true, expiresAt: null },
      orcaReachable: true,
      counts: {},
    });

    let snap = await buildSnapshot(w.dirs, w.cfg, w.clock, null);
    let orcaAuto = snap.automations.find((a) => a.harness === "orca");
    expect(orcaAuto?.configured).toBe(false);
    expect(orcaAuto?.lastRunStatus).toContain("origin unknown");
    expect(orcaAuto?.schedule).toBe("Unknown (no local installation record)");
    expect(orcaAuto?.provenance).toContain("No local installation record; scheduler state unknown");
    expect(snap.projects[0]?.automation.enabled).toBe(false);
    expect(snap.projects[0]?.automation.status).toBe("not_installed");
    expect(snap.projects[0]?.automation.cadence).toBe("Not installed");

    // 2. install.json with enabled: false
    const disabledInstall = {
      version: "0.1.0",
      automationId: "auto-1",
      worktreeId: "wt-1",
      binPath: "/bin/wingmate",
      sha256: "0".repeat(64),
      viewUrls: [],
      installedAt: "2026-10-09T00:00:00.000Z",
      enabled: false,
    };
    await writeAtomic(join(w.dirs.state, "install.json"), JSON.stringify(disabledInstall, null, 2));

    snap = await buildSnapshot(w.dirs, w.cfg, w.clock, null);
    orcaAuto = snap.automations.find((a) => a.harness === "orca");
    expect(orcaAuto?.configured).toBe(true);
    expect(orcaAuto?.lastRunStatus).toContain("Disabled");
    expect(orcaAuto?.provenance).toContain("Recorded disabled in install.json (live state unverified)");
    expect(snap.projects[0]?.automation.enabled).toBe(false);
    expect(snap.projects[0]?.automation.status).toBe("disabled");
    expect(snap.projects[0]?.automation.cadence).toBe("Disabled");

    // 2b. install.json with automationId: null
    const missingAutoIdInstall = {
      ...disabledInstall,
      automationId: null,
      enabled: true,
    };
    await writeAtomic(join(w.dirs.state, "install.json"), JSON.stringify(missingAutoIdInstall, null, 2));

    snap = await buildSnapshot(w.dirs, w.cfg, w.clock, null);
    orcaAuto = snap.automations.find((a) => a.harness === "orca");
    expect(orcaAuto?.configured).toBe(false);
    expect(orcaAuto?.lastRunStatus).toContain("Unconfigured (missing automationId in install.json)");
    expect(snap.projects[0]?.automation.status).toBe("disabled");
    expect(snap.projects[0]?.automation.cadence).toBe("Disabled");

    // 3. install.json malformed
    await writeAtomic(join(w.dirs.state, "install.json"), "{ invalid json");

    snap = await buildSnapshot(w.dirs, w.cfg, w.clock, null);
    orcaAuto = snap.automations.find((a) => a.harness === "orca");
    expect(orcaAuto?.configured).toBe(false);
    expect(orcaAuto?.lastRunStatus).toContain("State unknown (malformed install.json)");
    expect(snap.projects[0]?.automation.status).toBe("unknown");
    expect(snap.projects[0]?.automation.cadence).toBe("Unknown");
    expect(snap.problems.some((p) => p.startsWith("install_state_invalid"))).toBe(true);

    // 4. install.json enabled: true, but heartbeat is stale (>15m)
    const enabledInstall = {
      ...disabledInstall,
      enabled: true,
    };
    await writeAtomic(join(w.dirs.state, "install.json"), JSON.stringify(enabledInstall, null, 2));
    const staleTime = new Date(w.clock.now().getTime() - 25 * 60 * 1000).toISOString();
    await writeHeartbeat(w.dirs, {
      kind: "tick",
      at: staleTime,
      exitCode: 1,
      outcome: "idle",
      reason: null,
      durationMs: 1200,
      pausedScopes: [],
      linearAuth: { ok: true, expiresAt: null },
      orcaReachable: true,
      counts: {},
    });

    snap = await buildSnapshot(w.dirs, w.cfg, w.clock, null);
    orcaAuto = snap.automations.find((a) => a.harness === "orca");
    expect(orcaAuto?.configured).toBe(true);
    expect(orcaAuto?.lastRunStatus).toContain("Stale");
    expect(snap.projects[0]?.automation.status).toBe("stale");
    expect(snap.projects[0]?.automation.enabled).toBe(false);

    // 5. install.json enabled: true, awaiting first heartbeat
    const wFresh = await world();
    await writeAtomic(join(wFresh.dirs.state, "install.json"), JSON.stringify(enabledInstall, null, 2));
    const snapFresh = await buildSnapshot(wFresh.dirs, wFresh.cfg, wFresh.clock, null);
    const orcaAutoFresh = snapFresh.automations.find((a) => a.harness === "orca");
    expect(orcaAutoFresh?.configured).toBe(true);
    expect(orcaAutoFresh?.lastRunAt).toBeNull();
    expect(orcaAutoFresh?.lastRunStatus).toContain("Installed (awaiting first heartbeat)");
  });

  test("scopes roleJobs strictly to current cycle and attempt, separating nativeUiJobs into executionTasks", async () => {
    const w = await world();
    labeledByOwner(w, todo("i2", "JRF-804"));
    await runTick(w);

    const record = await readRecord(w.dirs, "JRF-804");
    if (!record) throw new Error("record not found");

    record.cycle = 2;
    record.coordinator.attempt = 2;

    // Prior cycle job (must be excluded from roster)
    record.roleJobs.push({
      id: "01M4CTVA1ZC6W2RW3K2YS2VW01",
      mode: "terminal-job",
      role: "plan-verifier",
      cycle: 1,
      attempt: 1,
      provider: "codex",
      status: "running",
      launchUncertain: false,
      terminalHandle: null,
      paneKey: null,
      headSha: "0".repeat(40),
      planHash: "0".repeat(64),
      createdAt: w.ctx.now(),
      completedAt: null,
      verdict: null,
      reportPath: null,
      reportHash: null,
      notified: false,
    });

    // Prior attempt job in current cycle (must be excluded from roster)
    record.roleJobs.push({
      id: "01M4CTVA1ZC6W2RW3K2YS2VW02",
      mode: "terminal-job",
      role: "security-reviewer",
      cycle: 2,
      attempt: 1,
      provider: "codex",
      status: "running",
      launchUncertain: false,
      terminalHandle: null,
      paneKey: null,
      headSha: "0".repeat(40),
      planHash: "0".repeat(64),
      createdAt: w.ctx.now(),
      completedAt: null,
      verdict: null,
      reportPath: null,
      reportHash: null,
      notified: false,
    });

    // Current cycle and attempt job (must be included)
    record.roleJobs.push({
      id: "01M4CTVA1ZC6W2RW3K2YS2VW03",
      mode: "terminal-job",
      role: "code-reviewer",
      cycle: 2,
      attempt: 2,
      provider: "codex",
      status: "running",
      launchUncertain: false,
      terminalHandle: null,
      paneKey: null,
      headSha: "0".repeat(40),
      planHash: "0".repeat(64),
      createdAt: w.ctx.now(),
      completedAt: null,
      verdict: null,
      reportPath: null,
      reportHash: null,
      notified: false,
    });

    // Native UI simulator recipe (must be separated into executionTasks)
    record.nativeUiJobs.push({
      id: "native1",
      issue: "JRF-804",
      cycle: 2,
      attempt: 2,
      worktreeId: "wt-1",
      headSha: "0".repeat(40),
      policyHash: "0".repeat(64),
      executionIsolationHash: "0".repeat(64),
      runtimeBinding: null,
      runtimeAcquireUncertain: false,
      runtimeReleased: true,
      deviceCleanupComplete: true,
      recipeHash: "0".repeat(64),
      requestedAt: w.ctx.now(),
      status: "succeeded",
      udid: null,
      createUncertain: false,
      cleanupComplete: true,
      receiptHash: "0".repeat(64),
      evidencePath: ".wingmate/evidence/native.json",
      notified: true,
    });

    // Unverifiable native job (must not say executing)
    record.nativeUiJobs.push({
      id: "native2",
      issue: "JRF-804",
      cycle: 2,
      attempt: 2,
      worktreeId: "wt-1",
      headSha: "0".repeat(40),
      policyHash: "0".repeat(64),
      executionIsolationHash: "0".repeat(64),
      runtimeBinding: null,
      runtimeAcquireUncertain: false,
      runtimeReleased: true,
      deviceCleanupComplete: true,
      recipeHash: "0".repeat(64),
      requestedAt: w.ctx.now(),
      status: "unverifiable",
      udid: null,
      createUncertain: false,
      cleanupComplete: false,
      receiptHash: null,
      evidencePath: ".wingmate/evidence/native.json",
      notified: false,
    });

    await writeRecord(w.dirs, record);

    const snap = await buildSnapshot(w.dirs, w.cfg, w.clock, null);
    const item = snap.activeWorktrees[0];
    expect(item).toBeDefined();

    // Roster should only include coordinator + current worker
    expect(item?.roster).toHaveLength(2);
    expect(item?.rosterSummary.total).toBe(2);
    const rosterRoles = item?.roster.map((r) => r.role);
    expect(rosterRoles).toContain("coordinator");
    expect(rosterRoles).toContain("code-reviewer");
    expect(rosterRoles).not.toContain("plan-verifier");
    expect(rosterRoles).not.toContain("security-reviewer");
    expect(rosterRoles).not.toContain("native-ui-tester");

    // Native UI jobs appear in executionTasks
    expect(item?.executionTasks).toHaveLength(2);
    const execTask = item?.executionTasks?.[0];
    expect(execTask?.id).toBe("native1");
    expect(execTask?.status).toBe("completed");
    expect(execTask?.recordedAction).toBe("Recorded native test result: completed (succeeded)");
    expect(execTask?.recordedAction).not.toContain("executing");

    const unverifiableTask = item?.executionTasks?.[1];
    expect(unverifiableTask?.id).toBe("native2");
    expect(unverifiableTask?.status).toBe("unknown");
    expect(unverifiableTask?.recordedAction).toBe(
      "Recorded native test status: unverifiable (recipe unconfirmed)",
    );
    expect(unverifiableTask?.recordedAction).not.toContain("executing");
  });

  test("null verdict on succeeded roleJob reports succeeded (verdict unknown) and never invents PASS", async () => {
    const w = await world();
    labeledByOwner(w, todo("i3", "JRF-805"));
    await runTick(w);

    const record = await readRecord(w.dirs, "JRF-805");
    if (!record) throw new Error("record not found");

    record.roleJobs.push({
      id: "01M4CTVA1ZC6W2RW3K2YS2VW04",
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
      verdict: null,
      reportPath: null,
      reportHash: null,
      notified: true,
    });

    await writeRecord(w.dirs, record);

    const snap = await buildSnapshot(w.dirs, w.cfg, w.clock, null);
    const item = snap.activeWorktrees[0];
    const reviewer = item?.roster.find((r) => r.role === "plan-verifier");
    expect(reviewer).toBeDefined();
    expect(reviewer?.statusDetail).toBe("succeeded (verdict unknown)");
    expect(reviewer?.recordedRoleStage).toBe(
      "Recorded role result: plan-verifier succeeded (verdict unknown)",
    );
    expect(reviewer?.currentAction).toBe("Recorded role result: plan-verifier succeeded (verdict unknown)");
    expect(reviewer?.currentAction).not.toContain("PASS");
  });
});
