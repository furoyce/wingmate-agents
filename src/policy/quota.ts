import type { RateLimits } from "../ports";

export type Availability =
  | { available: true; attention: string[] }
  | { available: false; reason: "quota_unknown" | "quota"; detail: string };

// §9.1: weekly-class windows (≥ 1440 min) cap at weeklyMax, session windows at sessionMax; an expired window counts as
// zero; a stale snapshot is advisory (attention), never blocking; an unreadable provider is quota_unknown.
export function availability(
  rl: RateLimits,
  provider: string,
  q: { weeklyMax: number; sessionMax: number; maxSnapshotAgeMin: number },
  nowMs: number,
): Availability {
  const p = rl[provider];
  if (!p || p.status !== "ok")
    return { available: false, reason: "quota_unknown", detail: p?.error ?? `no rateLimits.${provider}` };
  const attention: string[] = [];
  if (p.updatedAt != null) {
    const age = Math.round((nowMs - p.updatedAt) / 60_000);
    if (age > q.maxSnapshotAgeMin) attention.push(`quota_stale(${provider}, ${age})`);
  }
  const entries = [...Object.entries(p.windows).map(([name, w]) => ({ name, ...w })), ...p.buckets];
  for (const e of entries) {
    const used = e.resetsAt != null && e.resetsAt <= nowMs ? 0 : e.usedPercent;
    const cap = e.windowMinutes >= 1440 ? q.weeklyMax : q.sessionMax;
    if (used > cap) return { available: false, reason: "quota", detail: `${provider}, ${e.name}, ${used}` };
  }
  return { available: true, attention };
}
