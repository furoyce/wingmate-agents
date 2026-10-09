import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { renderDashboardHtml } from "../../../src/server/html";
import { HEARTBEAT_STALE_MIN, buildSnapshot, dispatcherHealth } from "../../../src/server/snapshot";
import type { SnapshotResponse } from "../../../src/server/types";
import { writeAtomic } from "../../../src/state/fs";
import { type Heartbeat, HeartbeatSchema } from "../../../src/state/heartbeat";
import { writeQueue } from "../../../src/state/queue";
import { archiveRecord, readRecord, writeRecord } from "../../../src/state/records";
import { labeledByOwner, runTick, todo, world } from "../../sim/harness";

const NOW = "2026-10-06T10:00:00.000Z";
const enabledInstall = {
  version: "0.1.0",
  automationId: "auto_1",
  worktreeId: "wt_1",
  binPath: "/fake/wingmate",
  sha256: "0".repeat(64),
  viewUrls: [],
  installedAt: NOW,
  enabled: true,
};
const tick = (over: Partial<Heartbeat> = {}): Heartbeat =>
  HeartbeatSchema.parse({
    kind: "tick",
    at: NOW,
    exitCode: 1,
    outcome: "idle",
    reason: null,
    durationMs: 120,
    pausedScopes: [],
    linearAuth: { ok: true, expiresAt: null },
    orcaReachable: true,
    counts: {},
    ...over,
  });

