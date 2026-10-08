// Native runtime contract. The credentialed host deliberately provides no executable runtime or fallback transports.
import type { RunResult } from "../shared/exec";
import type { NativeRuntimeBinding, NativeRuntimeLookup, NativeRuntimeRequest } from "./protocol";
import { NATIVE_DEVICE_CLEANUP_MS } from "./protocol";

type Simctl = (args: string[], timeoutMs: number, childEnv?: Record<string, string>) => Promise<RunResult>;
type Emulator = (args: string[], timeoutMs: number) => Promise<unknown>;

export interface NativeUiPort {
  // Every timeout is a total wall budget including cancellation, subprocess grace and transfer/verification.
  /** Issue a durable binding from enforced isolation, never from config alone or an agent-written artifact. */
  // null proves this request acquired no resources; a thrown/interrupted call leaves acquisition uncertain.
  acquire(request: NativeRuntimeRequest, timeoutMs: number): Promise<NativeRuntimeBinding | null>;
  /** Read-only recovery by the journaled request. Never reserves resources or acquires a replacement. */
  lookup(request: NativeRuntimeRequest, timeoutMs: number): Promise<NativeRuntimeLookup | null>;
  /** Resolve the original lease independently of current configuration. Unknown/expired leases return null or throw. */
  resolve(binding: NativeRuntimeBinding, timeoutMs: number): Promise<NativeRuntimeBinding | null>;
  // Every transport must resolve this exact binding and refuse unknown/expired leases before action. No shared-host fallback.
  /** Foreground process binding is required; an unqualified AX tree never proves app-specific UI. */
  observe(
    binding: NativeRuntimeBinding,
    udid: string,
    worktreeId: string,
    timeoutMs: number,
  ): Promise<{ bundleId: string; pid: number; snapshot: unknown } | null>;
  now(): number;
  pause(ms: number): Promise<void>;
  simctl(binding: NativeRuntimeBinding, ...args: Parameters<Simctl>): Promise<RunResult>;
  emulator(binding: NativeRuntimeBinding, ...args: Parameters<Emulator>): Promise<unknown>;
  bundleId(binding: NativeRuntimeBinding, app: string, timeoutMs: number): Promise<string>;
  /** Bound the transfer itself, not just the returned Buffer; never interpret a dispatcher path as a guest path. */
  capture(
    binding: NativeRuntimeBinding,
    udid: string,
    worktreeId: string,
    maxBytes: number,
    timeoutMs: number,
  ): Promise<Buffer>;
  /** Cleanup is intentionally allowed after stop/lost-lock/deadline, for this request's proven-owned UDID only. */
  cleanup(
    binding: NativeRuntimeBinding,
    udid: string,
    worktreeId: string,
    timeoutMs: number,
  ): Promise<string[]>;
  /** Bounded, idempotent settlement of this exact lease's resources; only verified release/tombstone may return []. */
  release(binding: NativeRuntimeBinding, timeoutMs: number): Promise<string[]>;
}
export function nativeUiHost(_home: string): NativeUiPort {
  const unavailable = async (): Promise<never> => {
    throw new Error(
      "native app execution requires a trusted isolated runtime; shared-host transports are unavailable",
    );
  };
  return {
    // CoreSimulator is not an execution sandbox. Supplying a forged binding cannot enable these transports.
    acquire: async () => null,
    lookup: async () => null,
    resolve: async () => null,
    observe: unavailable,
    now: Date.now,
    pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    simctl: unavailable,
    emulator: unavailable,
    bundleId: unavailable,
    capture: unavailable,
    cleanup: unavailable,
    release: unavailable,
  };
}

/** Idempotent, exact-owned-device cleanup; an unavailable verification remains a failure. */
export async function cleanupOwnedDevice(
  simctl: Simctl,
  emulator: Emulator,
  udid: string,
  worktreeId: string,
  timeoutMs = NATIVE_DEVICE_CLEANUP_MS,
  now = Date.now,
): Promise<string[]> {
  const errors: string[] = [];
  const deadline = now() + Math.min(timeoutMs, NATIVE_DEVICE_CLEANUP_MS);
  const commandMs = () => {
    // shared/exec.run may drain pipes for two seconds after its kill deadline. Keep that grace inside this total budget.
    const remaining = deadline - now() - 2_000;
    if (remaining <= 0) throw new Error("native device cleanup deadline exceeded");
    return Math.min(3_000, remaining);
  };
  try {
    await emulator(["kill", "--device", udid, "--worktree", `id:${worktreeId}`], commandMs());
  } catch {
    // A prior cleanup may have stopped the helper before the dispatcher crashed. Only an explicit empty worktree-scoped
    // inventory settles that case; never select or stop a different active device to make cleanup pass.
    try {
      const result = await emulator(["list", "--worktree", `id:${worktreeId}`], commandMs());
      if (!result || typeof result !== "object" || !("running" in result) || result.running !== false)
        throw new Error("helper remains/unverified");
    } catch {
      errors.push("owned emulator helper absence could not be verified");
    }
  }
  try {
    await simctl(["shutdown", udid], commandMs());
  } catch {
    /* Explicit absence below is still required. */
  }
  try {
    await simctl(["delete", udid], commandMs());
  } catch {
    /* Exact absence below also settles interrupted prior cleanup. */
  }
  try {
    const listed = await simctl(["list", "devices", "--json"], commandMs());
    if (now() > deadline) throw new Error("native device cleanup deadline exceeded");
    if (listed.code !== 0 || listed.timedOut || listed.truncated) throw new Error("list unavailable");
    const data: unknown = JSON.parse(listed.stdout);
    if (
      !data ||
      typeof data !== "object" ||
      !("devices" in data) ||
      !data.devices ||
      typeof data.devices !== "object"
    )
      throw new Error("list shape");
    const groups = Object.values(data.devices);
    if (
      !groups.every(
        (g) =>
          Array.isArray(g) &&
          g.every((d: unknown) => d && typeof d === "object" && "udid" in d && typeof d.udid === "string"),
      )
    )
      throw new Error("device shape");
    if (
      groups.some((g) => (g as { udid: string }[]).some((d) => d.udid.toLowerCase() === udid.toLowerCase()))
    )
      throw new Error("owned device remains");
  } catch {
    errors.push("owned Simulator absence could not be verified");
  }
  return errors;
}
