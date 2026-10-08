// Trusted native iOS relay. Agents submit data; only this dispatcher path controls a freshly allocated Simulator.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { gitTarget } from "../git/trust";
import type { Intent } from "../kit/intents";
import { readNoFollow, worktreeDir, writeInWorktree } from "../kit/local";
import { verifiedArtifact } from "../native/artifact";
import type { NativeUiPort } from "../native/host";
import {
  NATIVE_CAPTURE_MAX_BYTES,
  NATIVE_CLEANUP_RESERVE_MS,
  NATIVE_DELIVERY_RESERVE_MS,
  NATIVE_DEVICE_CLEANUP_MS,
  NATIVE_LEASE_CLEANUP_MS,
  type NativeJob,
  type NativeReceipt,
  NativeReceiptSchema,
  type NativeRuntimeBinding,
  NativeRuntimeBindingSchema,
  NativeRuntimeLookupSchema,
  NativeRuntimeRequestSchema,
  hash,
  nativeJobViews,
  policyHash,
  recipeHash,
  runtimeBindingHash,
  sameRuntimeBinding,
} from "../native/protocol";
import { WingmateError, errorText } from "../shared/errors";
import { writeAtomic } from "../state/fs";
import type { WRecord } from "../state/records";
import { rolePending } from "../state/roles";
import { type Ctx, remainingMs } from "./context";
import { isTickAbort } from "./guard";
import { prepareLaunch } from "./launch";
import type { Reconciled } from "./reconcile";
import { saveRecord } from "./save";
import { addAttention } from "./states";

export async function mirrorNativeJobs(r: WRecord): Promise<void> {
  if (!r.worktree) return;
  const wm = await worktreeDir(r.worktree.path, ".wingmate");
  await writeInWorktree(wm, "native-ui.json", JSON.stringify(nativeJobViews(r.nativeUiJobs), null, 2));
}

type NativeIntent = Extract<Intent, { kind: "native-ui" }>;
const RECEIPT_MAX = 512 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const nativeJobDir = (ctx: Ctx, r: WRecord, id: string) =>
  join(
    ctx.dirs.evidence,
    r.identifier,
    String(r.nativeUiJobs.find((j) => j.id === id)?.cycle ?? r.cycle),
    "native-ui",
    id,
  );
const policyOf = (ctx: Ctx, r: WRecord) => ctx.cfg.projects[r.project]?.repos[r.repo]?.ui.native;
const refused = (code: string, text: string) => new WingmateError(code, text);
const runtimeRequest = (job: NativeJob) =>
  NativeRuntimeRequestSchema.parse({
    requestId: job.id,
    worktreeId: job.worktreeId,
    profileHash: job.executionIsolationHash,
  });

async function resolveRuntime(native: NativeUiPort, binding: NativeRuntimeBinding, timeoutMs: number) {
  const resolved = NativeRuntimeBindingSchema.safeParse(await native.resolve(binding, timeoutMs));
  if (!resolved.success || !sameRuntimeBinding(resolved.data, binding))
    throw refused(
      "native_runtime_lease_unavailable",
      "the recorded native runtime lease is unavailable, expired or mismatched; no replacement runtime is selected",
    );
}

