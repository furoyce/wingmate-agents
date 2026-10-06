import type { Config } from "../config/schema";
import type { SkipReason } from "../state/queue";
import type { WRecord } from "../state/records";

// §9.5: caps gate new claims only. Parked issues hold an in-flight slot but never a working slot.
const WORKING = new Set(["claimed", "working"]);
const INFLIGHT = new Set(["claimed", "working", "awaiting-human"]);

export function slots(records: WRecord[], liveWorktrees: number, cfg: Config) {
  const working = records.filter((r) => WORKING.has(r.stage));
  const inflight = records.filter((r) => INFLIGHT.has(r.stage));
  return {
    canClaim(
      projectKey: string,
      provider: "claude" | "codex",
    ): { reason: SkipReason; detail: string } | null {
      const c = cfg.projects[projectKey]?.concurrency ?? cfg.defaults.concurrency;
      if (liveWorktrees >= c.maxLiveWorktrees)
        return { reason: "cap_worktrees", detail: String(liveWorktrees) };
      if (inflight.length >= c.maxInFlight)
        return { reason: "cap_inflight", detail: String(inflight.length) };
      if (working.length >= c.maxWorking.global)
        return { reason: "cap_global", detail: working.map((r) => r.identifier).join(",") };
      const inProject = working.filter((r) => r.project === projectKey);
      if (inProject.length >= c.maxWorking.perProject)
        return { reason: "cap_project", detail: inProject[0]?.identifier ?? "" };
      const onProvider = working.filter((r) => r.provider === provider);
      if (onProvider.length >= c.maxWorking.perProvider) return { reason: "cap_provider", detail: provider };
      return null;
    },
  };
}
