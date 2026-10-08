// Credentialed host adapter. Never called by agent CLI. Its only command surfaces are fixed simctl/plutil and Orca emulator.
import { orca } from "../orca/cli";
import { type RunResult, run } from "../shared/exec";

export interface NativeUiPort {
  /** Attested by a trusted isolated runtime adapter, not config or an agent-written artifact. */
  executionIsolation(): Promise<{ kind: "dedicated-isolated-host"; profileHash: string } | null>;
  /** Foreground process binding is required; an unqualified AX tree never proves app-specific UI. */
  observe(
    udid: string,
    worktreeId: string,
    timeoutMs: number,
  ): Promise<{ bundleId: string; pid: number; snapshot: unknown } | null>;
  now(): number;
  pause(ms: number): Promise<void>;
  simctl(args: string[], timeoutMs: number, childEnv?: Record<string, string>): Promise<RunResult>;
  emulator(args: string[], timeoutMs: number): Promise<unknown>;
  bundleId(app: string, timeoutMs: number): Promise<string>;
  /** Cleanup is intentionally allowed after stop/lost-lock/deadline, for this request's proven-owned UDID only. */
  cleanup(udid: string, worktreeId: string): Promise<string[]>;
}
export function nativeUiHost(home: string): NativeUiPort {
  const env = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" };
  const simctl: NativeUiPort["simctl"] = (args, timeoutMs, child = {}) =>
    run(["/usr/bin/xcrun", "simctl", ...args], {
      timeoutMs,
      inheritEnv: false,
      env: { ...env, ...Object.fromEntries(Object.entries(child).map(([k, v]) => [`SIMCTL_CHILD_${k}`, v])) },
    });
  return {
    // CoreSimulator is not an execution sandbox. This shared-host adapter deliberately cannot launch agent-built apps.
    executionIsolation: async () => null,
    observe: async () => null,
    now: Date.now,
    pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    simctl,
    emulator: (args, timeoutMs) => orca(["emulator", ...args], { timeoutMs }),
    bundleId: async (app, timeoutMs) => {
      const r = await run(
        ["/usr/bin/plutil", "-extract", "CFBundleIdentifier", "raw", "-o", "-", `${app}/Info.plist`],
        { timeoutMs, inheritEnv: false, env },
      );
      if (r.code !== 0 || r.timedOut || r.truncated)
        throw new Error("native app Info.plist could not be verified");
      return r.stdout.trim();
    },
    cleanup: (udid, worktreeId) =>
      cleanupOwnedDevice(
        simctl,
        (args, ms) => orca(["emulator", ...args], { timeoutMs: ms }),
        udid,
        worktreeId,
      ),
  };
}

/** Idempotent, exact-owned-device cleanup; an unavailable verification remains a failure. */
export async function cleanupOwnedDevice(
  simctl: NativeUiPort["simctl"],
  emulator: NativeUiPort["emulator"],
  udid: string,
  worktreeId: string,
): Promise<string[]> {
  const errors: string[] = [];
  try {
    await emulator(["kill", "--device", udid, "--worktree", `id:${worktreeId}`], 5_000);
  } catch {
    // A prior cleanup may have stopped the helper before the dispatcher crashed. Only an explicit empty worktree-scoped
    // inventory settles that case; never select or stop a different active device to make cleanup pass.
    try {
      const result = await emulator(["list", "--worktree", `id:${worktreeId}`], 5_000);
      if (!result || typeof result !== "object" || !("running" in result) || result.running !== false)
        throw new Error("helper remains/unverified");
    } catch {
      errors.push("owned emulator helper absence could not be verified");
    }
  }
  await simctl(["shutdown", udid], 5_000).catch(() => undefined);
  try {
    await simctl(["delete", udid], 5_000);
  } catch {
    /* Exact absence below also settles interrupted prior cleanup. */
  }
  try {
    const listed = await simctl(["list", "devices", "--json"], 5_000);
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