async function cleanupJob(ctx: Ctx, r: WRecord, job: NativeJob): Promise<string[]> {
  const native = ctx.nativeUi;
  if (!native) return ["native runtime cleanup is unavailable"];
  const deadline = native.now() + NATIVE_CLEANUP_RESERVE_MS;
  const bounded = async <T>(cap: number, action: (timeoutMs: number) => Promise<T>): Promise<T> => {
    const started = native.now();
    const budget = Math.min(cap, deadline - started);
    if (budget <= 0) throw new Error("native cleanup deadline exceeded");
    const result = await action(budget);
    if (native.now() > deadline || native.now() - started > budget)
      throw new Error("native cleanup response exceeded its total wall budget");
    return result;
  };
  try {
    if (job.runtimeAcquireUncertain) {
      const request = runtimeRequest(job);
      const found = NativeRuntimeLookupSchema.safeParse(
        await bounded(NATIVE_LEASE_CLEANUP_MS, (ms) => native.lookup(request, ms)),
      );
      if (
        !found.success ||
        found.data.request.requestId !== job.id ||
        found.data.request.worktreeId !== job.worktreeId ||
        found.data.request.profileHash !== job.executionIsolationHash ||
        (found.data.status === "bound" && found.data.binding.profileHash !== job.executionIsolationHash)
      )
        return ["native runtime acquisition is uncertain; exact request lookup requires owner action"];
      job.runtimeBinding = found.data.status === "bound" ? found.data.binding : null;
      job.runtimeReleased = found.data.status === "absent";
      job.runtimeAcquireUncertain = false;
      await saveRecord(ctx, r); // recovered routing is protected before any cleanup/release transport
    }
    if (!job.deviceCleanupComplete) {
      if (job.createUncertain && !job.udid)
        return ["native device allocation remains uncertain; owner investigation is required"];
      if (job.udid) {
        if (!job.runtimeBinding || job.runtimeBinding.profileHash !== job.executionIsolationHash)
          return ["native runtime lease is missing; exact runtime cleanup requires owner action"];
        const binding = job.runtimeBinding;
        const udid = job.udid;
        await bounded(NATIVE_LEASE_CLEANUP_MS, (ms) => resolveRuntime(native, binding, ms));
        const errors = await bounded(NATIVE_DEVICE_CLEANUP_MS, (ms) =>
          native.cleanup(binding, udid, job.worktreeId, ms),
        );
        if (errors.length) return errors;
      }
      job.deviceCleanupComplete = true;
      await saveRecord(ctx, r); // a release retry must not require an already-deleted runtime's device transport
    }
    if (!job.runtimeReleased) {
      if (!job.runtimeBinding || job.runtimeBinding.profileHash !== job.executionIsolationHash)
        return ["native runtime lease is missing; exact lease release requires owner action"];
      // release resolves its own exact binding and is idempotent for a verified released tombstone only.
      // A generic unavailable/expired lease cannot be treated as verified absence.
      const binding = job.runtimeBinding;
      const errors = await bounded(NATIVE_LEASE_CLEANUP_MS, (ms) => native.release(binding, ms));
      if (errors.length) return errors;
      job.runtimeReleased = true;
      await saveRecord(ctx, r);
    }
    if (native.now() > deadline) return ["native cleanup exceeded its shared deadline during state progress"];
    return [];
  } catch {
    return ["recorded native runtime lease cleanup is unavailable or unverified"];
  }
}

// Contract from Orca emulator skill and serve-sim AxSnapshot: bounded elements, normalized visible frames, exact labels/values.
// An unknown/raw-pixel schema fails closed; no coordinate inference and no arbitrary raw emulator passthrough.
const Frame = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
});
const Ax = z.object({
  screen: z.object({ width: z.number().positive(), height: z.number().positive() }),
  elements: z
    .array(
      z.object({ id: z.string(), label: z.string(), value: z.string(), enabled: z.boolean(), frame: Frame }),
    )
    .max(500),
  errors: z.array(z.string()).optional(),
});
export function nativeElement(raw: unknown, text: string, tap: boolean) {
  const ax = Ax.safeParse(raw);
  if (!ax.success || ax.data.errors?.length)
    throw refused(
      "native_ax_unavailable",
      "native accessibility snapshot is unavailable or has an unsupported shape",
    );
  const matches = ax.data.elements.filter(
    (e) =>
      (e.label === text || e.value === text) &&
      (!tap || e.enabled) &&
      e.frame.x + e.frame.width <= 1 &&
      e.frame.y + e.frame.height <= 1,
  );
  if (matches.length !== 1)
    throw refused(
      "native_assertion_failed",
      "native text must identify exactly one visible accessibility element",
    );
  const e = matches[0];
  if (!e) throw refused("native_assertion_failed", "native element absent");
  return { x: e.frame.x + e.frame.width / 2, y: e.frame.y + e.frame.height / 2 };
}

