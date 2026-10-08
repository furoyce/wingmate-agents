import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { issueCommand } from "../../src/cli/commands/issue";
import { parseArgv } from "../../src/cli/index";
import { consumeIntent, listIntents, writeIntent } from "../../src/kit/intents";
import { readLocal, writeLocal } from "../../src/kit/local";
import { claimIssue } from "../../src/machine/claim";
import { TickAbort, guardedCtx } from "../../src/machine/guard";
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
import {
  NATIVE_CAPTURE_MAX_BYTES,
  NATIVE_CLEANUP_RESERVE_MS,
  NATIVE_DEVICE_CLEANUP_MS,
  NativeJobSchema,
  NativePolicySchema,
  NativeRecipeSchema,
  type NativeRuntimeBinding,
  NativeRuntimeBindingSchema,
  policyHash,
  runtimeBindingHash,
} from "../../src/native/protocol";
import { setPause } from "../../src/ops/pause";
import { OrcaError } from "../../src/orca/cli";
import { run } from "../../src/shared/exec";
import { readRecord } from "../../src/state/records";
import { addLabeledByOwner, todo } from "../fakes/issues";
import { makeWorld } from "../fakes/world";
import { OWNER, runTick } from "./harness";

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
  const binding: NativeRuntimeBinding = {
    version: 1,
    id: "fixture-runtime-lease-A",
    profileHash: policy().executionIsolationHash,
  };
  const bindingCalls: { kind: string; binding: NativeRuntimeBinding }[] = [];
  const acquired: Parameters<NativeUiPort["acquire"]>[0][] = [];
  const runtimeState = { reserved: false, released: false };
  const assertBinding = async (kind: string, supplied: NativeRuntimeBinding) => {
    expect(supplied).toEqual(binding);
    expect((await readRecord(w.dirs, ID))?.nativeUiJobs[0]?.runtimeBinding).toEqual(binding);
    bindingCalls.push({ kind, binding: { ...supplied } });
  };
  let now = 0;
  const port: NativeUiPort = {
    acquire: async (request) => {
      acquired.push(request);
      expect((await readRecord(w.dirs, ID))?.nativeUiJobs[0]).toMatchObject({
        runtimeAcquireUncertain: true,
        runtimeReleased: false,
        cleanupComplete: false,
      });
      runtimeState.reserved = true;
      runtimeState.released = false;
      return { ...binding };
    },
    lookup: async (request) => ({
      request,
      ...(runtimeState.reserved
        ? { status: "bound" as const, binding: { ...binding } }
        : { status: "absent" as const }),
    }),
    resolve: async (supplied) => {
      await assertBinding("resolve", supplied);
      return runtimeState.released ? null : { ...binding };
    },
    observe: async (supplied) => {
      await assertBinding("observe", supplied);
      return { bundleId: "lol.bouncr.app", pid: 123, snapshot: snapshot() };
    },
    now: () => now,
    pause: async (ms) => {
      now += ms;
    },
    bundleId: async (supplied) => {
      await assertBinding("bundleId", supplied);
      return "lol.bouncr.app";
    },
    emulator: async (supplied, args) => {
      await assertBinding("emulator", supplied);
      calls.push({ kind: "emulator", args });
      return {};
    },
    simctl: async (supplied, args) => {
      await assertBinding("simctl", supplied);
      calls.push({ kind: "simctl", args });
      const saved = await readRecord(w.dirs, ID);
      if (args[0] === "create")
        expect(saved?.nativeUiJobs[0]).toMatchObject({
          createUncertain: true,
          udid: null,
          cleanupComplete: false,
          runtimeBinding: binding,
        });
      if (args[0] === "boot")
        expect(saved?.nativeUiJobs[0]).toMatchObject({ createUncertain: false, udid: UDID });
      return {
        code: 0,
        stdout: args[0] === "create" ? `${UDID}\n` : args[0] === "launch" ? "lol.bouncr.app: 123\n" : "",
        stderr: "",
        timedOut: false,
        truncated: false,
      };
    },
    capture: async (supplied, udid, worktree, maxBytes, timeoutMs) => {
      await assertBinding("capture", supplied);
      expect(maxBytes).toBe(NATIVE_CAPTURE_MAX_BYTES);
      expect(timeoutMs).toBeGreaterThan(0);
      calls.push({ kind: "capture", args: [udid, worktree] });
      return PNG;
    },
    cleanup: async (supplied, udid, worktree) => {
      await assertBinding("cleanup", supplied);
      calls.push({ kind: "cleanup", args: [udid, worktree] });
      return [];
    },
    release: async (supplied, timeoutMs) => {
      await assertBinding("release", supplied);
      expect(timeoutMs).toBe(5_000);
      expect((await readRecord(w.dirs, ID))?.nativeUiJobs[0]?.deviceCleanupComplete).toBe(true);
      if (!runtimeState.reserved) throw new Error("unknown lease");
      runtimeState.released = true;
      calls.push({ kind: "release", args: [] });
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
  return {
    w,
    r,
    wt,
    head,
    repo,
    port,
    calls,
    binding,
    bindingCalls,
    acquired,
    runtimeState,
    newRequest,
    admit,
  };
}

async function interrupt(f: Awaited<ReturnType<typeof setup>>) {
  const job = required(f.r.nativeUiJobs[0]);
  job.status = "running";
  job.cleanupComplete = false;
  job.deviceCleanupComplete = false;
  job.runtimeReleased = false;
  f.runtimeState.released = false;
  await saveRecord(f.w.ctx, f.r);
  return job;
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
    const host = nativeUiHost("/unread-home");
    expect(
      await host.acquire({ requestId: "test", worktreeId: "fixture", profileHash: "b".repeat(64) }, 100),
    ).toBeNull();
    const f = await setup();
    expect(await host.resolve(f.binding, 100)).toBeNull();
    expect(
      await host.lookup(
        { requestId: "test", worktreeId: "fixture", profileHash: f.binding.profileHash },
        100,
      ),
    ).toBeNull();
    for (const refused of [
      () => host.simctl(f.binding, ["create"], 100),
      () => host.emulator(f.binding, ["attach", UDID], 100),
      () => host.bundleId(f.binding, "/unread-app", 100),
      () => host.observe(f.binding, UDID, "fixture", 100),
      () => host.capture(f.binding, UDID, "fixture", NATIVE_CAPTURE_MAX_BYTES, 100),
      () => host.cleanup(f.binding, UDID, "fixture", NATIVE_DEVICE_CLEANUP_MS),
      () => host.release(f.binding, 100),
    ])
      await expect(refused()).rejects.toThrow("shared-host transports are unavailable");
    await f.admit();
    f.port.acquire = async () => null;
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
  test("bindings have a strict version, opaque bounded ID and profile; invalid admission cannot allocate", async () => {
    const f = await setup();
    for (const bad of [
      { ...f.binding, version: 2 },
      { ...f.binding, id: "" },
      { ...f.binding, id: "x".repeat(201) },
      { ...f.binding, id: "lease\nother" },
      { ...f.binding, endpoint: "https://untrusted" },
      { ...f.binding, profileHash: "bad" },
    ])
      expect(NativeRuntimeBindingSchema.safeParse(bad).success).toBe(false);
    await f.admit();
    f.port.acquire = async () => ({ ...f.binding, profileHash: "c".repeat(64) });
    await executeNativeUi(f.w.ctx, f.r, await f.newRequest(), await reconcile(f.w.ctx));
    expect(f.calls).toEqual([]);
    expect(f.r.nativeUiJobs[0]).toMatchObject({ status: "failed", runtimeBinding: null, udid: null });
  });
  test("an unavailable or substituted acquired lease is refused before any native transport", async () => {
    for (const mode of ["unavailable", "wrong-id", "wrong-profile"]) {
      const f = await setup();
      await f.admit();
      f.port.resolve = async (binding) => {
        expect(binding).toEqual(f.binding);
        if (mode === "unavailable") return null;
        return mode === "wrong-id"
          ? { ...binding, id: "different-lease" }
          : { ...binding, profileHash: "c".repeat(64) };
      };
      await executeNativeUi(f.w.ctx, f.r, await f.newRequest(), await reconcile(f.w.ctx));
      expect(f.calls.filter((c) => c.kind !== "release")).toEqual([]);
      expect(f.acquired).toHaveLength(1);
      expect(f.r.nativeUiJobs[0]).toMatchObject({
        status: "failed",
        runtimeBinding: f.binding,
        udid: null,
        cleanupComplete: true,
      });
    }
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
      expect(f.calls).toEqual([{ kind: "release", args: [] }]);
      expect(f.r.nativeUiJobs[0]).toMatchObject({
        status: "failed",
        udid: null,
        runtimeReleased: true,
        deviceCleanupComplete: true,
        cleanupComplete: true,
      });
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
      clock = Math.min(clock + 15_000, 105_000); // admission expires; subsequent cleanup has its own stable clock budget
      return clock;
    };
    await executeNativeUi(
      expired.w.ctx,
      expired.r,
      await expired.newRequest(),
      await reconcile(expired.w.ctx),
    );
    expect(expired.calls.filter((c) => c.kind !== "release")).toEqual([]);
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
      runtimeBinding: f.binding,
    });
    expect(f.acquired).toEqual([
      { requestId: i.id, worktreeId: required(f.r.worktree).id, profileHash: f.binding.profileHash },
    ]);
    expect(new Set(f.bindingCalls.map((c) => c.kind))).toEqual(
      new Set(["resolve", "simctl", "emulator", "bundleId", "observe", "capture", "cleanup", "release"]),
    );
    expect(f.bindingCalls.every((c) => JSON.stringify(c.binding) === JSON.stringify(f.binding))).toBe(true);
    expect(JSON.parse(readFileSync(join(f.wt, ".wingmate/native-ui.json"), "utf8"))[0]).not.toHaveProperty(
      "runtimeBinding",
    );
    const receipt = JSON.parse(readFileSync(join(nativeJobDir(f.w.ctx, f.r, i.id), "receipt.json"), "utf8"));
    expect(receipt.runtimeBindingHash).toBe(runtimeBindingHash(f.binding));
    expect(JSON.stringify(receipt)).not.toContain(f.binding.id);
    expect(f.calls.at(-2)).toEqual({ kind: "cleanup", args: [UDID, required(f.r.worktree).id] });
    expect(f.calls.at(-1)?.kind).toBe("release");
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
    expect(f.calls.filter((c) => c.kind !== "release")).toEqual([]);
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
    expect(wrong.calls.at(-2)?.kind).toBe("cleanup");
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
    const job = await interrupt(f);
    job.receiptHash = null;
    await saveRecord(f.w.ctx, f.r);
    f.port.cleanup = async () => [];
    const creates = f.calls.filter((c) => c.args[0] === "create").length;
    await executeNativeUi(f.w.ctx, f.r, i, await reconcile(f.w.ctx));
    expect(f.calls.filter((c) => c.args[0] === "create")).toHaveLength(creates);
    expect(f.r.nativeUiJobs[0]?.status as string).toBe("failed");
  });
  test("connection/profile changes during execution retain the original lease for every operation and cleanup", async () => {
    const f = await setup();
    await f.admit();
    const i = await f.newRequest();
    const simctl = f.port.simctl;
    f.port.simctl = async (...args) => {
      if (args[1][0] === "boot") {
        // A newly selected adapter connection can offer B, but this protected request remains owned by A.
        f.port.acquire = async () => ({ ...f.binding, id: "current-lease-B", profileHash: "c".repeat(64) });
        required(f.repo.ui.native).executionIsolationHash = "c".repeat(64);
      }
      return simctl(...args);
    };
    await executeNativeUi(f.w.ctx, f.r, i, await reconcile(f.w.ctx));
    expect(f.r.nativeUiJobs[0]).toMatchObject({
      status: "failed",
      runtimeBinding: f.binding,
      cleanupComplete: true,
    });
    expect(f.bindingCalls.every((c) => c.binding.id === f.binding.id)).toBe(true);
    expect(f.acquired).toHaveLength(1);
    expect(f.calls.at(-1)?.kind).toBe("release");
    await expect(verifyNativeUiGate(f.w.ctx, f.r, "PASS", i.id, f.head)).rejects.toThrow(
      "protected successful",
    );
  });
  test("a wrong bundle before device creation still releases the exact acquired runtime lease", async () => {
    const f = await setup();
    await f.admit();
    f.port.bundleId = async (binding) => {
      expect(binding).toEqual(f.binding);
      return "other.app";
    };
    await executeNativeUi(f.w.ctx, f.r, await f.newRequest(), await reconcile(f.w.ctx));
    expect(f.calls).toEqual([{ kind: "release", args: [] }]);
    expect(f.r.nativeUiJobs[0]).toMatchObject({
      status: "failed",
      runtimeBinding: f.binding,
      runtimeReleased: true,
      udid: null,
      cleanupComplete: true,
    });
  });
  test("interruption during acquisition uses read-only request lookup and releases a recovered lease before settling", async () => {
    for (const reserved of [false, true]) {
      const f = await setup();
      await f.admit();
      const i = await f.newRequest();
      const acquire = f.port.acquire;
      const abort = new TickAbort("stopped", "stop_requested");
      f.port.acquire = async (...args) => {
        if (reserved) await acquire(...args);
        throw abort;
      };
      const lookup = f.port.lookup;
      const lookedUp: Parameters<NativeUiPort["lookup"]>[0][] = [];
      f.port.lookup = async (request, timeoutMs) => {
        expect((await readRecord(f.w.dirs, ID))?.nativeUiJobs[0]?.runtimeAcquireUncertain).toBe(true);
        expect(timeoutMs).toBe(5_000);
        lookedUp.push(request);
        return lookup(request, timeoutMs);
      };
      await expect(executeNativeUi(f.w.ctx, f.r, i, await reconcile(f.w.ctx))).rejects.toBe(abort);
      expect(lookedUp).toEqual([
        { requestId: i.id, worktreeId: required(f.r.worktree).id, profileHash: f.binding.profileHash },
      ]);
      expect(f.calls).toEqual(reserved ? [{ kind: "release", args: [] }] : []);
      expect(f.r.nativeUiJobs[0]).toMatchObject({
        status: "failed",
        udid: null,
        runtimeAcquireUncertain: false,
        runtimeReleased: true,
        cleanupComplete: true,
      });
      expect(f.acquired).toHaveLength(reserved ? 1 : 0);
    }
  });
  test("an unavailable acquisition lookup stays uncertain until the original request can be recovered after restart", async () => {
    const f = await setup();
    await f.admit();
    const i = await f.newRequest();
    const acquire = f.port.acquire;
    const lookup = f.port.lookup;
    f.port.acquire = async (...args) => {
      await acquire(...args);
      throw new Error("connection lost after reserving runtime");
    };
    f.port.lookup = async () => null;
    await executeNativeUi(f.w.ctx, f.r, i, await reconcile(f.w.ctx));
    expect(f.calls).toEqual([]);
    expect(f.r.nativeUiJobs[0]).toMatchObject({
      status: "unverifiable",
      runtimeBinding: null,
      runtimeAcquireUncertain: true,
      runtimeReleased: false,
      cleanupComplete: false,
    });
    const restarted = required(await readRecord(f.w.dirs, ID));
    required(f.repo.ui.native).executionIsolationHash = "c".repeat(64);
    f.port.acquire = async () => {
      throw new Error("must not acquire replacement");
    };
    f.port.lookup = lookup;
    expect(await recoverNativeUi(f.w.ctx, restarted, true)).toEqual([]);
    expect(f.calls).toEqual([{ kind: "release", args: [] }]);
    expect(restarted.nativeUiJobs[0]).toMatchObject({
      status: "failed",
      runtimeBinding: f.binding,
      runtimeAcquireUncertain: false,
      runtimeReleased: true,
      cleanupComplete: true,
    });
    expect(f.acquired).toHaveLength(1);
  });
  test("a mismatched acquisition lookup cannot settle uncertainty or release another request's runtime", async () => {
    for (const mode of ["request", "worktree", "profile", "absent-request"]) {
      const f = await setup();
      await f.admit();
      const i = await f.newRequest();
      const acquire = f.port.acquire;
      f.port.acquire = async (...args) => {
        await acquire(...args);
        throw new Error("lost acquire result");
      };
      f.port.lookup = async (request) => {
        if (mode === "absent-request")
          return { status: "absent", request: { ...request, requestId: "other" } };
        return {
          status: "bound",
          request: {
            ...request,
            ...(mode === "request"
              ? { requestId: "other" }
              : mode === "worktree"
                ? { worktreeId: "other" }
                : {}),
          },
          binding: { ...f.binding, ...(mode === "profile" ? { profileHash: "c".repeat(64) } : {}) },
        };
      };
      await executeNativeUi(f.w.ctx, f.r, i, await reconcile(f.w.ctx));
      expect(f.calls).toEqual([]);
      expect(f.r.nativeUiJobs[0]).toMatchObject({
        status: "unverifiable",
        runtimeAcquireUncertain: true,
        runtimeBinding: null,
        runtimeReleased: false,
        cleanupComplete: false,
      });
    }
  });
  test("lookup cannot mutate its saved request context to authorize another lease", async () => {
    const f = await setup();
    await f.admit();
    const acquire = f.port.acquire;
    f.port.acquire = async (...args) => {
      await acquire(...args);
      throw new Error("lost acquire result");
    };
    f.port.lookup = async (request) => {
      expect(Object.isFrozen(request)).toBe(true);
      expect(Reflect.set(request, "requestId", "other")).toBe(false);
      return {
        status: "bound",
        request: { ...request, requestId: "other" },
        binding: { ...f.binding, id: "other-lease" },
      };
    };
    await executeNativeUi(f.w.ctx, f.r, await f.newRequest(), await reconcile(f.w.ctx));
    expect(f.calls).toEqual([]);
    expect(f.r.nativeUiJobs[0]).toMatchObject({
      status: "unverifiable",
      runtimeBinding: null,
      runtimeAcquireUncertain: true,
      cleanupComplete: false,
    });
  });
  test("failed pre-device resolution cannot settle when exact lease release is also unavailable", async () => {
    const f = await setup();
    await f.admit();
    f.port.resolve = async () => null;
    const release = f.port.release;
    f.port.release = async () => ["expired lease cannot be verified or released"];
    const i = await f.newRequest();
    await executeNativeUi(f.w.ctx, f.r, i, await reconcile(f.w.ctx));
    expect(f.calls).toEqual([]);
    expect(f.r.nativeUiJobs[0]).toMatchObject({
      status: "unverifiable",
      udid: null,
      deviceCleanupComplete: true,
      runtimeReleased: false,
      cleanupComplete: false,
    });
    f.port.release = release;
    f.port.acquire = async () => {
      throw new Error("must not acquire replacement");
    };
    expect(await recoverNativeUi(f.w.ctx, f.r)).toEqual([]);
    expect(f.calls).toEqual([{ kind: "release", args: [] }]);
    expect(f.r.nativeUiJobs[0]).toMatchObject({
      status: "failed",
      runtimeReleased: true,
      cleanupComplete: true,
    });
  });
  test("a release interrupted after verified device cleanup retries only the exact idempotent lease settlement", async () => {
    const f = await setup();
    await f.admit();
    const release = f.port.release;
    f.port.release = async (...args) => {
      await release(...args);
      throw new Error("release acknowledgement lost");
    };
    const i = await f.newRequest();
    await executeNativeUi(f.w.ctx, f.r, i, await reconcile(f.w.ctx));
    expect(f.r.nativeUiJobs[0]).toMatchObject({
      status: "unverifiable",
      deviceCleanupComplete: true,
      runtimeReleased: false,
      cleanupComplete: false,
    });
    expect(f.runtimeState.released).toBe(true);
    const restarted = required(await readRecord(f.w.dirs, ID));
    const count = f.calls.length;
    f.port.release = release; // broker retains a verified released tombstone for this exact binding
    f.port.resolve = async () => null;
    f.port.acquire = async () => {
      throw new Error("must not acquire replacement");
    };
    expect(await recoverNativeUi(f.w.ctx, restarted)).toEqual([]);
    expect(f.calls.slice(count)).toEqual([{ kind: "release", args: [] }]);
    expect(restarted.nativeUiJobs[0]).toMatchObject({
      status: "failed",
      runtimeReleased: true,
      cleanupComplete: true,
    });
  });
  test("device subprocess grace plus lease operations fit the reserve; timed-out verification stays unresolved", async () => {
    for (const verified of [false, true]) {
      const f = await setup();
      await f.admit();
      await executeNativeUi(f.w.ctx, f.r, await f.newRequest(), await reconcile(f.w.ctx));
      await interrupt(f);
      const started = f.port.now();
      const resolve = f.port.resolve;
      const release = f.port.release;
      f.port.resolve = async (binding, timeoutMs) => {
        await f.port.pause(timeoutMs);
        return resolve(binding, timeoutMs);
      };
      const commands: { args: string[]; timeoutMs: number }[] = [];
      const simctl: Parameters<typeof cleanupOwnedDevice>[0] = async (args, timeoutMs) => {
        commands.push({ args, timeoutMs });
        const success = verified && args[0] === "list";
        await f.port.pause(success ? timeoutMs - 1 : timeoutMs + 2_000);
        return {
          code: success ? 0 : 124,
          stdout: JSON.stringify({ devices: {} }),
          stderr: "",
          timedOut: !success,
          truncated: false,
        };
      };
      const emulator: Parameters<typeof cleanupOwnedDevice>[1] = async (args, timeoutMs) => {
        commands.push({ args, timeoutMs });
        const success = verified && args[0] === "list";
        await f.port.pause(success ? timeoutMs - 1 : timeoutMs + 2_000);
        if (!success) throw new Error("helper timed out including full post-kill drain grace");
        return { running: false };
      };
      f.port.cleanup = async (binding, udid, wt, timeoutMs) => {
        expect(binding).toEqual(f.binding);
        expect(timeoutMs).toBe(NATIVE_DEVICE_CLEANUP_MS);
        return cleanupOwnedDevice(simctl, emulator, udid, wt, timeoutMs, f.port.now);
      };
      f.port.release = async (binding, timeoutMs) => {
        await f.port.pause(timeoutMs);
        return release(binding, timeoutMs);
      };
      expect(await recoverNativeUi(f.w.ctx, f.r)).toEqual(
        verified ? [] : [`native:${required(f.r.nativeUiJobs[0]).id}`],
      );
      expect(commands).toHaveLength(5);
      expect(commands.every((c) => c.timeoutMs === 3_000)).toBe(true);
      expect(f.port.now() - started).toBe(verified ? 30_998 : 30_000);
      expect(f.port.now() - started).toBeLessThan(NATIVE_CLEANUP_RESERVE_MS);
      expect(f.r.nativeUiJobs[0]).toMatchObject({
        status: verified ? "failed" : "unverifiable",
        runtimeReleased: verified,
        deviceCleanupComplete: verified,
        cleanupComplete: verified,
      });
    }
  });
  test("late cleanup or release acknowledgements stay unresolved instead of producing successful cleanup", async () => {
    for (const mode of ["resolve", "cleanup", "release"]) {
      const f = await setup();
      await f.admit();
      const i = await f.newRequest();
      await executeNativeUi(f.w.ctx, f.r, i, await reconcile(f.w.ctx));
      await interrupt(f);
      if (mode === "resolve")
        f.port.resolve = async (_binding, ms) => {
          await f.port.pause(ms + 1);
          return f.binding;
        };
      if (mode === "cleanup")
        f.port.cleanup = async (_binding, _udid, _wt, ms) => {
          await f.port.pause(ms + 1);
          return [];
        };
      if (mode === "release")
        f.port.release = async (_binding, ms) => {
          await f.port.pause(ms + 1);
          return [];
        };
      expect(await recoverNativeUi(f.w.ctx, f.r)).toEqual([`native:${i.id}`]);
      expect(f.r.nativeUiJobs[0]).toMatchObject({
        status: "unverifiable",
        runtimeReleased: false,
        cleanupComplete: false,
      });
      await expect(verifyNativeUiGate(f.w.ctx, f.r, "PASS", i.id, f.head)).rejects.toThrow(
        "protected successful",
      );
    }
  });
  test("capture transfer receives a byte limit; malformed, oversized or late bytes never become screenshot evidence", async () => {
    for (const mode of ["oversized", "not-png", "not-buffer", "late"]) {
      const f = await setup();
      await f.admit();
      const i = await f.newRequest();
      Reflect.set(
        f.port,
        "capture",
        async (binding: NativeRuntimeBinding, udid: string, wt: string, maxBytes: number) => {
          expect(binding).toEqual(f.binding);
          expect(udid).toBe(UDID);
          expect(wt).toBe(required(f.r.worktree).id);
          expect(maxBytes).toBe(NATIVE_CAPTURE_MAX_BYTES);
          if (mode === "late") {
            await f.port.pause(90_001);
            return PNG;
          }
          if (mode === "not-buffer") return new Uint8Array(PNG);
          if (mode === "not-png") return Buffer.from("not a PNG");
          return Buffer.concat([PNG, Buffer.alloc(maxBytes)]);
        },
      );
      await executeNativeUi(f.w.ctx, f.r, i, await reconcile(f.w.ctx));
      expect(f.r.nativeUiJobs[0]).toMatchObject({ status: "failed", cleanupComplete: true });
      expect(existsSync(join(nativeJobDir(f.w.ctx, f.r, i.id), "step-00.png"))).toBe(false);
      const receipt = JSON.parse(
        readFileSync(join(nativeJobDir(f.w.ctx, f.r, i.id), "receipt.json"), "utf8"),
      );
      expect(receipt.artifacts.some((a: { name: string }) => a.name.endsWith(".png"))).toBe(false);
      expect(f.calls.at(-1)?.kind).toBe("release");
    }
  });
  test("capture accepts the exact byte boundary and binds both foreground observations before protected storage", async () => {
    const f = await setup();
    await f.admit();
    const i = await f.newRequest();
    const bytes = Buffer.alloc(NATIVE_CAPTURE_MAX_BYTES);
    PNG.copy(bytes);
    let captured = false;
    f.port.capture = async (_binding, _udid, _wt, maxBytes) => {
      expect(maxBytes).toBe(bytes.length);
      if (captured) return PNG;
      captured = true;
      return bytes;
    };
    await executeNativeUi(f.w.ctx, f.r, i, await reconcile(f.w.ctx));
    expect(f.r.nativeUiJobs[0]?.status).toBe("succeeded");
    expect(readFileSync(join(nativeJobDir(f.w.ctx, f.r, i.id), "step-00.png"))).toEqual(bytes);
    const wrong = await setup();
    await wrong.admit();
    const request = await wrong.newRequest();
    wrong.port.capture = async () => {
      wrong.port.observe = async () => ({ bundleId: "other.app", pid: 123, snapshot: snapshot() });
      return PNG;
    };
    await executeNativeUi(wrong.w.ctx, wrong.r, request, await reconcile(wrong.w.ctx));
    expect(wrong.r.nativeUiJobs[0]?.status).toBe("failed");
    expect(existsSync(join(nativeJobDir(wrong.w.ctx, wrong.r, request.id), "step-00.png"))).toBe(false);
  });
  test("a stop abort during native action cleans only the allocated device, persists FAIL and propagates the abort", async () => {
    const f = await setup();
    await f.admit();
    const i = await f.newRequest();
    const simctl = f.port.simctl;
    const abort = new TickAbort("stopped", "stop_requested");
    f.port.simctl = async (...args) => {
      if (args[1][0] === "boot") throw abort;
      return simctl(...args);
    };
    await expect(executeNativeUi(f.w.ctx, f.r, i, await reconcile(f.w.ctx))).rejects.toBe(abort);
    expect(f.calls.at(-2)).toEqual({ kind: "cleanup", args: [UDID, required(f.r.worktree).id] });
    expect(f.calls.at(-1)?.kind).toBe("release");
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
    const job = await interrupt(f);
    f.r.stage = "awaiting-human";
    f.r.coordinator.attempt++;
    f.repo.ui.native = undefined;
    f.port.acquire = async () => {
      throw new Error("recovery must never acquire a replacement connection");
    };
    await saveRecord(f.w.ctx, f.r);
    const creates = f.calls.filter((c) => c.args[0] === "create").length;
    expect(await recoverNativeUi(f.w.ctx, f.r)).toEqual([]);
    expect(job.cleanupComplete).toBe(true);
    expect(job.status as string).toBe("failed");
    expect(f.calls.filter((c) => c.args[0] === "create")).toHaveLength(creates);
    await interrupt(f);
    expect((await stopAgents(f.w.ctx, f.r)).unverifiable).toEqual([]);
    expect(job.notified).toBe(true);
    expect(job.cleanupComplete).toBe(true);
  });
  test("restart recovery resolves the protected original lease despite a new current connection/profile", async () => {
    const f = await setup();
    await f.admit();
    const i = await f.newRequest();
    await executeNativeUi(f.w.ctx, f.r, i, await reconcile(f.w.ctx));
    await interrupt(f);
    const restarted = required(await readRecord(f.w.dirs, ID));
    required(f.repo.ui.native).executionIsolationHash = "c".repeat(64);
    let replacementAcquired = false;
    const cleanup = f.port.cleanup;
    const resolved: NativeRuntimeBinding[] = [];
    f.w.ctx.nativeUi = {
      ...f.port,
      acquire: async () => {
        replacementAcquired = true;
        return { ...f.binding, id: "new-current-connection-B", profileHash: "c".repeat(64) };
      },
      resolve: async (binding) => {
        resolved.push(binding);
        return { ...f.binding };
      },
      cleanup,
    };
    const count = f.calls.length;
    expect(await recoverNativeUi(f.w.ctx, restarted)).toEqual([]);
    expect(replacementAcquired).toBe(false);
    expect(resolved).toEqual([f.binding]);
    expect(f.calls.slice(count)).toEqual([
      { kind: "cleanup", args: [UDID, required(f.r.worktree).id] },
      { kind: "release", args: [] },
    ]);
    expect(restarted.nativeUiJobs[0]).toMatchObject({
      status: "failed",
      cleanupComplete: true,
      runtimeBinding: f.binding,
    });
    await expect(verifyNativeUiGate(f.w.ctx, restarted, "PASS", i.id, f.head)).rejects.toThrow(
      "protected successful",
    );
  });
  test("unavailable, expired, wrong or legacy missing leases preserve cleanup uncertainty without fallback or reacquisition", async () => {
    for (const mode of ["unavailable", "expired", "wrong-id", "wrong-profile", "wrong-version", "legacy"]) {
      const f = await setup();
      await f.admit();
      const i = await f.newRequest();
      await executeNativeUi(f.w.ctx, f.r, i, await reconcile(f.w.ctx));
      const job = await interrupt(f);
      if (mode === "legacy") {
        const { runtimeBinding: _binding, ...legacy } = job;
        f.r.nativeUiJobs[0] = NativeJobSchema.parse(legacy);
        expect(f.r.nativeUiJobs[0]?.runtimeBinding).toBeNull();
      }
      await saveRecord(f.w.ctx, f.r);
      f.port.acquire = async () => {
        throw new Error("must not acquire replacement");
      };
      Reflect.set(f.port, "resolve", async (binding: NativeRuntimeBinding) => {
        expect(binding).toEqual(f.binding);
        if (mode === "expired") throw new Error("lease expired");
        if (mode === "wrong-id") return { ...binding, id: "substitute-lease" };
        if (mode === "wrong-profile") return { ...binding, profileHash: "c".repeat(64) };
        if (mode === "wrong-version") return { ...binding, version: 2 };
        return null;
      });
      const count = f.calls.length;
      expect(await recoverNativeUi(f.w.ctx, f.r, true)).toEqual([`native:${i.id}`]);
      expect(f.calls).toHaveLength(count);
      expect(f.acquired).toHaveLength(1);
      expect(f.r.nativeUiJobs[0]).toMatchObject({
        status: "unverifiable",
        cleanupComplete: false,
        udid: UDID,
      });
      expect(f.r.attention).toContain("native_ui_cleanup_required");
      await expect(verifyNativeUiGate(f.w.ctx, f.r, "PASS", i.id, f.head)).rejects.toThrow(
        "protected successful",
      );
    }
  });
  test("an uncertain allocation stays unresolved on its original lease and is never replayed", async () => {
    const f = await setup();
    await f.admit();
    const i = await f.newRequest();
    const simctl = f.port.simctl;
    f.port.simctl = async (...args) => {
      const result = await simctl(...args);
      return args[1][0] === "create" ? { ...result, stdout: "ambiguous allocation" } : result;
    };
    await executeNativeUi(f.w.ctx, f.r, i, await reconcile(f.w.ctx));
    expect(f.r.nativeUiJobs[0]).toMatchObject({
      status: "unverifiable",
      runtimeBinding: f.binding,
      udid: null,
      createUncertain: true,
      cleanupComplete: false,
    });
    const count = f.calls.length;
    expect(await recoverNativeUi(f.w.ctx, f.r)).toEqual([`native:${i.id}`]);
    expect(f.calls).toHaveLength(count);
    expect(f.acquired).toHaveLength(1);
  });
  test("stop guards acquisition and capture while exact-owned resolution and cleanup remain available", async () => {
    const f = await setup();
    await f.admit();
    await executeNativeUi(f.w.ctx, f.r, await f.newRequest(), await reconcile(f.w.ctx));
    await interrupt(f);
    const checked: string[] = [];
    const guarded = required(
      guardedCtx(f.w.ctx, async (verb) => {
        checked.push(verb);
        throw new TickAbort("stopped", "stop_requested");
      }).nativeUi,
    );
    for (const action of [
      () =>
        guarded.acquire(
          { requestId: "test", worktreeId: "fixture", profileHash: f.binding.profileHash },
          100,
        ),
      () => guarded.simctl(f.binding, ["create"], 100),
      () => guarded.emulator(f.binding, ["tap", "0.5", "0.5"], 100),
      () => guarded.capture(f.binding, UDID, "fixture", NATIVE_CAPTURE_MAX_BYTES, 100),
    ])
      await expect(action()).rejects.toThrow("stop_requested");
    expect(checked).toEqual(["acquire", "simctl", "emulator", "capture"]);
    expect(await guarded.resolve(f.binding, 100)).toEqual(f.binding);
    expect(
      await guarded.cleanup(f.binding, UDID, required(f.r.worktree).id, NATIVE_DEVICE_CLEANUP_MS),
    ).toEqual([]);
    expect(
      await guarded.lookup(
        { requestId: "test", worktreeId: "fixture", profileHash: f.binding.profileHash },
        100,
      ),
    ).not.toBeNull();
    required(f.r.nativeUiJobs[0]).deviceCleanupComplete = true;
    await saveRecord(f.w.ctx, f.r);
    expect(await guarded.release(f.binding, 5_000)).toEqual([]);
    expect(checked).toHaveLength(4);
  });
  for (const stage of ["input_accepted", "turn_started"] as const) {
    test(`a ${stage} native-result resume defers the owner note to a fresh tick`, async () => {
      const f = await setup();
      await f.admit();
      const i = await f.newRequest();
      await executeNativeUi(f.w.ctx, f.r, i, await reconcile(f.w.ctx));
      await consumeIntent(f.wt, i.id);
      const cursor = f.r.linear.lastSeenCommentAt;
      f.w.clock.advance(60_000);
      const note = f.w.linear.humanComment(
        "i1",
        "Keep the native fixture scope bounded.",
        OWNER,
        f.w.ctx.now(),
      );
      f.w.orca.nextSendStage = stage;
      const before = f.w.orca.calls.length;
      let resumed = false;
      f.w.orca.onCall = (verb) => {
        if (verb === "terminalSend") resumed = true;
        if (verb === "terminalWait" && resumed)
          throw new OrcaError("timeout", "a second wait used stale idle liveness after native notification");
      };
      expect((await runTick(f.w)).resumes).toEqual([ID]);
      let saved = required(await readRecord(f.w.dirs, ID));
      expect(saved.nativeUiJobs[0]).toMatchObject({ id: i.id, status: "succeeded", notified: true });
      expect(saved.linear.lastSeenCommentAt).toBe(cursor);
      expect(JSON.parse(readFileSync(join(f.wt, ".wingmate/native-ui.json"), "utf8"))[0].notified).toBe(true);
      expect(f.w.orca.calls.slice(before).filter((c) => c.verb === "terminalWait")).toHaveLength(1);
      expect(f.w.orca.calls.slice(before).filter((c) => c.verb === "terminalSend")).toHaveLength(1);
      f.w.orca.onCall = null;
      f.w.orca.setAgentState(
        required(saved.worktree).id,
        required(saved.coordinator.paneKey),
        "done",
        f.w.ctx.now(),
      );
      f.w.clock.advance(60_000);
      expect((await runTick(f.w)).resumes).toEqual([ID]);
      saved = required(await readRecord(f.w.dirs, ID));
      expect(saved.linear.lastSeenCommentAt).toBe(note.createdAt);
      expect(saved.nativeUiJobs[0]?.notified).toBe(true);
      expect(f.w.orca.calls.slice(before).filter((c) => c.verb === "terminalSend")).toHaveLength(2);
      f.w.clock.advance(60_000);
      expect((await runTick(f.w)).resumes).toEqual([]);
      expect(f.w.orca.calls.slice(before).filter((c) => c.verb === "terminalSend")).toHaveLength(2);
      rmSync(f.w.root, { recursive: true, force: true });
    });
  }
  for (const unavailable of ["deferred", "unsafe"] as const) {
    test(`a ${unavailable} native-result notification retries only after an actual accepted send`, async () => {
      const f = await setup();
      await f.admit();
      const i = await f.newRequest();
      await executeNativeUi(f.w.ctx, f.r, i, await reconcile(f.w.ctx));
      await consumeIntent(f.wt, i.id);
      const before = f.w.orca.calls.length;
      const inbox = join(f.wt, ".wingmate/inbox");
      const outside = join(f.w.root, "unrelated-inbox");
      if (unavailable === "deferred") f.w.orca.nextWaitSatisfied = false;
      else {
        mkdirSync(outside);
        rmSync(inbox, { recursive: true, force: true });
        symlinkSync(outside, inbox);
      }
      f.w.clock.advance(60_000);
      expect((await runTick(f.w)).resumes).toEqual([]);
      expect(required(await readRecord(f.w.dirs, ID)).nativeUiJobs[0]?.notified).toBe(false);
      expect(f.w.orca.calls.slice(before).filter((c) => c.verb === "terminalSend")).toHaveLength(0);
      expect(
        (await f.w.ctx.ledger.readIssue(ID)).filter((e) => e.type === "delivered" && e.data.kind === "note"),
      ).toHaveLength(0);
      if (unavailable === "deferred") f.w.orca.nextWaitSatisfied = true;
      else rmSync(inbox);
      f.w.orca.nextSendStage = "input_accepted";
      f.w.clock.advance(60_000);
      expect((await runTick(f.w)).resumes).toEqual([ID]);
      expect(required(await readRecord(f.w.dirs, ID)).nativeUiJobs[0]?.notified).toBe(true);
      expect(f.w.orca.calls.slice(before).filter((c) => c.verb === "terminalSend")).toHaveLength(1);
      f.w.clock.advance(60_000);
      expect((await runTick(f.w)).resumes).toEqual([]);
      expect(f.w.orca.calls.slice(before).filter((c) => c.verb === "terminalSend")).toHaveLength(1);
      rmSync(f.w.root, { recursive: true, force: true });
    });
  }
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
    const simctl: Parameters<typeof cleanupOwnedDevice>[0] = async (args) => {
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
    const emulator: Parameters<typeof cleanupOwnedDevice>[1] = async (args) => {
      calls.push(args);
      if (args[0] === "kill") throw new Error("already gone");
      return { running: false };
    };
    expect(await cleanupOwnedDevice(simctl, emulator, UDID, "repo::/own-wt")).toEqual([]);
    for (const args of calls.filter((a) => ["shutdown", "delete", "kill"].includes(required(a[0]))))
      expect(args).toContain(UDID);
    expect(calls.some((a) => a.includes("booted") || a.includes("all"))).toBe(false);
    const unavailable: Parameters<typeof cleanupOwnedDevice>[0] = async () => {
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
