import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { issueCommand } from "../../src/cli/commands/issue";
import { parseArgv } from "../../src/cli/index";
import { consumeIntent, listIntents, writeIntent } from "../../src/kit/intents";
import { readLocal, writeLocal } from "../../src/kit/local";
import { claimIssue } from "../../src/machine/claim";
import { TickAbort } from "../../src/machine/guard";
import {
  executeNativeUi,
  nativeElement,
  nativeJobDir,
  recoverNativeUi,
  verifyNativeUiGate,
} from "../../src/machine/nativeUi";
import { reconcile } from "../../src/machine/reconcile";
import { stopAgents } from "../../src/machine/release";
import { saveRecord } from "../../src/machine/save";
import { appDigest, artifactDir } from "../../src/native/artifact";
import { type NativeUiPort, cleanupOwnedDevice, nativeUiHost } from "../../src/native/host";
import { NativePolicySchema, NativeRecipeSchema, policyHash } from "../../src/native/protocol";
import { setPause } from "../../src/ops/pause";
import { run } from "../../src/shared/exec";
import { readRecord } from "../../src/state/records";
import { addLabeledByOwner, todo } from "../fakes/issues";
import { makeWorld } from "../fakes/world";
import { runTick } from "./harness";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("required test fixture missing");
  return value;
}
const ID = "JRF-501";
const UDID = "11111111-1111-4111-8111-111111111111";
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const policy = () =>
  NativePolicySchema.parse({
    runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
    deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
    bundleId: "lol.bouncr.app",
    producer: "fixture-isolated-builder",
    isolationHash: "a".repeat(64),
    executionIsolationHash: "b".repeat(64),
    testEnv: { WINGMATE_OFFLINE_FIXTURE: "1" },
    timeoutMs: 90_000,
  });