async function mirror(ctx: Ctx, r: WRecord, job: NativeJob, receipt: NativeReceipt) {
  if (!r.worktree) return;
  const dest = await worktreeDir(r.worktree.path, `.wingmate/evidence/native-ui/${job.id}`, true);
  for (const a of receipt.artifacts) {
    const bytes = await readNoFollow(join(nativeJobDir(ctx, r, job.id), a.name), 16 * 1024 * 1024 + 1);
    await writeInWorktree(dest, a.name, bytes);
  }
  await writeInWorktree(dest, "receipt.json", JSON.stringify(receipt, null, 2));
  const wm = await worktreeDir(r.worktree.path, ".wingmate");
  await writeInWorktree(wm, "native-ui.json", JSON.stringify(nativeJobViews(r.nativeUiJobs), null, 2));
}

async function requireCommittedHead(ctx: Ctx, r: WRecord, expected: string, pinnedHead?: string) {
  if (!r.worktree) throw refused("native_ui_context", "native UI requires a claimed worktree");
  const t = gitTarget(r.worktree);
  if (
    (pinnedHead ?? (await ctx.git.revParse(t, "HEAD"))) !== expected ||
    (await ctx.git.hasTrackedChanges(t))
  )
    throw refused(
      "native_ui_source_stale",
      "native UI requires committed source at the requested HEAD and a clean tracked worktree/index; commit changes and request a fresh smoke",
    );
}

