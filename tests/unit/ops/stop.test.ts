// tests/unit/ops/stop.test.ts — §13.3(i) the kill switch: lock-free, the stop file first, agents stopped and swept, each record
// blocked owner_stop with one comment, the flag cleared, the scoped forms.
import { describe, expect, test } from "bun:test";
import { tick } from "../../../src/machine/tick";
import { stop, stopReason } from "../../../src/ops/stop";
import { WingmateError } from "../../../src/shared/errors";
import { requestStop, stopRequested } from "../../../src/state/heartbeat";
import { TickLock } from "../../../src/state/lock";
import { readRecord, writeRecord } from "../../../src/state/records";
import { labeledByOwner, runTick, todo, world } from "../../sim/harness";

describe("wingmate stop (§13.3 i)", () => {
  test("--all stops workers, closes terminals, sweeps, blocks each record with one comment, clears the flag; the next tick launches nothing", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-701"));
    await runTick(w);
    const r = await readRecord(w.dirs, "JRF-701");
    if (!r?.worktree) throw new Error("JRF-701 was not claimed");
    r.coordinator.childRunId = "run_x";
    await writeRecord(w.dirs, r);
    w.orca.workers.set("run_x", [
      {
        dispatchId: "ctx_9",
        taskId: "t",
        runId: "run_x",
        workerState: "running",
        dispatchStatus: "active",
        agentTerminalHandle: "term_w",
        verdict: "live",
      },
    ]);
    const report = await stop(w.ctx, { kind: "all" }, "drill");
    expect(report.stopped).toEqual(["JRF-701"]);
    expect(w.orca.calls.some((c) => c.verb === "workerStop")).toBe(true);
    expect(w.orca.closed).toContain(r.worktree.id);
    expect(w.swept).toContain(r.worktree.path);
    const after = await readRecord(w.dirs, "JRF-701");
    expect(after?.stage).toBe("blocked");
    expect(after?.history[after.history.length - 1]?.cause).toBe("owner_stop");
    expect(w.linear.comments.filter((c) => c.body.startsWith("<!-- wingmate:blocked -->")).length).toBe(1);
    expect(w.linear.issues.get("i1")?.labels.map((l) => l.name)).toContain("Blocked");
    expect(await stopRequested(w.dirs)).toBe(false);
    const n = w.orca.calls.filter((c) => c.verb === "terminalCreate").length;
    w.clock.advance(300_000);
    await runTick(w);
    expect(w.orca.calls.filter((c) => c.verb === "terminalCreate").length).toBe(n);
  });
  test("--issue scopes to one record; --project to a project", async () => {
    const w = await world();
    const smart = w.cfg.projects["smart-dispatcher"]?.repos.main;
    if (!smart) throw new Error("smart-dispatcher repo missing");
    smart.setup = "none"; // its `pnpm install` cannot run in a temp worktree (the claim would block setup_failed)
    labeledByOwner(w, todo("i1", "JRF-702"));
    labeledByOwner(w, todo("i2", "JRF-703", { projectId: "a0d17ec1-b237-4481-9efb-1eff9fe69efe" }));
    await runTick(w);
    expect((await stop(w.ctx, { kind: "issue", key: "JRF-703" }, "x")).stopped).toEqual(["JRF-703"]);
    expect((await readRecord(w.dirs, "JRF-702"))?.stage).toBe("working");
    expect((await stop(w.ctx, { kind: "project", key: "bouncr" }, "x")).stopped).toEqual(["JRF-702"]);
  });
});

const SMART = "a0d17ec1-b237-4481-9efb-1eff9fe69efe";
const liveWorker = (runId: string, dispatchId: string) => ({
  dispatchId,
  taskId: "t",
  runId,
  workerState: "running",
  dispatchStatus: "active",
  agentTerminalHandle: "term_w",
  verdict: "live" as const,
});
const fleetRow = (id: string, path: string, displayName: string, state: "working" | "done") => ({
  worktreeId: id,
  repoId: "r",
  path,
  branch: displayName,
  displayName,
  linkedLinearIssue: null,
  status: state === "working" ? "working" : "active",
  liveTerminalCount: 1,
  lastOutputAt: null,
  childWorktreeIds: [] as string[],
  agents: [{ paneKey: `${id}:leaf`, state, agentType: "claude", stateStartedAt: null, updatedAt: null }],
});

async function working(identifier: string, id = "i1") {
  const w = await world();
  labeledByOwner(w, todo(id, identifier));
  await runTick(w);
  const r = await readRecord(w.dirs, identifier);
  if (!r?.worktree || r.stage !== "working") throw new Error(`${identifier} is not working`);
  return { w, r, wt: r.worktree };
}

