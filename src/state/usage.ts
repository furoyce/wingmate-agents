import type { WRecord } from "./records";

/** Partial measurements are labelled per session, never presented as a complete dollar total. */
export function usageSummary(usage: WRecord["usage"]): string {
  if (!usage.bySession.length) return "unknown";
  const groups = new Map<string, WRecord["usage"]["bySession"][number]>();
  for (const session of usage.bySession) {
    const key = `${session.role}/${session.provider}/${session.provenance}`;
    const group = groups.get(key);
    if (!group) groups.set(key, { ...session });
    else {
      group.tokens = group.tokens === null || session.tokens === null ? null : group.tokens + session.tokens;
      group.costUsd =
        group.costUsd === null || session.costUsd === null ? null : group.costUsd + session.costUsd;
      group.agentMinutes += session.agentMinutes;
    }
  }
  return [...groups.values()]
    .map((s) => {
      const measured = [
        s.costUsd === null ? null : `$${s.costUsd.toFixed(4)}`,
        s.tokens === null ? null : `${s.tokens} tokens`,
      ].filter(Boolean);
      return `${s.role}/${s.provider}: ${measured.length ? measured.join(", ") : "dollars and tokens unknown"}; ${s.agentMinutes.toFixed(1)} agent-min (${s.provenance})`;
    })
    .join(" · ");
}
