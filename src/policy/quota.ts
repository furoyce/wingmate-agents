import type { RateLimits } from "../ports";

/** §9.1 advisory codes on an available provider: a snapshot older than `quota.maxSnapshotAgeMin` (Task 13 F10: enum codes only). */
export type QuotaAttention = "quota_stale";
export type Availability =
  | { available: true; attention: QuotaAttention[]; ageMin: number | null }
  | { available: false; reason: "quota_unknown" | "quota"; detail: string };
/** The providers a quota notice can name (config's provider names). */
export type QuotaProvider = "claude" | "codex" | "cursor" | "antigravity";
/** F10: the tick's notices per provider — its codes and the snapshot's age in minutes; providers without a code are left out. */
export type QuotaNotices = Partial<Record<QuotaProvider, { attention: QuotaAttention[]; ageMin: number }>>;
type QuotaCaps = { weeklyMax: number; sessionMax: number; maxSnapshotAgeMin: number };

// §9.1: weekly-class windows (≥ 1440 min) cap at weeklyMax, session windows at sessionMax; an expired window counts as
// zero; a stale snapshot is advisory (attention), never blocking; an unreadable provider is quota_unknown.
export function availability(rl: RateLimits, provider: string, q: QuotaCaps, nowMs: number): Availability {
  const p = rl[provider];
  if (!p || p.status !== "ok")
    return { available: false, reason: "quota_unknown", detail: p?.error ?? `no rateLimits.${provider}` };
  const attention: QuotaAttention[] = [];
  const ageMin = p.updatedAt != null ? Math.round((nowMs - p.updatedAt) / 60_000) : null;
  if (ageMin !== null && ageMin > q.maxSnapshotAgeMin) attention.push("quota_stale");
  const entries = [...Object.entries(p.windows).map(([name, w]) => ({ name, ...w })), ...p.buckets];
  for (const e of entries) {
    const used = e.resetsAt != null && e.resetsAt <= nowMs ? 0 : e.usedPercent;
    const cap = e.windowMinutes >= 1440 ? q.weeklyMax : q.sessionMax;
    if (used > cap) return { available: false, reason: "quota", detail: `${provider}, ${e.name}, ${used}` };
  }
  return { available: true, attention, ageMin };
}

/**
 * F10 (§9.1, Review Focus 3): what the tick records — availability()'s codes for each provider it may start a coordinator with, beside
 * the snapshot's age (§9.1's `quota_stale(<provider>, <ageMin>)`). An unavailable provider carries no code: its skip reason says why.
 */
export function quotaAttention(
  rl: RateLimits,
  providers: readonly QuotaProvider[],
  q: QuotaCaps,
  nowMs: number,
): QuotaNotices {
  const out: QuotaNotices = {};
  for (const p of providers) {
    const a = availability(rl, p, q, nowMs);
    if (a.available && a.attention.length > 0 && a.ageMin !== null)
      out[p] = { attention: [...a.attention], ageMin: a.ageMin };
  }
  return out;
}