/** Pulls named top-level functions out of the dashboard script so render logic is tested as shipped. */
function dashboardFunctions<T>(names: string[], context: Record<string, unknown> = {}): T {
  const script = renderDashboardHtml("tok").match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  const sources = names.map((name) => {
    const src = script.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n    \\}`))?.[0];
    if (!src) throw new Error(`${name} missing`);
    return src;
  });
  return runInNewContext(`${sources.join("\n")}\n({ ${names.join(", ")} });`, context) as T;
}

describe("dispatcher health is observed, not inferred from any heartbeat", () => {
  test("fresh idle/work is healthy; fresh failures are degraded; old ticks are stale", () => {
    expect(dispatcherHealth(tick(), false, NOW).state).toBe("healthy");
    expect(dispatcherHealth(tick({ outcome: "work" }), false, NOW).state).toBe("healthy");
    for (const outcome of [
      "error",
      "lock_lost",
      "lock_held",
      "orca_unreachable",
      "linear_error",
      "stopped",
    ] as const)
      expect(dispatcherHealth(tick({ outcome, exitCode: 2 }), false, NOW).state).toBe("degraded");
    // The precheck exits 1 after a healthy idle/work tick (never 0), so the exit code alone is not a failure.
    expect(dispatcherHealth(tick({ outcome: "work", exitCode: 1 }), false, NOW).state).toBe("healthy");
    expect(dispatcherHealth(tick({ outcome: "paused" }), false, NOW).state).toBe("paused");
    const old = new Date(Date.parse(NOW) - (HEARTBEAT_STALE_MIN + 1) * 60_000).toISOString();
    const stale = dispatcherHealth(tick({ at: old }), false, NOW);
    expect(stale.state).toBe("stale");
    expect(stale.ageMin).toBe(HEARTBEAT_STALE_MIN + 1);
    expect(dispatcherHealth(null, false, NOW).state).toBe("unknown");
    expect(dispatcherHealth(tick(), true, NOW).state).toBe("unknown");
  });

  test("snapshot reports a fresh failing tick as degraded, not active", async () => {
    const w = await world();
    await writeAtomic(
      join(w.dirs.state, "install.json"),
      JSON.stringify({
        version: "0.1.0",
        automationId: "auto_1",
        worktreeId: "wt_1",
        binPath: "/fake/wingmate",
        sha256: "0".repeat(64),
        viewUrls: [],
        installedAt: NOW,
        enabled: true,
      }),
    );
    await writeAtomic(
      join(w.dirs.state, "last-tick.json"),
      JSON.stringify(tick({ outcome: "error", exitCode: 2 })),
    );
    const snap = await buildSnapshot(w.dirs, w.cfg, w.clock, null);
    expect(snap.dispatcherHealth.state).toBe("degraded");
    expect(snap.problems.some((p) => p.startsWith("install_state_invalid"))).toBe(false);
    expect(snap.projects.every((p) => p.automation.status === "degraded")).toBe(true);
    expect(snap.automations[0]?.lastRunStatus).toContain("error");
  });

  test("dispatcher and scheduler agree at exactly 15 minutes and at 15m01s", async () => {
    const w = await world();
    await writeAtomic(join(w.dirs.state, "install.json"), JSON.stringify(enabledInstall));
    await writeAtomic(join(w.dirs.state, "last-tick.json"), JSON.stringify(tick()));
    w.clock.advance(15 * 60_000);
    let snap = await buildSnapshot(w.dirs, w.cfg, w.clock, null);
    expect(snap.dispatcherHealth.state).toBe("healthy");
    expect(snap.projects.every((p) => p.automation.status === "active")).toBe(true);
    w.clock.advance(1000);
    snap = await buildSnapshot(w.dirs, w.cfg, w.clock, null);
    expect(snap.dispatcherHealth.state).toBe("stale");
    expect(snap.dispatcherHealth.ageMin).toBe(15);
    expect(snap.projects.every((p) => p.automation.status === "stale")).toBe(true);
  });
});

describe("pause scope semantics match the core", () => {
  test("global pause is 'global' and applies to every project", async () => {
    const w = await world();
    await writeAtomic(join(w.dirs.state, "pause.json"), JSON.stringify(["global"]));
    const snap = await buildSnapshot(w.dirs, w.cfg, w.clock, null);
    expect(snap.globalPaused).toBe(true);
    expect(snap.pausedProjects).toEqual([]);
    for (const p of snap.projects) {
      expect(p.paused).toBe("global");
      expect(p.automation.enabled).toBe(false);
    }
  });

  test("a project pause is not global, and the legacy 'all' token is not a pause", async () => {
    const w = await world();
    await writeAtomic(join(w.dirs.state, "pause.json"), JSON.stringify(["all", "bouncr"]));
    const snap = await buildSnapshot(w.dirs, w.cfg, w.clock, null);
    expect(snap.globalPaused).toBe(false);
    expect(snap.projects.find((p) => p.key === "bouncr")?.paused).toBe("project");
    expect(snap.projects.filter((p) => p.key !== "bouncr").every((p) => p.paused === null)).toBe(true);
  });

  test("unreadable pause state is unknown, never 'not paused'", async () => {
    const w = await world();
    await writeAtomic(join(w.dirs.state, "install.json"), JSON.stringify(enabledInstall));
    await writeAtomic(join(w.dirs.state, "last-tick.json"), JSON.stringify(tick()));
    await writeAtomic(join(w.dirs.state, "pause.json"), "{not json");
    const snap = await buildSnapshot(w.dirs, w.cfg, w.clock, null);
    expect(snap.pauseStateKnown).toBe(false);
    expect(snap.problems).toContain("pause_invalid");
    expect(snap.projects.every((p) => p.automation.status === "unknown")).toBe(true);
    expect(snap.projects.every((p) => p.automation.enabled === false)).toBe(true);
  });
});

describe("queue eligibility and completion evidence are reported truthfully", () => {
  test("only eligible queue rows count as ready; skipped rows keep their reason", async () => {
    const w = await world();
    await writeQueue(w.dirs, {
      at: NOW,
      items: [
        {
          identifier: "JRF-1",
          project: "bouncr",
          status: "eligible",
          reason: null,
          detail: null,
          nextEvalAt: null,
        },
        {
          identifier: "JRF-2",
          project: "bouncr",
          status: "skipped",
          reason: "paused",
          detail: "global",
          nextEvalAt: null,
        },
        {
          identifier: "JRF-3",
          project: "bouncr",
          status: "skipped",
          reason: "human",
          detail: null,
          nextEvalAt: null,
        },
      ],
    });
    const snap = await buildSnapshot(w.dirs, w.cfg, w.clock, null);
    expect(snap.funnel.agentReady).toBe(1);
    expect(snap.funnel.agentReadyBasis).toBe("queue-eligible");
    const bouncr = snap.projects.find((p) => p.key === "bouncr");
    expect(bouncr?.queuedCount).toBe(1);
    expect(bouncr?.skippedCount).toBe(2);
    expect(snap.queue.find((q) => q.identifier === "JRF-2")).toMatchObject({
      status: "skipped",
      reason: "paused",
    });
  });

  test("an all-skipped queue is zero ready, not a fallback to Linear labels", async () => {
    const w = await world();
    w.linear.add(todo("i_lab", "JRF-9"));
    await writeQueue(w.dirs, {
      at: NOW,
      items: [
        {
          identifier: "JRF-9",
          project: "bouncr",
          status: "skipped",
          reason: "paused",
          detail: null,
          nextEvalAt: null,
        },
      ],
    });
    const snap = await buildSnapshot(w.dirs, w.cfg, w.clock, w.linear);
    expect(snap.funnel.agentReady).toBe(0);
  });

  test("without a queue the count is labeled as Linear labels with unknown eligibility", async () => {
    const w = await world();
    w.linear.add(todo("i_lab", "JRF-9"));
    const snap = await buildSnapshot(w.dirs, w.cfg, w.clock, w.linear);
    expect(snap.funnel.agentReadyBasis).toBe("linear-labels");
    expect(snap.funnel.agentReady).toBe(1);
  });

  test("ownership releases are separate from completion totals in the funnel, history and projects", async () => {
    const w = await world();
    labeledByOwner(w, todo("i_rel", "JRF-880"));
    await runTick(w);
    const rec = await readRecord(w.dirs, "JRF-880");
    if (!rec) throw new Error("record missing");
    await writeRecord(w.dirs, { ...rec, stage: "released", updatedAt: w.ctx.now() });
    await archiveRecord(w.dirs, "JRF-880");
    const snap = await buildSnapshot(w.dirs, w.cfg, w.clock, null);
    expect(snap.funnel.completion).toEqual({
      recordedDone: 0,
      released: 1,
      sourceCompleted: 0,
      mergeVerified: null,
    });
    expect(snap.funnel.done).toBe(0);
    expect(snap.metrics.completedCount).toBe(0);
    expect(snap.projects.find((p) => p.key === "bouncr")).toMatchObject({
      completedCount: 0,
      releasedCount: 1,
    });

    // A separate recorded done issue still counts; releasing ownership of the first issue does not.
    await writeRecord(w.dirs, {
      ...rec,
      linearId: "i_done",
      identifier: "JRF-881",
      stage: "done",
      updatedAt: w.ctx.now(),
    });
    await archiveRecord(w.dirs, "JRF-881");
    const withDone = await buildSnapshot(w.dirs, w.cfg, w.clock, null);
    expect(withDone.funnel.done).toBe(1);
    expect(withDone.metrics.completedCount).toBe(1);
    expect(withDone.projects.find((p) => p.key === "bouncr")).toMatchObject({
      completedCount: 1,
      releasedCount: 1,
    });
  });

  test("observed completions union disjoint sources and deduplicate overlapping IDs and archive cycles", async () => {
    const w = await world();
    labeledByOwner(w, todo("i_a", "JRF-883"));
    await runTick(w);
    const rec = await readRecord(w.dirs, "JRF-883");
    if (!rec) throw new Error("record missing");
    await writeRecord(w.dirs, { ...rec, stage: "done", updatedAt: NOW });
    await archiveRecord(w.dirs, rec.identifier);
    const completed = { state: { id: "st-done", name: "Done", type: "completed" }, updatedAt: NOW };
    w.linear.add(todo("i_b", "JRF-884", completed));
    let snap = await buildSnapshot(w.dirs, w.cfg, w.clock, w.linear);
    expect(snap.funnel.done).toBe(2);
    expect(snap.metrics.completedCount).toBe(2);
    expect(snap.funnel.completion).toMatchObject({ recordedDone: 1, sourceCompleted: 1 });

    w.linear.issues.delete("i_b");
    const source = todo("i_a", "JRF-883", completed);
    w.linear.add(source);
    snap = await buildSnapshot(w.dirs, w.cfg, w.clock, w.linear);
    expect(snap.funnel.done).toBe(1);
    expect(snap.metrics.completedCount).toBe(1);
    expect(snap.funnel.completion).toMatchObject({ recordedDone: 1, sourceCompleted: 1 });

    await writeRecord(w.dirs, { ...rec, cycle: rec.cycle + 1, stage: "done", updatedAt: NOW });
    await archiveRecord(w.dirs, rec.identifier);
    // Repeated release cycles also remain one separately reported ownership release.
    for (const cycle of [rec.cycle + 2, rec.cycle + 3]) {
      await writeRecord(w.dirs, { ...rec, cycle, stage: "released", updatedAt: NOW });
      await archiveRecord(w.dirs, rec.identifier);
    }
    w.linear.listUpdatedSince = async () => [source, source];
    snap = await buildSnapshot(w.dirs, w.cfg, w.clock, w.linear);
    expect(snap.funnel.done).toBe(1);
    expect(snap.metrics.completedCount).toBe(1);
    expect(snap.funnel.completion).toMatchObject({ recordedDone: 1, sourceCompleted: 1, released: 1 });
    expect(snap.projects.find((p) => p.key === "bouncr")).toMatchObject({
      completedCount: 1,
      releasedCount: 1,
    });
  });
});

describe("gate metrics use observed verdicts", () => {
  test("no observations are unknown; PASS/FAIL alone form the denominator", async () => {
    const w = await world();
    let snap = await buildSnapshot(w.dirs, w.cfg, w.clock, null);
    expect(snap.metrics).toMatchObject({ gatePassRate: null, gatesPassed: 0, gatesObserved: 0 });
    labeledByOwner(w, todo("i_gates", "JRF-882"));
    await runTick(w);
    const rec = await readRecord(w.dirs, "JRF-882");
    if (!rec) throw new Error("record missing");
    for (const gate of Object.values(rec.gates)) gate.verdict = null;
    await writeRecord(w.dirs, rec);
    snap = await buildSnapshot(w.dirs, w.cfg, w.clock, null);
    expect(snap.metrics.gatePassRate).toBeNull();
    const verdict = (value: "PASS" | "FAIL" | "NA" | "STALE") => ({
      ...rec.gates.plan,
      verdict: value,
      at: NOW,
    });
    await writeRecord(w.dirs, {
      ...rec,
      gates: {
        ...rec.gates,
        plan: verdict("PASS"),
        validate: verdict("FAIL"),
        ui: verdict("NA"),
        pr: verdict("STALE"),
      },
    });
    snap = await buildSnapshot(w.dirs, w.cfg, w.clock, null);
    expect(snap.metrics).toMatchObject({ gatePassRate: 50, gatesPassed: 1, gatesObserved: 2 });
  });
});

describe("dashboard rendering", () => {
  test("never labels completions as merged or shipped", () => {
    const html = renderDashboardHtml("tok");
    for (const claim of ["Merged", "Shipped", "PR Shipped"]) expect(html).not.toContain(claim);
    const { completionText } = dashboardFunctions<{ completionText: (c: unknown) => string }>([
      "completionText",
    ]);
    expect(completionText({ recordedDone: 2, released: 1, sourceCompleted: 4, mergeVerified: null })).toBe(
      "Done 2 · ownership released 1 · Linear completed 4 · merge unverified",
    );
  });

  test("review cards and metrics never invent gate success, including empty and failing evidence", async () => {
    const w = await world();
    const snap = await buildSnapshot(w.dirs, w.cfg, w.clock, null);
    const nodes: Record<string, { innerHTML: string; textContent: string }> = {};
    const { renderMetrics, renderKanban, renderProjects } = dashboardFunctions<{
      renderMetrics: (m: SnapshotResponse["metrics"]) => void;
      renderKanban: (d: unknown) => void;
      renderProjects: (p: SnapshotResponse["projects"], a: []) => void;
    }>(
      [
        "escapeHtml",
        "completionText",
        "gateRateText",
        "gateEvidenceText",
        "renderMetrics",
        "renderKanban",
        "renderProjects",
      ],
      {
        document: {
          getElementById: (id: string) => {
            nodes[id] ??= { innerHTML: "", textContent: "" };
            return nodes[id];
          },
        },
      },
    );
    for (const gates of [{}, { plan: { verdict: "FAIL" } }, { plan: { verdict: "STALE" } }]) {
      renderKanban({ ...snap, activeWorktrees: [{ identifier: "JRF-882", stage: "review", gates }] });
      expect(nodes.kanbanBoard?.innerHTML).toContain("In review");
      expect(nodes.kanbanBoard?.innerHTML).not.toContain("Gates Passed");
      expect(nodes.kanbanBoard?.innerHTML).toContain("No observed gates");
    }
    renderMetrics(snap.metrics);
    expect(nodes.statsGrid?.innerHTML).toContain("No observed gates");
    expect(nodes.statsGrid?.innerHTML).toContain("0 / 0 observed PASS/FAIL verdicts passed");
    expect(nodes.statsGrid?.innerHTML).not.toContain("100%");
    renderMetrics({ ...snap.metrics, gatePassRate: 50, gatesPassed: 1, gatesObserved: 2 });
    expect(nodes.statsGrid?.innerHTML).toContain("50%");
    expect(nodes.statsGrid?.innerHTML).toContain("1 / 2 observed PASS/FAIL verdicts passed");
    expect(renderDashboardHtml("tok")).not.toContain("8-Gate compliance");
    renderProjects(
      snap.projects.map((p) => ({ ...p, completedCount: 0, releasedCount: 1 })),
      [],
    );
    expect(nodes.projectsGrid?.innerHTML).toContain("Ownership released:</span><strong>1</strong>");
  });

  test("embeds only a sanitized CSRF token and calls the API with it", () => {
    const html = renderDashboardHtml('a"><script>x</script>');
    expect(html).toContain('<meta name="wingmate-csrf" content="ascriptxscript">');
    expect(html).toContain('"X-Wingmate-CSRF": CSRF_TOKEN');
    expect(html).not.toContain("Access-Control");
    expect(html).not.toMatch(/[?&](token|csrf|session)=/);
  });

  test("header separates global pause, project pause and degraded health", () => {
    const el = () => ({ style: { background: "" }, textContent: "", className: "", disabled: false });
    const nodes = { pulseDot: el(), statusSummary: el(), pauseBtn: el() };
    const { renderHeader } = dashboardFunctions<{ renderHeader: (d: unknown) => void }>(["renderHeader"], {
      document: { getElementById: (id: keyof typeof nodes) => nodes[id] },
    });
    const healthy = { state: "healthy", detail: "Last tick 1m ago: idle" };

    renderHeader({
      dispatcherHealth: healthy,
      globalPaused: false,
      pausedProjects: ["bouncr"],
      pauseStateKnown: true,
    });
    expect(nodes.statusSummary.textContent).toContain("Projects paused: bouncr");
    expect(nodes.statusSummary.textContent).not.toContain("Global pause");
    expect(nodes.pauseBtn.textContent).toBe("Pause Global Dispatch");

    renderHeader({
      dispatcherHealth: healthy,
      globalPaused: true,
      pausedProjects: ["bouncr"],
      pauseStateKnown: true,
    });
    expect(nodes.statusSummary.textContent).toContain("Global pause on; projects paused: bouncr");
    expect(nodes.pauseBtn.textContent).toBe("Resume Global Dispatch");

    renderHeader({
      dispatcherHealth: { state: "degraded", detail: "Last tick 2m ago: error (exit 1)" },
      globalPaused: false,
      pausedProjects: [],
      pauseStateKnown: true,
    });
    expect(nodes.pulseDot.style.background).toBe("var(--danger)");
    expect(nodes.statusSummary.textContent).toContain("Dispatcher degraded");

    renderHeader({
      dispatcherHealth: healthy,
      globalPaused: false,
      pausedProjects: [],
      pauseStateKnown: false,
    });
    expect(nodes.statusSummary.textContent).toContain("Pause state unknown");
    expect(nodes.pauseBtn.disabled).toBe(true);
  });
});