const snapshot = (label = "Welcome") => ({
  screen: { width: 402, height: 874 },
  elements: [
    { id: "one", label, value: "", enabled: true, frame: { x: 0.1, y: 0.2, width: 0.2, height: 0.1 } },
  ],
});
const recipe = NativeRecipeSchema.parse({
  kind: "ios",
  steps: [{ expectText: "Welcome" }, { tapText: "Welcome" }],
});
async function setup() {
  const w = await makeWorld();
  const project = required(w.cfg.projects.bouncr);
  const repo = required(project.repos.api);
  repo.ui.native = policy();
  addLabeledByOwner(w.linear, todo("i1", ID));
  const issue = required((await w.linear.getIssues(["i1"]))[0]);
  const r = await claimIssue(w.ctx, {
    issue,
    project,
    provider: "claude",
    repoName: "api",
    routing: { basis: "default", candidates: [], rerouteFrom: null },
  });
  r.stage = "working";
  r.pipelineStage = "ui";
  for (const s of ["intake", "plan", "planVerify", "implement", "validate"] as const)
    r.gates[s].verdict = "PASS";
  await saveRecord(w.ctx, r);
  const wt = required(r.worktree).path;
  w.orca.setAgentState(required(r.worktree).id, required(r.coordinator.paneKey), "done", w.ctx.now());
  const local = await readLocal(wt);
  local.record.pipelineStage = "ui";
  await writeLocal(wt, local);
  const head = (await run(["git", "-C", wt, "rev-parse", "HEAD"])).stdout.trim();
  w.git.heads.set(wt, head);
  const calls: { kind: string; args: string[] }[] = [];
  let now = 0;
  const port: NativeUiPort = {
    executionIsolation: async () => ({
      kind: "dedicated-isolated-host",
      profileHash: policy().executionIsolationHash,
    }),
    observe: async () => ({ bundleId: "lol.bouncr.app", pid: 123, snapshot: snapshot() }),
    now: () => now,
    pause: async (ms) => {
      now += ms;
    },
    bundleId: async () => "lol.bouncr.app",
    emulator: async (args) => {
      calls.push({ kind: "emulator", args });
      return {};
    },
    simctl: async (args) => {
      calls.push({ kind: "simctl", args });
      const saved = await readRecord(w.dirs, ID);
      if (args[0] === "create")
        expect(saved?.nativeUiJobs[0]).toMatchObject({
          createUncertain: true,
          udid: null,
          cleanupComplete: false,
        });
      if (args[0] === "boot")
        expect(saved?.nativeUiJobs[0]).toMatchObject({ createUncertain: false, udid: UDID });
      if (args[0] === "io") writeFileSync(required(args.at(-1)), PNG);
      return {
        code: 0,
        stdout: args[0] === "create" ? `${UDID}\n` : args[0] === "launch" ? "lol.bouncr.app: 123\n" : "",
        stderr: "",
        timedOut: false,
        truncated: false,
      };
    },
    cleanup: async (udid, worktree) => {
      calls.push({ kind: "cleanup", args: [udid, worktree] });
      return [];
    },
  };
  w.ctx.nativeUi = port;
  const newRequest = async () => {
    const i = await writeIntent(wt, {
      issue: ID,
      kind: "native-ui",
      payload: {
        recipe,
        headSha: head,
        policyHash: policyHash(required(repo.ui.native)),
        worktreeId: required(r.worktree).id,
        cycle: r.cycle,
        attempt: r.coordinator.attempt,
      },
    });
    if (i.kind !== "native-ui") throw new Error("native fixture");
    return i;
  };
  const admit = async () => {
    const dir = artifactDir(w.dirs, repo.orcaRepo, head, required(repo.ui.native));
    mkdirSync(join(dir, "app.app"), { recursive: true });
    writeFileSync(join(dir, "app.app", "Info.plist"), "trusted-fixture-plist");
    writeFileSync(join(dir, "app.app", "binary"), "trusted-fixture-binary");
    writeFileSync(
      join(dir, "receipt.json"),
      JSON.stringify({
        version: 1,
        provenance: "dispatcher-isolated-build",
        producer: required(repo.ui.native).producer,
        isolationHash: required(repo.ui.native).isolationHash,
        sourceHead: head,
        policyHash: policyHash(required(repo.ui.native)),
        bundleId: "lol.bouncr.app",
        appHash: await appDigest(join(dir, "app.app")),
        builtAt: w.ctx.now(),
      }),
    );
    return dir;
  };
  return { w, r, wt, head, repo, port, calls, newRequest, admit };
}

