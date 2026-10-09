import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanup } from "../../../src/machine/cleanup";
import type { Reconciled } from "../../../src/machine/reconcile";
import { type TickSummary, tick } from "../../../src/machine/tick";
import { NativeJobSchema } from "../../../src/native/protocol";
import { type CleanupOptions, cleanupOps } from "../../../src/ops/cleanup";
import { parseCleanupTerminals } from "../../../src/orca/fleet";
import { requestStop } from "../../../src/state/heartbeat";
import { TickLock } from "../../../src/state/lock";
import { readRecord, recordText, writeRecord } from "../../../src/state/records";
import { type CleanupWorld, cleanupWorld } from "../../fakes/cleanupWorld";

function present<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("fixture value missing");
  return value;
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function world() {
  const w = await cleanupWorld();
  roots.push(w.root);
  return w;
}
const options: CleanupOptions = { scope: { kind: "issue", key: "JRF-501" } };
const run = (w: CleanupWorld, opts: Partial<CleanupOptions> = {}) =>
  cleanupOps(w.ctx, { ...options, ...opts });
const result = async (w: CleanupWorld, opts: Partial<CleanupOptions> = {}) => (await run(w, opts)).cleaned[0];
async function snapshot(path: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === "wingmate.log") continue;
    const file = join(path, entry.name);
    if (entry.isDirectory()) Object.assign(files, await snapshot(file));
    else if (entry.isFile()) files[file] = (await readFile(file)).toString("base64");
  }
  return files;
}
async function retained(w: CleanupWorld, reason: string, force = true) {
  const before = await snapshot(w.root);
  const preview = await result(w, { force, dryRun: true });
  expect(preview?.reason).toBe(reason);
  expect(await snapshot(w.root)).toEqual(before);
  const live = await result(w, { force });
  expect(live).toEqual(preview);
  expect((await readRecord(w.dirs, w.r.identifier))?.worktree).not.toBeNull();
  expect(w.orca.removed).toEqual([]);
  expect(w.orca.closed).toEqual([]);
  expect(w.swept).toEqual([]);
}