/** Synchronous but bounded by policy and tick deadline. A crash is never replayed as a second create/install/launch. */
export async function executeNativeUi(
  ctx: Ctx,
  r: WRecord,
  intent: NativeIntent,
  rec: Reconciled,
): Promise<void> {
  const p = intent.payload;
  const repo = ctx.cfg.projects[r.project]?.repos[r.repo];
  const policy = policyOf(ctx, r);
  if (
    !r.worktree ||
    r.stage !== "working" ||
    r.roleMode !== "terminal-job" ||
    repo?.ui.kind !== "ios" ||
    !policy ||
    !ctx.nativeUi
  )
    throw refused(
      "native_ui_unconfigured",
      "native UI requires a configured dispatcher policy and working issue",
    );
  const native = ctx.nativeUi;
  const worktree = r.worktree;
  if (
    intent.issue !== r.identifier ||
    p.worktreeId !== r.worktree.id ||
    p.cycle !== r.cycle ||
    p.attempt !== r.coordinator.attempt ||
    p.policyHash !== policyHash(policy) ||
    intent.createdAt < r.claimedAt
  )
    throw refused(
      "native_ui_context",
      "native request belongs to another worktree, cycle, attempt or policy",
    );
  if (rec.partial || rec.liveness.get(r.identifier) !== "idle")
    throw refused("native_ui_deferred", "native UI waits for a complete fleet and idle coordinator");
  if (r.pipelineStage !== "ui")
    throw refused("stage_prerequisite", "native UI requires the validated UI pipeline stage");
  if (r.roleJobs.some(rolePending)) throw refused("roles_busy", "settle reviewer jobs before native UI");
  // Never begin a run which cannot leave time for cleanup and coordinator delivery in this tick.
  if (remainingMs(ctx) < policy.timeoutMs + NATIVE_CLEANUP_RESERVE_MS + NATIVE_DELIVERY_RESERVE_MS)
    throw refused("native_ui_deferred", "not enough tick time for bounded native UI and cleanup");
  const previous = r.nativeUiJobs.find((j) => j.id === intent.id);
  if (
    previous &&
    (previous.headSha !== p.headSha ||
      previous.recipeHash !== recipeHash(p.recipe) ||
      previous.policyHash !== p.policyHash)
  )
    throw refused("native_ui_context", "a request id cannot be reused with different inputs");
  if (previous && previous.status !== "running") {
    await mirror(ctx, r, previous, await protectedReceipt(ctx, r, previous));
    return;
  }
  if (
    !previous &&
    r.nativeUiJobs.some(
      (j) =>
        j.cycle === r.cycle && j.attempt === r.coordinator.attempt && (!j.notified || !j.cleanupComplete),
    )
  )
    throw refused("native_ui_conflict", "one native request may be outstanding per coordinator wave");
  if (!previous && r.nativeUiJobs.length >= 128)
    throw refused("native_ui_limit", "native request history is full; re-queue issue");
  const job: NativeJob = previous ?? {
    id: intent.id,
    issue: r.identifier,
    cycle: r.cycle,
    attempt: r.coordinator.attempt,
    worktreeId: r.worktree.id,
    headSha: p.headSha,
    policyHash: p.policyHash,
    executionIsolationHash: policy.executionIsolationHash,
    runtimeBinding: null,
    runtimeAcquireUncertain: false,
    runtimeReleased: true,
    deviceCleanupComplete: true,
    recipeHash: recipeHash(p.recipe),
    requestedAt: intent.createdAt,
    status: "running",
    udid: null,
    createUncertain: false,
    cleanupComplete: true,
    receiptHash: null,
    evidencePath: `.wingmate/evidence/native-ui/${intent.id}/receipt.json`,
    notified: false,
  };
  if (!previous) r.nativeUiJobs.push(job);
  await saveRecord(ctx, r);
  const dir = nativeJobDir(ctx, r, job.id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const startedAt = ctx.now();
  const deadline = native.now() + policy.timeoutMs;
  const timeout = () => {
    const left = Math.min(deadline - native.now(), remainingMs(ctx) - NATIVE_CLEANUP_RESERVE_MS);
    if (left <= 0) throw refused("native_ui_timeout", "native UI exceeded its bounded runtime");
    return Math.min(30_000, left);
  };
  const artifacts: NativeReceipt["artifacts"] = [];
  let appHash: string | null = null;
  let appPid: number | null = null;
  let error: string | null = null;
  let assertions = 0;
  let aborted: unknown;
  const record = async (name: string, data: string | Buffer) => {
    await writeFile(join(dir, name), data, { mode: 0o600 });
    artifacts.push({ name, hash: hash(data) });
  };
  const ownedBinding = () => {
    if (!job.runtimeBinding)
      throw refused("native_runtime_lease_unavailable", "native runtime ownership has not been journaled");
    return job.runtimeBinding;
  };
  const checked = async (args: string[], env?: Record<string, string>) => {
    const result = await native.simctl(ownedBinding(), args, timeout(), env);
    timeout();
    // stdout/stderr stay protected and are never treated as a verdict. Do not echo potentially sensitive app logs to Linear.
    await record(
      `command-${artifacts.length}.json`,
      JSON.stringify({
        argv: args,
        code: result.code,
        timedOut: result.timedOut,
        truncated: result.truncated,
      }),
    );
    if (result.code !== 0 || result.timedOut || result.truncated)
      throw refused("native_command_failed", `native ${args[0]} failed or timed out`);
    return result;
  };
  const ownedUdid = () => {
    if (!job.udid)
      throw refused("native_device_unverifiable", "native device ownership has not been journaled");
    return job.udid;
  };
  const scoped = (args: string[]) => [...args, "--device", ownedUdid(), "--worktree", `id:${worktree.id}`];
  const observation = async () => {
    const raw = await native.observe(ownedBinding(), ownedUdid(), worktree.id, timeout());
    timeout();
    if (!raw || raw.bundleId !== policy.bundleId || raw.pid !== appPid)
      throw refused(
        "native_foreground_unverified",
        "cannot prove the configured app/process owns the native observation",
      );
    return raw;
  };
  const poll = async (text?: string, tap = false) => {
    const until = Math.min(deadline, native.now() + 5_000);
    while (true) {
      try {
        const raw = await observation();
        const point = text ? nativeElement(raw.snapshot, text, tap) : null;
        return { raw, point };
      } catch (e) {
        if (
          !(e instanceof WingmateError) ||
          !["native_assertion_failed", "native_foreground_unverified"].includes(e.code) ||
          native.now() >= until
        )
          throw e;
        await native.pause(Math.min(250, Math.max(1, until - native.now())));
      }
    }
  };
  const screenshot = async (n: number) => {
    await observation();
    const name = `step-${String(n).padStart(2, "0")}.png`;
    const bytes = await native.capture(
      ownedBinding(),
      ownedUdid(),
      worktree.id,
      NATIVE_CAPTURE_MAX_BYTES,
      timeout(),
    );
    timeout();
    await observation();
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.length > NATIVE_CAPTURE_MAX_BYTES ||
      !bytes.subarray(0, 8).equals(PNG)
    )
      throw refused("native_screenshot_invalid", "native screenshot is absent, oversized or not PNG");
    await record(name, bytes);
  };
  try {
    if (previous)
      throw refused(
        "native_ui_interrupted",
        "a previous dispatcher was interrupted; its native run is not repeated and cannot prove PASS",
      );
    await requireCommittedHead(ctx, r, p.headSha);
    await prepareLaunch(ctx, r);
    job.runtimeAcquireUncertain = true;
    job.runtimeReleased = false;
    job.cleanupComplete = false;
    await saveRecord(ctx, r); // even an interrupted acquire can reserve a lease; lookup must use this exact request
    const acquired = await native.acquire(runtimeRequest(job), timeout());
    if (acquired === null) {
      job.runtimeAcquireUncertain = false;
      job.runtimeReleased = true; // null explicitly proves no resources were acquired for this request
      await saveRecord(ctx, r);
    }
    const binding = NativeRuntimeBindingSchema.safeParse(acquired);
    if (!binding.success || binding.data.profileHash !== policy.executionIsolationHash)
      throw refused(
        "native_execution_unavailable",
        "native app execution requires a trusted isolated runtime; shared-host CoreSimulator is unsupported",
      );
    job.runtimeBinding = binding.data;
    job.runtimeAcquireUncertain = false;
    await saveRecord(ctx, r); // persist the original runtime before any device allocation or transport
    await resolveRuntime(native, ownedBinding(), timeout());
    const artifact = await verifiedArtifact(ctx.dirs, repo.orcaRepo, job.headSha, policy, ctx.now(), () => {
      timeout();
    });
    appHash = artifact.appHash;
    if ((await native.bundleId(ownedBinding(), artifact.app, timeout())) !== policy.bundleId)
      throw refused("native_bundle_mismatch", "artifact bundle does not match the pinned native policy");
    await requireCommittedHead(ctx, r, job.headSha);
    job.createUncertain = true;
    job.deviceCleanupComplete = false;
    job.cleanupComplete = false;
    await saveRecord(ctx, r); // persist uncertainty before the only device allocation
    const made = await checked([
      "create",
      `wingmate-${r.identifier}-${r.cycle}-${job.id}`,
      policy.deviceType,
      policy.runtime,
    ]);
    const udid = z.string().uuid().safeParse(made.stdout.trim());
    if (!udid.success)
      throw refused(
        "native_device_unverifiable",
        "Simulator allocation did not return a device UDID; owner cleanup is required",
      );
    job.udid = udid.data;
    job.createUncertain = false;
    await saveRecord(ctx, r); // exact ownership before boot/install/helper launch
    await checked(["boot", job.udid]);
    await checked(["bootstatus", job.udid, "-b"]);
    await checked(["install", job.udid, artifact.app]);
    await native.emulator(
      ownedBinding(),
      ["attach", job.udid, "--worktree", `id:${r.worktree.id}`],
      timeout(),
    );
    const launched = await checked(
      ["launch", "--terminate-running-process", job.udid, policy.bundleId, ...policy.launchArgs],
      policy.testEnv,
    );
    const pidText = launched.stdout.trim();
    const prefix = `${policy.bundleId}: `;
    const pid = pidText.startsWith(prefix) ? Number(pidText.slice(prefix.length)) : Number.NaN;
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw refused("native_launch_unverified", "native launch did not return the configured app process id");
    appPid = pid;
    await poll();
    await screenshot(0);
    for (const [n, step] of p.recipe.steps.entries()) {
      if ("expectText" in step || "tapText" in step) {
        const { raw, point } = await poll(
          "expectText" in step ? step.expectText : step.tapText,
          "tapText" in step,
        );
        await record(`ax-${n + 1}.json`, JSON.stringify(raw));
        if ("tapText" in step && point)
          await native.emulator(ownedBinding(), scoped(["tap", String(point.x), String(point.y)]), timeout());
        else assertions++;
      }
      await screenshot(n + 1);
    }
    await requireCommittedHead(ctx, r, job.headSha);
    const currentPolicy = policyOf(ctx, r);
    if (!currentPolicy || job.policyHash !== policyHash(currentPolicy))
      throw refused("native_ui_context", "native configuration changed during smoke");
  } catch (e) {
    error = errorText(e).slice(0, 2000);
    if (isTickAbort(e)) aborted = e;
  } finally {
    const cleanup = await cleanupJob(ctx, r, job);
    job.cleanupComplete = cleanup.length === 0;
    if (cleanup.length) error = [error, ...cleanup].filter(Boolean).join("; ");
  }
  if (!job.cleanupComplete) addAttention(r, "native_ui_cleanup_required");
  const receipt: NativeReceipt = {
    version: 1,
    requestId: job.id,
    issue: r.identifier,
    cycle: r.cycle,
    attempt: r.coordinator.attempt,
    worktreeId: job.worktreeId,
    headSha: job.headSha,
    policyHash: job.policyHash,
    recipeHash: job.recipeHash,
    runtimeBindingHash: job.runtimeBinding ? runtimeBindingHash(job.runtimeBinding) : null,
    appHash,
    appPid,
    udid: job.udid,
    verdict: error || !job.cleanupComplete || assertions === 0 ? "FAIL" : "PASS",
    startedAt,
    completedAt: ctx.now(),
    assertions,
    error,
    cleanupComplete: job.cleanupComplete,
    artifacts,
  };
  const bytes = JSON.stringify(receipt, null, 2);
  await writeAtomic(join(dir, "receipt.json"), bytes, 0o600);
  job.receiptHash = hash(bytes);
  job.status = !job.cleanupComplete ? "unverifiable" : receipt.verdict === "PASS" ? "succeeded" : "failed";
  await saveRecord(ctx, r); // protected result precedes its advisory mirror and pointer
  await mirror(ctx, r, job, receipt);
  await ctx.ledger.append({
    at: ctx.now(),
    issue: r.identifier,
    type: "native_ui_settled",
    data: {
      requestId: job.id,
      verdict: receipt.verdict,
      headSha: job.headSha,
      cleanupComplete: job.cleanupComplete,
    },
  });
  if (aborted) throw aborted;
}