describe("trusted native UI relay", () => {
  test("untrusted recipes cannot select a device, URL, executable, bundle, passthrough or oversized wave", () => {
    for (const bad of [
      { ...recipe, device: "booted" },
      { ...recipe, url: "https://example.com" },
      { ...recipe, bundleId: "other.app" },
      { ...recipe, app: "/tmp/evil.app" },
      { ...recipe, steps: [{ exec: "erase all" }] },
      { ...recipe, steps: [{ screenshot: true }] },
      { ...recipe, steps: Array(21).fill({ expectText: "x" }) },
      { ...recipe, steps: [{ tapText: "x", expectText: "x" }] },
    ])
      expect(NativeRecipeSchema.safeParse(bad).success).toBe(false);
    expect(NativePolicySchema.safeParse({ ...policy(), timeoutMs: 120_000 }).success).toBe(false);
  });
  test("default shared host cannot attest isolated native app execution", async () => {
    expect(await nativeUiHost("/unread-home").executionIsolation()).toBeNull();
    const f = await setup();
    await f.admit();
    f.port.executionIsolation = async () => null;
    await executeNativeUi(f.w.ctx, f.r, await f.newRequest(), await reconcile(f.w.ctx));
    expect(f.calls).toEqual([]);
    expect(f.r.nativeUiJobs[0]?.status).toBe("failed");
    expect(
      readFileSync(
        join(nativeJobDir(f.w.ctx, f.r, required(f.r.nativeUiJobs[0]).id), "receipt.json"),
        "utf8",
      ),
    ).toContain("native app execution requires");
  });
  test("missing, stale or linked isolated-build artifacts never create a Simulator", async () => {
    for (const mode of ["missing", "stale", "symlink"]) {
      const f = await setup();
      if (mode !== "missing") {
        const dir = await f.admit();
        if (mode === "stale") {
          const p = join(dir, "receipt.json");
          const r = JSON.parse(readFileSync(p, "utf8"));
          r.sourceHead = "f".repeat(40);
          writeFileSync(p, JSON.stringify(r));
        } else symlinkSync("/etc/passwd", join(dir, "app.app", "planted"));
      }
      await executeNativeUi(f.w.ctx, f.r, await f.newRequest(), await reconcile(f.w.ctx));
      expect(f.calls).toEqual([]);
      expect(f.r.nativeUiJobs[0]?.status).toBe("failed");
    }
  });
  test("artifact hashing bounds empty directories and depth, checks chunk deadlines and cannot allocate after admission expires", async () => {
    const f = await setup();
    const dir = await f.admit();
    const app = join(dir, "app.app");
    const before = await appDigest(app);
    mkdirSync(join(app, "empty"));
    expect(await appDigest(app)).not.toBe(before);
    for (let n = 0; n < 20_000; n++) mkdirSync(join(app, `empty-${n}`));
    await expect(appDigest(app)).rejects.toThrow("no verified isolated-build artifact");
    const deep = await setup();
    const deepDir = await deep.admit();
    mkdirSync(join(deepDir, "app.app", ...Array(33).fill("nested")), { recursive: true });
    await expect(appDigest(join(deepDir, "app.app"))).rejects.toThrow("no verified isolated-build artifact");
    const expired = await setup();
    const expiredDir = await expired.admit();
    writeFileSync(join(expiredDir, "app.app", "binary"), Buffer.alloc(256 * 1024));
    let checks = 0;
    const abort = new TickAbort("error", "tick_deadline");
    await expect(
      appDigest(join(expiredDir, "app.app"), () => {
        if (++checks === 12) throw abort;
      }),
    ).rejects.toBe(abort);
    let clock = 0;
    expired.port.now = () => {
      clock += 15_000;
      return clock;
    };
    await executeNativeUi(
      expired.w.ctx,
      expired.r,
      await expired.newRequest(),
      await reconcile(expired.w.ctx),
    );
    expect(expired.calls).toEqual([]);
    expect(expired.r.nativeUiJobs[0]?.status).toBe("failed");
    expect(
      readFileSync(
        join(nativeJobDir(expired.w.ctx, expired.r, required(expired.r.nativeUiJobs[0]).id), "receipt.json"),
        "utf8",
      ),
    ).toContain("exceeded its bounded runtime");
  });
  test("allocates only its own UDID, persists ownership before boot, binds foreground assertions, captures proof and cleans before PASS", async () => {
    const f = await setup();
    await f.admit();
    const i = await f.newRequest();
    await executeNativeUi(f.w.ctx, f.r, i, await reconcile(f.w.ctx));
    const job = required(f.r.nativeUiJobs[0]);
    expect(job).toMatchObject({
      status: "succeeded",
      udid: UDID,
      cleanupComplete: true,
      createUncertain: false,
    });
    expect(f.calls.at(-1)).toEqual({ kind: "cleanup", args: [UDID, required(f.r.worktree).id] });
    for (const c of f.calls.filter((c) => c.kind === "emulator")) {
      expect(c.args).toContain(UDID);
      expect(c.args).toContain(`id:${required(f.r.worktree).id}`);
    }
    expect(f.calls.find((c) => c.args[0] === "tap")?.args.slice(0, 3)).toEqual(["tap", "0.2", "0.25"]);
    await verifyNativeUiGate(f.w.ctx, f.r, "PASS", i.id, f.head);
    // Advisory mirror is not authority, and changing it cannot change the protected success.
    writeFileSync(join(f.wt, ".wingmate", "native-ui.json"), "[]");
    await verifyNativeUiGate(f.w.ctx, f.r, "PASS", i.id, f.head);
    const creates = f.calls.filter((c) => c.args[0] === "create").length;
    await executeNativeUi(f.w.ctx, f.r, i, await reconcile(f.w.ctx));
    expect(f.calls.filter((c) => c.args[0] === "create")).toHaveLength(creates);
    await expect(
      executeNativeUi(
        f.w.ctx,
        f.r,
        {
          ...i,
          payload: {
            ...i.payload,
            recipe: NativeRecipeSchema.parse({ kind: "ios", steps: [{ expectText: "Different" }] }),
          },
        },
        await reconcile(f.w.ctx),
      ),
    ).rejects.toThrow("different inputs");
  });
  test("forged PASS, changed HEAD/config/evidence and mobile NA fail closed", async () => {
    const f = await setup();
    const i = await f.newRequest();
    await expect(verifyNativeUiGate(f.w.ctx, f.r, "PASS", i.id, f.head)).rejects.toThrow(
      "protected successful",
    );
    await f.admit();
    await executeNativeUi(f.w.ctx, f.r, i, await reconcile(f.w.ctx));
    f.w.git.heads.set(f.wt, "f".repeat(40));
    await expect(verifyNativeUiGate(f.w.ctx, f.r, "PASS", i.id, f.head)).rejects.toThrow("current HEAD");
    f.w.git.heads.set(f.wt, f.head);
    required(f.repo.ui.native).launchArgs = ["changed"];
    await expect(verifyNativeUiGate(f.w.ctx, f.r, "PASS", i.id, f.head)).rejects.toThrow(
      "protected successful",
    );
    required(f.repo.ui.native).launchArgs = [];
    writeFileSync(join(nativeJobDir(f.w.ctx, f.r, i.id), "step-00.png"), "tampered");
    await expect(verifyNativeUiGate(f.w.ctx, f.r, "PASS", i.id, f.head)).rejects.toThrow(
      "protected native receipt/evidence",
    );
    f.w.git.changed.set(f.wt, ["mobile/src/screen.tsx"]);
    await expect(verifyNativeUiGate(f.w.ctx, f.r, "NA", null, f.head)).rejects.toThrow("NA is unavailable");
  });
  test("publish verifies native proof and NA against its captured commit/diff while live gates require current HEAD", async () => {
    const f = await setup();
    await f.admit();
    const i = await f.newRequest();
    await executeNativeUi(f.w.ctx, f.r, i, await reconcile(f.w.ctx));
    f.w.git.heads.set(f.wt, "f".repeat(40));
    await expect(verifyNativeUiGate(f.w.ctx, f.r, "PASS", i.id, f.head)).rejects.toThrow("current HEAD");
    const captured = { head: f.head, changedPaths: ["mobile/src/screen.tsx"] };
    await verifyNativeUiGate(f.w.ctx, f.r, "PASS", i.id, f.head, captured);
    await expect(verifyNativeUiGate(f.w.ctx, f.r, "PASS", i.id, "f".repeat(40), captured)).rejects.toThrow(
      "current HEAD",
    );
    await expect(verifyNativeUiGate(f.w.ctx, f.r, "NA", null, f.head, captured)).rejects.toThrow(
      "NA is unavailable",
    );
    await verifyNativeUiGate(f.w.ctx, f.r, "NA", null, f.head, {
      head: f.head,
      changedPaths: ["docs/readme.md"],
    });
    writeFileSync(join(f.wt, "dirty-source.ts"), "uncommitted\n");
    expect((await run(["git", "-C", f.wt, "add", "dirty-source.ts"])).code).toBe(0);
    await expect(verifyNativeUiGate(f.w.ctx, f.r, "PASS", i.id, f.head, captured)).rejects.toThrow(
      "clean tracked worktree/index",
    );
  });
  test("working/partial fleet, changed identity, dirty source and insufficient deadline never launch", async () => {
    const f = await setup();
    await f.admit();
    const i = await f.newRequest();
    const rec = await reconcile(f.w.ctx);
    rec.liveness.set(ID, "working");
    await expect(executeNativeUi(f.w.ctx, f.r, i, rec)).rejects.toThrow("idle coordinator");
    rec.liveness.set(ID, "idle");
    rec.partial = true;
    await expect(executeNativeUi(f.w.ctx, f.r, i, rec)).rejects.toThrow("complete fleet");
    rec.partial = false;
    await expect(
      executeNativeUi(f.w.ctx, f.r, { ...i, payload: { ...i.payload, attempt: 999 } }, rec),
    ).rejects.toThrow("another worktree");
    f.w.ctx.deadline = { at: 1000, now: () => 0 };
    await expect(executeNativeUi(f.w.ctx, f.r, i, rec)).rejects.toThrow("not enough tick time");
    Reflect.deleteProperty(f.w.ctx, "deadline");
    writeFileSync(join(f.wt, "staged-source.ts"), "export const changed = true;\n");
    expect((await run(["git", "-C", f.wt, "add", "staged-source.ts"])).code).toBe(0);
    await executeNativeUi(f.w.ctx, f.r, i, rec);
    expect(f.r.nativeUiJobs[0]?.status).toBe("failed");
    expect(f.calls).toEqual([]);
  });
  test("startup polling uses fresh bound snapshots; another app/process, duplicate targets and unavailable AX cannot pass", async () => {
    const f = await setup();
    await f.admit();
    let count = 0;
    f.port.observe = async () => ({
      bundleId: "lol.bouncr.app",
      pid: 123,
      snapshot: snapshot(++count < 4 ? "Loading" : "Welcome"),
    });
    await executeNativeUi(f.w.ctx, f.r, await f.newRequest(), await reconcile(f.w.ctx));
    expect(f.r.nativeUiJobs[0]?.status).toBe("succeeded");
    expect(count).toBeGreaterThan(4);
    const wrong = await setup();
    await wrong.admit();
    wrong.port.observe = async () => ({ bundleId: "com.apple.springboard", pid: 1, snapshot: snapshot() });
    await executeNativeUi(wrong.w.ctx, wrong.r, await wrong.newRequest(), await reconcile(wrong.w.ctx));
    expect(wrong.r.nativeUiJobs[0]?.status).toBe("failed");
    expect(wrong.calls.at(-1)?.kind).toBe("cleanup");
    expect(() =>
      nativeElement(
        { ...snapshot(), elements: [...snapshot().elements, ...snapshot().elements] },
        "Welcome",
        true,
      ),
    ).toThrow("exactly one");
    expect(() => nativeElement({ ...snapshot(), errors: ["unavailable"] }, "Welcome", false)).toThrow(
      "unavailable",
    );
    expect(() =>
      nativeElement(
        {
          ...snapshot(),
          elements: [{ ...snapshot().elements[0], frame: { x: 20, y: 30, width: 100, height: 40 } }],
        },
        "Welcome",
        true,
      ),
    ).toThrow("unsupported shape");
  });
  test("interruption never creates a second device; failed cleanup never proves PASS", async () => {
    const f = await setup();
    await f.admit();
    const i = await f.newRequest();
    f.port.cleanup = async () => ["device deletion failed"];
    await executeNativeUi(f.w.ctx, f.r, i, await reconcile(f.w.ctx));
    expect(f.r.nativeUiJobs[0]?.status).toBe("unverifiable");
    await expect(verifyNativeUiGate(f.w.ctx, f.r, "PASS", i.id, f.head)).rejects.toThrow(
      "protected successful",
    );
    const job = required(f.r.nativeUiJobs[0]);
    job.status = "running";
    job.receiptHash = null;
    await saveRecord(f.w.ctx, f.r);
    f.port.cleanup = async () => [];
    const creates = f.calls.filter((c) => c.args[0] === "create").length;
    await executeNativeUi(f.w.ctx, f.r, i, await reconcile(f.w.ctx));
    expect(f.calls.filter((c) => c.args[0] === "create")).toHaveLength(creates);
    expect(f.r.nativeUiJobs[0]?.status as string).toBe("failed");
  });
  test("a stop abort during native action cleans only the allocated device, persists FAIL and propagates the abort", async () => {
    const f = await setup();
    await f.admit();
    const i = await f.newRequest();
    const simctl = f.port.simctl;
    const abort = new TickAbort("stopped", "stop_requested");
    f.port.simctl = async (...args) => {
      if (args[0][0] === "boot") throw abort;
      return simctl(...args);
    };
    await expect(executeNativeUi(f.w.ctx, f.r, i, await reconcile(f.w.ctx))).rejects.toBe(abort);
    expect(f.calls.at(-1)).toEqual({ kind: "cleanup", args: [UDID, required(f.r.worktree).id] });
    expect(f.r.nativeUiJobs[0]).toMatchObject({ status: "failed", cleanupComplete: true, udid: UDID });
    expect(
      JSON.parse(readFileSync(join(nativeJobDir(f.w.ctx, f.r, i.id), "receipt.json"), "utf8")).verdict,
    ).toBe("FAIL");
    await expect(verifyNativeUiGate(f.w.ctx, f.r, "PASS", i.id, f.head)).rejects.toThrow(
      "protected successful",
    );
  });
  test("native CLI writes local intent and END TURN without calling Orca; manual native PASS is refused", async () => {
    const f = await setup();
    const recipePath = join(f.wt, ".wingmate", "recipe.json");
    writeFileSync(recipePath, JSON.stringify(recipe));
    const never = async () => {
      throw new Error("agent must not call Orca");
    };
    const deps = {
      cwd: f.wt,
      env: { WINGMATE_ROLE: "coordinator" },
      orca: { workerList: never, exec: never, agentContext: never },
    };
    expect(
      await issueCommand(parseArgv(["issue", ID, "ui-smoke", "--recipe", ".wingmate/recipe.json"]), deps),
    ).toBe(0);
    expect((await listIntents(f.wt)).filter((i) => i.kind === "native-ui")).toHaveLength(1);
    expect(
      await issueCommand(
        parseArgv(["issue", ID, "gate", "ui", "--verdict", "PASS", "--evidence", ".wingmate/recipe.json"]),
        deps,
      ),
    ).toBe(2);
  });
  test("settled replay repairs an absent advisory receipt/artifact without replaying device actions", async () => {
    const f = await setup();
    await f.admit();
    const i = await f.newRequest();
    await executeNativeUi(f.w.ctx, f.r, i, await reconcile(f.w.ctx));
    const count = f.calls.length;
    rmSync(join(f.wt, ".wingmate/evidence/native-ui", i.id), { recursive: true });
    await executeNativeUi(f.w.ctx, f.r, i, await reconcile(f.w.ctx));
    expect(f.calls).toHaveLength(count);
    expect(
      JSON.parse(readFileSync(join(f.wt, required(f.r.nativeUiJobs[0]).evidencePath), "utf8")).verdict,
    ).toBe("PASS");
    expect(readFileSync(join(f.wt, ".wingmate/evidence/native-ui", i.id, "step-00.png"))).toEqual(PNG);
  });
  test("recovery and stop clean protected ownership across stage/attempt changes and never replay launch", async () => {
    const f = await setup();
    await f.admit();
    const i = await f.newRequest();
    await executeNativeUi(f.w.ctx, f.r, i, await reconcile(f.w.ctx));
    const job = required(f.r.nativeUiJobs[0]);
    job.status = "running";
    job.cleanupComplete = false;
    f.r.stage = "awaiting-human";
    f.r.coordinator.attempt++;
    f.repo.ui.native = undefined;
    await saveRecord(f.w.ctx, f.r);
    const creates = f.calls.filter((c) => c.args[0] === "create").length;
    expect(await recoverNativeUi(f.w.ctx, f.r)).toEqual([]);
    expect(job.cleanupComplete).toBe(true);
    expect(job.status as string).toBe("failed");
    expect(f.calls.filter((c) => c.args[0] === "create")).toHaveLength(creates);
    job.status = "running";
    job.cleanupComplete = false;
    await saveRecord(f.w.ctx, f.r);
    expect((await stopAgents(f.w.ctx, f.r)).unverifiable).toEqual([]);
    expect(job.notified).toBe(true);
    expect(job.cleanupComplete).toBe(true);
  });
  test("completed native result waits through paused/zero-resume ticks and resumes once with refreshed advisory flags", async () => {
    const f = await setup();
    await f.admit();
    const i = await f.newRequest();
    await executeNativeUi(f.w.ctx, f.r, i, await reconcile(f.w.ctx));
    await consumeIntent(f.wt, i.id);
    f.r.timers.capMin = 1;
    await saveRecord(f.w.ctx, f.r);
    await setPause(f.w.dirs, "global", true);
    f.w.clock.advance(5 * 60_000);
    const paused = await runTick(f.w);
    expect(paused.resumes).toEqual([]);
    expect(paused.relaunches).toEqual([]);
    expect(paused.handoffs).toEqual([]);
    expect(required(await readRecord(f.w.dirs, ID)).nativeUiJobs[0]?.notified).toBe(false);
    await setPause(f.w.dirs, "global", false);
    f.w.cfg.defaults.dispatcher.resumesPerTick = 0;
    f.w.clock.advance(5 * 60_000);
    let summary = await runTick(f.w);
    expect(summary.resumes).toEqual([]);
    expect(summary.relaunches).toEqual([]);
    expect(summary.handoffs).toEqual([]);
    const waiting = required(await readRecord(f.w.dirs, ID));
    expect(waiting.nativeUiJobs[0]?.notified).toBe(false);
    expect(waiting.timers.nudges).toBe(0);
    f.w.cfg.defaults.dispatcher.resumesPerTick = 3;
    f.w.clock.advance(5 * 60_000);
    summary = await runTick(f.w);
    expect(summary.resumes).toEqual([ID]);
    expect(JSON.parse(readFileSync(join(f.wt, ".wingmate/native-ui.json"), "utf8"))[0].notified).toBe(true);
  });
  test("cleanup settles already-absent exact owned device/helper, preserves uncertainty on unavailable verification", async () => {
    const calls: string[][] = [];
    const simctl: NativeUiPort["simctl"] = async (args) => {
      calls.push(args);
      return {
        code: args[0] === "list" ? 0 : 1,
        stdout:
          args[0] === "list"
            ? JSON.stringify({ devices: { runtime: [{ udid: "22222222-2222-4222-8222-222222222222" }] } })
            : "",
        stderr: "",
        timedOut: false,
        truncated: false,
      };
    };
    const emulator: NativeUiPort["emulator"] = async (args) => {
      calls.push(args);
      if (args[0] === "kill") throw new Error("already gone");
      return { running: false };
    };
    expect(await cleanupOwnedDevice(simctl, emulator, UDID, "repo::/own-wt")).toEqual([]);
    for (const args of calls.filter((a) => ["shutdown", "delete", "kill"].includes(required(a[0]))))
      expect(args).toContain(UDID);
    expect(calls.some((a) => a.includes("booted") || a.includes("all"))).toBe(false);
    const unavailable: NativeUiPort["simctl"] = async () => {
      throw new Error("unavailable");
    };
    expect(await cleanupOwnedDevice(unavailable, emulator, UDID, "repo::/own-wt")).toEqual([
      "owned Simulator absence could not be verified",
    ]);
  });
  test("stale advisory jobs from a past cycle do not veto a new native request", async () => {
    const f = await setup();
    await f.admit();
    const i = await f.newRequest();
    await executeNativeUi(f.w.ctx, f.r, i, await reconcile(f.w.ctx));
    await consumeIntent(f.wt, i.id);
    const local = await readLocal(f.wt);
    local.record.cycle = f.r.cycle + 1;
    await writeLocal(f.wt, local);
    writeFileSync(join(f.wt, ".wingmate/recipe.json"), JSON.stringify(recipe));
    expect(
      await issueCommand(parseArgv(["issue", ID, "ui-smoke", "--recipe", ".wingmate/recipe.json"]), {
        cwd: f.wt,
        env: { WINGMATE_ROLE: "coordinator" },
        orca: { workerList: async () => [] },
      }),
    ).toBe(0);
  });
});