describe("wingmate stop — Task 12 coverage", () => {
  test("the stop file is written before any external action, and stop never waits on tick.lock (held by a live tick)", async () => {
    const { w } = await working("JRF-711");
    const lock = await TickLock.acquire(w.dirs, w.clock, { heartbeatMs: 60_000 });
    expect(lock.kind).toBe("acquired");
    const flagAtFirstCall: boolean[] = [];
    w.orca.onCall = async () => {
      if (flagAtFirstCall.length === 0) flagAtFirstCall.push(await stopRequested(w.dirs));
    };
    const started = Date.now();
    const report = await stop(w.ctx, { kind: "all" }, "drill");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(flagAtFirstCall).toEqual([true]);
    expect(report.stopped).toEqual(["JRF-711"]);
    expect(report.flagCleared).toBe(true);
    if (lock.kind !== "held") await lock.release();
  });

  test("a worker whose stop is not proven exited is abandoned and reported unverifiable; the record is still blocked", async () => {
    const { w, r } = await working("JRF-712");
    r.coordinator.childRunId = "run_y";
    await writeRecord(w.dirs, r);
    w.orca.workers.set("run_y", [liveWorker("run_y", "ctx_live")]);
    w.orca.workerStop = async (d: string, retry: string) => {
      w.orca.calls.push({ verb: "workerStop", args: { d, retry } });
      return { verdict: "unverifiable" };
    };
    const report = await stop(w.ctx, { kind: "issue", key: "JRF-712" }, "drill");
    expect(w.orca.calls.filter((c) => c.verb === "workerAbandon").map((c) => c.args)).toContain("ctx_live");
    expect(report.unverifiable).toContain("ctx_live");
    expect(report.stopped).toEqual(["JRF-712"]);
    const after = await readRecord(w.dirs, "JRF-712");
    expect(after?.stage).toBe("blocked");
    expect(after?.attention.some((a) => a.startsWith("release_unverifiable"))).toBe(true);
  });

  test("--all also closes and sweeps a working agent on an unrecorded wm- worktree and the record's child worktrees; idle or non-wm worktrees are left alone", async () => {
    const { w, wt } = await working("JRF-713");
    const row = w.orca.rows.get(wt.id);
    if (!row) throw new Error("no fleet row");
    row.childWorktreeIds = ["r::/wt/wm-jrf-713-child"];
    w.orca.rows.set(
      "r::/wt/wm-jrf-713-child",
      fleetRow("r::/wt/wm-jrf-713-child", "/wt/wm-jrf-713-child", "wm-jrf-713-child", "done"),
    );
    w.orca.rows.set("r::/wt/wm-stray", fleetRow("r::/wt/wm-stray", "/wt/wm-stray", "wm-stray", "working"));
    w.orca.rows.set("r::/wt/wm-idle", fleetRow("r::/wt/wm-idle", "/wt/wm-idle", "wm-idle", "done"));
    w.orca.rows.set("r::/wt/feature", fleetRow("r::/wt/feature", "/wt/feature", "feature", "working"));
    const report = await stop(w.ctx, { kind: "all" }, "drill");
    expect(w.orca.closed).toEqual(
      expect.arrayContaining([wt.id, "r::/wt/wm-jrf-713-child", "r::/wt/wm-stray"]),
    );
    expect(w.orca.closed).not.toContain("r::/wt/wm-idle");
    expect(w.orca.closed).not.toContain("r::/wt/feature");
    expect(w.swept).toEqual(expect.arrayContaining([wt.path, "/wt/wm-jrf-713-child", "/wt/wm-stray"]));
    expect(w.swept).not.toContain("/wt/feature");
    expect(report.sweptWorktrees).toEqual(expect.arrayContaining(["/wt/wm-stray", "/wt/wm-jrf-713-child"]));
  });

  test("a scoped stop leaves the flag of a concurrent stop in place, and never touches another project's worktree", async () => {
    const w = await world();
    const smart = w.cfg.projects["smart-dispatcher"]?.repos.main;
    if (!smart) throw new Error("smart-dispatcher repo missing");
    smart.setup = "none";
    labeledByOwner(w, todo("i1", "JRF-714"));
    labeledByOwner(w, todo("i2", "JRF-715", { projectId: SMART }));
    await runTick(w);
    const other = await readRecord(w.dirs, "JRF-714");
    await requestStop(w.dirs, {
      scope: "all",
      at: "2026-10-06T09:59:00.000Z",
      reason: "another stop still running",
    });
    const report = await stop(w.ctx, { kind: "project", key: "smart-dispatcher" }, "x");
    expect(report.stopped).toEqual(["JRF-715"]);
    expect(await stopRequested(w.dirs)).toBe(true); // the other stop's `all` entry survives
    expect(w.orca.closed).not.toContain(other?.worktree?.id);
    expect((await readRecord(w.dirs, "JRF-714"))?.stage).toBe("working");
  });

  test("Linear unreachable: the record is blocked on disk at once (deferred); the next tick posts the Blocked label and the one comment", async () => {
    const { w } = await working("JRF-716");
    const getIssues = w.linear.getIssues.bind(w.linear);
    w.linear.getIssues = async () => {
      throw new WingmateError("linear_unreachable", "fake outage");
    };
    const report = await stop(w.ctx, { kind: "all" }, "outage drill");
    w.linear.getIssues = getIssues;
    expect(report).toMatchObject({ stopped: ["JRF-716"], deferred: ["JRF-716"], flagCleared: true });
    expect((await readRecord(w.dirs, "JRF-716"))?.stage).toBe("blocked");
    const blockedComments = () =>
      w.linear.comments.filter((c) => c.body.startsWith("<!-- wingmate:blocked -->")).length;
    expect(blockedComments()).toBe(0);
    w.clock.advance(300_000);
    await runTick(w);
    expect(blockedComments()).toBe(1);
    expect(w.linear.issues.get("i1")?.labels.map((l) => l.name)).toContain("Blocked");
    w.clock.advance(300_000);
    await runTick(w);
    expect(blockedComments()).toBe(1);
  });

  test("a record that could not be blocked keeps this stop's flag set, so no tick resumes it", async () => {
    const { w, r } = await working("JRF-717");
    r.coordinator.childRunId = "run_broken";
    await writeRecord(w.dirs, r);
    w.orca.workerList = async () => {
      throw new Error("worker-list crashed"); // not an OrcaError: stopAgents lets it through
    };
    const report = await stop(w.ctx, { kind: "all" }, "drill");
    expect(report.stopped).toEqual([]);
    expect(report.failed).toEqual(["JRF-717:internal_error"]);
    expect(report.flagCleared).toBe(false);
    expect(await stopRequested(w.dirs)).toBe(true);
    const s = await tick(w.ctx, { dryRun: false, precheck: true });
    expect(s.outcome).toBe("stopped");
  });

  test("an awaiting-human and a review record are blocked owner_stop too; terminal records are left alone", async () => {
    const w = await world();
    for (const [id, identifier] of [
      ["i1", "JRF-721"],
      ["i2", "JRF-722"],
      ["i3", "JRF-723"],
    ] as const)
      labeledByOwner(w, todo(id, identifier));
    for (const p of Object.values(w.cfg.projects))
      Object.assign(p.concurrency.maxWorking, { perProject: 3, perProvider: 3 });
    w.cfg.defaults.dispatcher.claimsPerTick = 3;
    await runTick(w);
    const set = async (identifier: string, stage: "awaiting-human" | "review" | "released") => {
      const r = await readRecord(w.dirs, identifier);
      if (!r) throw new Error(`no ${identifier}`);
      r.stage = stage;
      await writeRecord(w.dirs, r);
    };
    await set("JRF-721", "awaiting-human");
    await set("JRF-722", "review");
    await set("JRF-723", "released");
    const report = await stop(w.ctx, { kind: "all" }, "drill");
    expect(report.stopped.sort()).toEqual(["JRF-721", "JRF-722"]);
    for (const id of ["JRF-721", "JRF-722"]) {
      const r = await readRecord(w.dirs, id);
      expect(r?.stage).toBe("blocked");
      expect(r?.history.at(-1)).toMatchObject({ to: "blocked", cause: "owner_stop" });
    }
    expect((await readRecord(w.dirs, "JRF-723"))?.stage).toBe("released");
  });

  test("the owner's reason reaches the blocked comment as one bounded line, and a secret-looking reason never does", async () => {
    const { w } = await working("JRF-718");
    await stop(w.ctx, { kind: "issue", key: "JRF-718" }, "line one\nline two\u0007");
    const body = w.linear.comments.find((c) => c.body.startsWith("<!-- wingmate:blocked -->"))?.body ?? "";
    expect(body).toContain("`owner_stop`");
    expect(body).toContain("wingmate stop --issue JRF-718");
    expect(body).toContain("line one line two");
    expect(stopReason(`token ghp_${"a".repeat(36)}`)).toBe("(reason withheld: it looked like a secret)");
    expect(stopReason("x".repeat(500)).length).toBe(200);
    expect(stopReason(undefined)).toBe("no reason given");
  });
});