async function protectedReceipt(ctx: Ctx, r: WRecord, job: NativeJob): Promise<NativeReceipt> {
  try {
    const dir = nativeJobDir(ctx, r, job.id);
    const bytes = await readNoFollow(join(dir, "receipt.json"), RECEIPT_MAX + 1);
    if (bytes.length > RECEIPT_MAX || !job.receiptHash || hash(bytes) !== job.receiptHash)
      throw new Error("receipt hash");
    const receipt = NativeReceiptSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (
      receipt.requestId !== job.id ||
      receipt.issue !== job.issue ||
      receipt.cycle !== job.cycle ||
      receipt.attempt !== job.attempt ||
      receipt.worktreeId !== job.worktreeId ||
      receipt.headSha !== job.headSha ||
      receipt.policyHash !== job.policyHash ||
      receipt.recipeHash !== job.recipeHash ||
      receipt.runtimeBindingHash !== (job.runtimeBinding ? runtimeBindingHash(job.runtimeBinding) : null) ||
      receipt.udid !== job.udid
    )
      throw new Error("receipt context");
    for (const a of receipt.artifacts) {
      const data = await readNoFollow(join(dir, a.name), 16 * 1024 * 1024 + 1);
      if (data.length > 16 * 1024 * 1024 || hash(data) !== a.hash) throw new Error("evidence hash");
    }
    return receipt;
  } catch {
    throw refused(
      "native_ui_evidence_tampered",
      "protected native receipt/evidence is missing or changed; request a fresh smoke",
    );
  }
}