describe("safe shared cleanup", () => {
  test("positive owned, inactive, clean, merged worktree: preview parity and durable historical identity", async () => {
    const w = await world();
    const before = await snapshot(w.root);
    expect(await result(w, { dryRun: true })).toMatchObject({
      outcome: "eligible",
      reason: "eligible_for_removal",
    });
    expect(await snapshot(w.root)).toEqual(before);
    expect(await result(w)).toMatchObject({ outcome: "removed" });
    expect((await readRecord(w.dirs, w.r.identifier))?.worktree).toBeNull();
    expect(w.orca.removed).toEqual([w.wt.id]);
    expect(
      (await w.ctx.ledger.readIssue(w.r.identifier)).find((e) => e.type === "cleanup")?.data.worktreeIdentity,
    ).toEqual(w.r.worktree);
    expect(await result(w)).toMatchObject({ outcome: "retained", reason: "no_worktree" });
    expect(w.orca.removed).toHaveLength(1);
  });
  test("CL-1 failed inventory cannot erase a recorded workspace, even with force", async () => {
    const w = await world();
    w.orca.worktreePs = async () => {
      throw new Error("offline");
    };
    await retained(w, "inventory_failed");
  });
  test.each(["truncated", "omitted-host"])(
    "incomplete %s fleet is not absence or authority",
    async (kind) => {
      const w = await world();
      w.orca.worktreePs = async () => ({
        worktrees: [],
        truncated: kind === "truncated",
        omittedHostIds: kind === "omitted-host" ? ["remote"] : [],
      });
      await retained(w, "inventory_incomplete");
    },
  );
  test("complete fleet absence with surviving filesystem is not removal", async () => {
    const w = await world();
    w.orca.rows.clear();
    await retained(w, "fleet_absent_path_present");
  });
  test.each(["claimed", "working", "awaiting-human", "review", "blocked", "released"] as const)(
    "CL-2 force retains lifecycle %s",
    async (stage) => {
      const w = await world();
      w.r.stage = stage;
      await writeRecord(w.dirs, w.r);
      await retained(w, `stage_${stage}`);
    },
  );
  test("CL-3 normal CLI/dispatcher grace, boundary, and force only bypassing grace", async () => {
    const w = await world();
    present(w.r.history[0]).at = new Date(w.clock.now().getTime() - 24 * 3_600_000 + 1).toISOString();
    await writeRecord(w.dirs, w.r);
    await retained(w, "grace", false);
    expect(await result(w, { dryRun: true, force: true })).toMatchObject({ outcome: "eligible" });
    w.clock.advance(1);
    expect(await result(w)).toMatchObject({ outcome: "removed" });
  });
  test("force actually removes only an otherwise eligible fresh terminal record", async () => {
    const w = await world();
    present(w.r.history[0]).at = w.ctx.now();
    await writeRecord(w.dirs, w.r);
    expect(await result(w, { force: true })).toMatchObject({ outcome: "removed" });
  });
  test("future terminal time and missing history are not authorized by force", async () => {
    for (const future of [false, true]) {
      const w = await world();
      if (future) present(w.r.history[0]).at = new Date(w.clock.now().getTime() + 1000).toISOString();
      else w.r.history = [];
      await writeRecord(w.dirs, w.r);
      await retained(w, "terminal_time_unverified");
    }
  });
  test("force retains an open PR, including a newly discovered branch PR", async () => {
    const w = await world();
    w.gh.prs.push({
      number: 1,
      head: present(w.r.worktree).branch,
      url: "https://github.com/fake/repo/pull/1",
    });
    await retained(w, "open_pr");
  });
  test.each(["OPEN", "UNKNOWN", "lookup-failed"])("recorded closed PR is refreshed: %s", async (state) => {
    const w = await world();
    w.r.prs = [
      {
        repo: w.r.repo,
        number: 1,
        headSha: "head",
        state: "CLOSED",
        url: "https://github.com/fake/repo/pull/1",
      },
    ];
    await writeRecord(w.dirs, w.r);
    w.gh.prView = async () => {
      if (state === "lookup-failed") throw new Error("offline");
      return { state, headRefName: present(w.r.worktree).branch, url: present(w.r.prs[0]).url };
    };
    await retained(
      w,
      state === "OPEN"
        ? "open_pr"
        : state === "UNKNOWN"
          ? "pr_state_unverified"
          : "unverified:internal_error",
    );
  });
  test("CLOSED unmerged changes and unavailable remote history stay retained", async () => {
    const w = await world();
    w.git.heads.set(w.wt.path, "unmerged");
    await retained(w, "unmerged_or_unknown");
  });
  test("dirty untracked work is retained by the real pinned Git helper", async () => {
    const w = await world();
    await writeFile(join(w.wt.path, "important.txt"), "human work");
    await retained(w, "dirty");
  });
  test.each(["repo", "branch", "issue", "path"])("mismatched %s identity is retained", async (field) => {
    const w = await world();
    const row = present(w.orca.rows.get(w.wt.id));
    if (field === "repo") row.repoId = "foreign";
    if (field === "branch") row.branch = "foreign";
    if (field === "issue") row.linkedLinearIssue = "JRF-999";
    if (field === "path") row.path = `${w.wt.path}-other`;
    await retained(w, "identity_mismatch");
  });
  test("tampered git links fail closed", async () => {
    const w = await world();
    await rm(join(w.wt.path, ".git"));
    await symlink(join(w.root, "missing"), join(w.wt.path, ".git"));
    await retained(w, "unverified:git_dir_tampered");
  });
  test("an adopted human workspace has no deletion ownership", async () => {
    const w = await world();
    await rm(join(w.dirs.journal, `${w.claim.id}.json`));
    await retained(w, "ownership_unverified");
  });
  test("archive and shared current references retain even a created workspace", async () => {
    for (const archive of [true, false]) {
      const w = await world();
      const copy = structuredClone(w.r);
      copy.identifier = "JRF-999";
      copy.stage = "released";
      if (archive) {
        await mkdir(w.dirs.archive, { recursive: true });
        await writeFile(join(w.dirs.archive, "JRF-999.1.json"), recordText(copy));
      } else await writeRecord(w.dirs, copy);
      await retained(w, archive ? "archived_reference" : "shared_reference");
    }
  });
  test("CL-4 explicit orphan inspection is scoped, read-only, and retains prefix-only, archived and foreign references", async () => {
    const w = await world();
    const original = present(w.orca.rows.get(w.wt.id));
    w.orca.rows.set("unowned", {
      ...original,
      worktreeId: "unowned",
      path: `${w.root}/wm-unowned`,
      linkedLinearIssue: null,
    });
    w.orca.rows.set("foreign", {
      ...original,
      worktreeId: "foreign",
      repoId: "foreign",
      path: `${w.root}/wm-foreign`,
    });
    w.orca.rows.set("archived", { ...original, worktreeId: "archived", path: `${w.root}/wm-archived` });
    const old = structuredClone(w.r);
    old.worktree = { ...present(w.r.worktree), id: "archived", path: `${w.root}/wm-archived` };
    await mkdir(w.dirs.archive, { recursive: true });
    await writeFile(join(w.dirs.archive, "JRF-501.0.json"), recordText(old));
    const project = { kind: "project", key: w.r.project } as const;
    expect((await run(w, { scope: project, dryRun: true })).orphaned).toEqual([]);
    const found = await run(w, { scope: project, orphaned: true, dryRun: true });
    expect(found.orphaned).toEqual([
      {
        worktreeId: "unowned",
        path: `${w.root}/wm-unowned`,
        outcome: "retained",
        reason: "ownership_unverified",
      },
      {
        worktreeId: "archived",
        path: `${w.root}/wm-archived`,
        outcome: "retained",
        reason: "retained_reference",
      },
    ]);
    expect((await run(w, { orphaned: true, dryRun: true })).orphaned.map((r) => r.worktreeId)).toEqual([
      "archived",
    ]);
    expect(w.orca.removed).toEqual([]);
  });
  test.each(["live", "unverifiable", "failed-list", "incomplete"])(
    "worker %s cannot authorize cleanup",
    async (status) => {
      const w = await world();
      w.r.coordinator.childRunId = "run-1";
      await writeRecord(w.dirs, w.r);
      w.orca.cleanupWorkers = async () => {
        if (status === "failed-list") throw new Error("failed stop/list");
        return {
          complete: status !== "incomplete",
          workers: [
            {
              dispatchId: "dispatch-1",
              taskId: "task-1",
              runId: "run-1",
              workerState: "done",
              dispatchStatus: "completed",
              agentTerminalHandle: null,
              verdict: status === "live" ? "live" : "unverifiable",
            },
          ],
        };
      };
      await retained(
        w,
        status === "failed-list"
          ? "unverified:internal_error"
          : status === "incomplete"
            ? "worker_inventory_incomplete"
            : "worker_unverified",
      );
      expect(w.orca.calls.some((c) => c.verb === "workerStop" || c.verb === "workerAbandon")).toBe(false);
    },
  );
  test("release uncertainty and outstanding assignment survive lifecycle done", async () => {
    const w = await world();
    w.r.attention.push("release_unverifiable(dispatch-1)");
    await writeRecord(w.dirs, w.r);
    await retained(w, "termination_unverified");
    const other = await world();
    await other.ctx.journal.intent({
      issue: other.r.identifier,
      kind: "terminalCreate",
      key: "pending",
      input: {},
    });
    await retained(other, "outstanding_assignment");
  });
  test("uncertain native/device/runtime cleanup retains the workspace", async () => {
    const w = await world();
    w.r.nativeUiJobs.push(
      NativeJobSchema.parse({
        id: "native1",
        requestId: "native1",
        issue: w.r.identifier,
        cycle: 1,
        attempt: 1,
        worktreeId: w.wt.id,
        headSha: "a".repeat(40),
        policyHash: "b".repeat(64),
        executionIsolationHash: "c".repeat(64),
        recipeHash: "d".repeat(64),
        requestedAt: w.ctx.now(),
        status: "failed",
        udid: null,
        createUncertain: false,
        cleanupComplete: false,
        receiptHash: null,
        evidencePath: "evidence",
        notified: true,
      }),
    );
    await writeRecord(w.dirs, w.r);
    await retained(w, "native_unverified");
  });
  test("foreign terminals, owned children and active/unknown processes are never signalled", async () => {
    for (const kind of ["terminal", "child", "process", "incomplete", "throws"]) {
      const w = await world();
      const row = present(w.orca.rows.get(w.wt.id));
      if (kind === "terminal") row.liveTerminalCount = 1;
      if (kind === "child") row.childWorktreeIds = ["foreign-child"];
      if (kind === "process") w.ctx.inspectCleanupProcesses = async () => ({ complete: true, pids: [123] });
      if (kind === "incomplete") w.ctx.inspectCleanupProcesses = async () => ({ complete: false, pids: [] });
      if (kind === "throws")
        w.ctx.inspectCleanupProcesses = async () => {
          throw new Error("scan failed");
        };
      w.ctx.sweep = async () => {
        throw new Error("unsafe sweep must never run");
      };
      await retained(
        w,
        {
          terminal: "active_terminals",
          child: "children_retained",
          process: "active_processes",
          incomplete: "process_inventory_incomplete",
          throws: "unverified:internal_error",
        }[kind] ?? "fixture_reason_missing",
      );
    }
  });
  test("record and retention changes during external reads refuse before removal", async () => {
    for (const kind of ["record", "archive"]) {
      const w = await world();
      let calls = 0;
      w.gh.hasOpenPr = async () => {
        if (++calls === 2) {
          if (kind === "record") {
            const changed = structuredClone(w.r);
            changed.stage = "working";
            await writeRecord(w.dirs, changed);
          } else {
            await mkdir(w.dirs.archive, { recursive: true });
            await writeFile(join(w.dirs.archive, "JRF-501.1.json"), recordText(w.r));
          }
        }
        return false;
      };
      await expect(run(w)).rejects.toMatchObject({ code: "record_changed" });
      expect(w.orca.removed).toEqual([]);
    }
  });
  test("lock fencing, global stop, scoped stop, and deadline refuse before effects", async () => {
    for (const kind of ["lock", "stop", "scoped", "deadline"]) {
      const w = await world();
      w.gh.hasOpenPr = async () => {
        if (kind === "lock")
          await writeFile(
            TickLock.path(w.dirs),
            JSON.stringify({ pid: process.pid, token: "new-owner", heartbeatAt: w.ctx.now() }),
          );
        if (kind === "stop") await requestStop(w.dirs, { scope: "all", at: w.ctx.now() });
        if (kind === "scoped")
          await requestStop(w.dirs, { scope: "issue", key: w.r.identifier, at: w.ctx.now() });
        if (kind === "deadline") w.ctx.deadline = { at: 0, now: () => 1 };
        return false;
      };
      if (kind === "stop" || kind === "scoped")
        expect(await result(w)).toMatchObject({ reason: "stop_requested" });
      else await expect(run(w)).rejects.toBeDefined();
      expect(w.orca.removed).toEqual([]);
    }
  });
  test("tick and CLI share the same mutation lock in both directions", async () => {
    const w = await world();
    const lock = await TickLock.acquire(w.dirs, w.clock);
    expect(lock.kind).not.toBe("held");
    await expect(run(w)).rejects.toMatchObject({ code: "lock_held" });
    if (lock.kind !== "held") await lock.release();
    let observed = false;
    w.gh.hasOpenPr = async () => {
      observed = true;
      expect((await tick(w.ctx, { dryRun: false, precheck: false })).outcome).toBe("lock_held");
      return false;
    };
    expect(await result(w)).toMatchObject({ outcome: "removed" });
    expect(observed).toBe(true);
  });
  test("partial remove replay requires fleet and filesystem absence and never removes twice", async () => {
    const w = await world();
    w.orca.failAfter = "worktreeRm";
    expect(await result(w)).toMatchObject({ outcome: "deferred" });
    expect((await readRecord(w.dirs, w.r.identifier))?.worktree).not.toBeNull();
    expect(await result(w, { force: true, dryRun: true })).toMatchObject({ reason: "retry_delay" });
    w.clock.advance(24 * 3_600_000);
    expect(await result(w)).toMatchObject({ outcome: "removed", reason: "already_absent" });
    expect(w.orca.removed).toEqual([w.wt.id]);
  });
  test("success reply with surviving path/fleet is unverified", async () => {
    const w = await world();
    w.orca.worktreeRm = async () => {};
    expect(await result(w)).toMatchObject({ outcome: "deferred", reason: "removal_unverified" });
    expect((await readRecord(w.dirs, w.r.identifier))?.worktree).not.toBeNull();
  });
  test("dispatcher enters the same grace/eligibility path", async () => {
    const w = await world();
    present(w.r.history[0]).at = w.ctx.now();
    await writeRecord(w.dirs, w.r);
    const rec = { records: [w.r], partial: false } as Reconciled;
    const summary = { skipped: [], attention: [] } as unknown as TickSummary;
    await cleanup(w.ctx, rec, summary);
    expect(w.orca.removed).toEqual([]);
    expect(await result(w, { dryRun: true })).toMatchObject({ reason: "grace" });
  });
  test("legacy/malformed fleet completeness and invalid archive evidence never become authorization", async () => {
    const w = await world();
    const ps = w.orca.worktreePs.bind(w.orca);
    w.orca.worktreePs = async () => {
      const { cleanupVerified: _verified, ...legacy } = await ps();
      return legacy;
    };
    await retained(w, "inventory_incomplete");
    const other = await world();
    await mkdir(other.dirs.archive, { recursive: true });
    await writeFile(join(other.dirs.archive, "JRF-999.1.json"), "broken");
    await expect(run(other, { dryRun: true })).rejects.toBeDefined();
    await expect(run(other)).rejects.toBeDefined();
    expect(other.orca.removed).toEqual([]);
  });
  test("a live resource appearing during content reads is re-observed before removal", async () => {
    const w = await world();
    w.git.lsRemoteSha = async () => {
      present(w.orca.rows.get(w.wt.id)).liveTerminalCount = 1;
      return "basesha";
    };
    expect(await result(w, { dryRun: true })).toMatchObject({ reason: "resource_changed" });
    expect(await result(w)).toMatchObject({ reason: "active_terminals" });
    expect(w.orca.removed).toEqual([]);
  });
  test("a refused removal never clears ownership and a no-effect retry remains possible", async () => {
    const w = await world();
    w.orca.failNext = "worktreeRm";
    expect(await result(w)).toMatchObject({ outcome: "deferred" });
    expect((await readRecord(w.dirs, w.r.identifier))?.worktree).not.toBeNull();
    expect(w.orca.removed).toEqual([]);
    w.clock.advance(24 * 3_600_000);
    expect(await result(w)).toMatchObject({ outcome: "removed" });
  });
  test("dry-run with absent state directories creates nothing", async () => {
    const w = await world();
    const before = await snapshot(w.root);
    const missing = join(w.root, "absent");
    const ctx = {
      ...w.ctx,
      dirs: {
        ...w.dirs,
        state: missing,
        records: join(missing, "records"),
        archive: join(missing, "archive"),
        journal: join(missing, "journal"),
      },
    };
    expect((await cleanupOps(ctx, { ...options, dryRun: true })).cleaned).toEqual([]);
    expect(await snapshot(w.root)).toEqual(before);
  });
  test("partial terminal inventory is retained even when its compatibility array is empty", async () => {
    const w = await world();
    w.orca.cleanupTerminals = async () =>
      parseCleanupTerminals(
        {
          ok: true,
          result: {
            terminals: [],
            truncated: true,
            totalCount: 0,
            hostScope: { hostIds: ["local"], omittedHostIds: ["remote"] },
          },
        },
        w.wt.id,
      );
    await retained(w, "terminal_inventory_incomplete");
  });
  test("terminal inspection failure and absent completeness never authorize removal", async () => {
    const w = await world();
    w.orca.cleanupTerminals = async () =>
      parseCleanupTerminals({ ok: true, result: { terminals: [] } }, w.wt.id);
    await retained(w, "terminal_inventory_incomplete");
    const other = await world();
    other.orca.cleanupTerminals = async () => {
      throw new Error("terminal list unavailable");
    };
    await retained(other, "unverified:internal_error");
  });
});