/** Both gate acceptance and publish check the protected receipt, never a coordinator-written PASS/report. */
export async function verifyNativeUiGate(
  ctx: Ctx,
  r: WRecord,
  verdict: string,
  requestId: string | null,
  head: string | null,
  /** Dispatcher publish already captured this exact commit and diff; gate intents never supply this snapshot. */
  published?: { head: string; changedPaths: string[] },
): Promise<void> {
  const repo = ctx.cfg.projects[r.project]?.repos[r.repo];
  if (repo?.ui.kind !== "ios" || !r.worktree) return;
  const current = published?.head ?? (await ctx.git.revParse(gitTarget(r.worktree), "HEAD"));
  if (!head || current !== head)
    throw refused("native_ui_source_stale", "native UI gate must name current HEAD");
  if (verdict === "NA") {
    const paths =
      published?.changedPaths ??
      (await ctx.git.changedPaths(gitTarget(r.worktree), r.worktree.baseSha, current));
    if (paths.some((p) => repo.ui.paths.some((prefix) => p.startsWith(prefix))))
      throw refused("ui_changed", "native UI paths changed; NA is unavailable");
    return;
  }
  if (verdict !== "PASS") return;
  const policy = policyOf(ctx, r);
  const worktreeId = r.worktree.id;
  const job = r.nativeUiJobs.find(
    (j) =>
      j.id === requestId &&
      j.cycle === r.cycle &&
      j.attempt === r.coordinator.attempt &&
      j.worktreeId === worktreeId,
  );
  if (
    !policy ||
    !job ||
    job.status !== "succeeded" ||
    !job.receiptHash ||
    !job.runtimeBinding ||
    job.runtimeBinding.profileHash !== policy.executionIsolationHash ||
    !job.cleanupComplete ||
    !job.deviceCleanupComplete ||
    !job.runtimeReleased ||
    job.runtimeAcquireUncertain ||
    job.createUncertain ||
    job.headSha !== current ||
    job.policyHash !== policyHash(policy)
  )
    throw refused(
      "native_ui_proof_required",
      "native UI requires a protected successful receipt at this HEAD, configuration and attempt",
    );
  await requireCommittedHead(ctx, r, current, published?.head);
  const receipt = await protectedReceipt(ctx, r, job);
  if (
    !receipt.appHash ||
    !receipt.appPid ||
    receipt.verdict !== "PASS" ||
    receipt.assertions < 1 ||
    !receipt.cleanupComplete ||
    !receipt.artifacts.some((a) => a.name.endsWith(".png"))
  )
    throw refused(
      "native_ui_proof_required",
      "protected native receipt does not prove app-specific successful UI",
    );
}

/** Recovery and stop cleanup use protected ownership across stage/attempt/config changes; never replay native execution. */
export async function recoverNativeUi(ctx: Ctx, r: WRecord, stopping = false): Promise<string[]> {
  const unresolved: string[] = [];
  for (const job of r.nativeUiJobs) {
    if (job.status !== "running" && job.cleanupComplete) continue;
    const errors = await cleanupJob(ctx, r, job);
    job.cleanupComplete = errors.length === 0;
    if (!job.cleanupComplete) {
      unresolved.push(`native:${job.id}`);
      addAttention(r, "native_ui_cleanup_required");
    }
    job.status = job.cleanupComplete ? "failed" : "unverifiable";
    if (stopping) job.notified = true;
    const receipt: NativeReceipt = {
      version: 1,
      requestId: job.id,
      issue: job.issue,
      cycle: job.cycle,
      attempt: job.attempt,
      worktreeId: job.worktreeId,
      headSha: job.headSha,
      policyHash: job.policyHash,
      recipeHash: job.recipeHash,
      runtimeBindingHash: job.runtimeBinding ? runtimeBindingHash(job.runtimeBinding) : null,
      appHash: null,
      appPid: null,
      udid: job.udid,
      verdict: "FAIL",
      startedAt: job.requestedAt,
      completedAt: ctx.now(),
      assertions: 0,
      error:
        "Interrupted/stopped native execution is never replayed or accepted as PASS; unresolved allocation/cleanup requires owner action.",
      cleanupComplete: job.cleanupComplete,
      artifacts: [],
    };
    const text = JSON.stringify(receipt, null, 2);
    await writeAtomic(join(nativeJobDir(ctx, r, job.id), "receipt.json"), text, 0o600);
    job.receiptHash = hash(text);
    await saveRecord(ctx, r);
    if (r.worktree) await mirror(ctx, r, job, receipt).catch(() => undefined);
  }
  return unresolved;
}
