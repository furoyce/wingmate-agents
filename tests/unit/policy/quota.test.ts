import { describe, expect, test } from "bun:test";
import { availability, quotaAttention } from "../../../src/policy/quota";
import type { ProviderLimits, RateLimits } from "../../../src/ports";

const now = Date.parse("2026-10-06T10:00:00Z");
const q = { weeklyMax: 80, sessionMax: 90, maxSnapshotAgeMin: 360 };
const rl = (over: Partial<ProviderLimits>): RateLimits => ({
  claude: {
    status: "ok",
    error: null,
    updatedAt: now - 60_000,
    windows: {
      session: { usedPercent: 10, windowMinutes: 300, resetsAt: now + 3_600_000 },
      weekly: { usedPercent: 30, windowMinutes: 10080, resetsAt: now + 86_400_000 },
    },
    buckets: [],
    ...over,
  },
});

describe("availability", () => {
  test("ok under caps", () => {
    expect(availability(rl({}), "claude", q, now)).toMatchObject({ available: true, attention: [] });
  });
  test("weekly over 80 → quota", () => {
    expect(
      availability(
        rl({ windows: { weekly: { usedPercent: 81, windowMinutes: 10080, resetsAt: now + 1 } } }),
        "claude",
        q,
        now,
      ),
    ).toMatchObject({ available: false, reason: "quota" });
  });
  test("fableWeekly counts as weekly class", () => {
    expect(
      availability(
        rl({ windows: { fableWeekly: { usedPercent: 95, windowMinutes: 10080, resetsAt: now + 1 } } }),
        "claude",
        q,
        now,
      ),
    ).toMatchObject({ available: false });
  });
  test("session over 90 → quota; 85 is fine", () => {
    expect(
      availability(
        rl({ windows: { session: { usedPercent: 91, windowMinutes: 300, resetsAt: now + 1 } } }),
        "claude",
        q,
        now,
      ),
    ).toMatchObject({ available: false });
    expect(
      availability(
        rl({ windows: { session: { usedPercent: 85, windowMinutes: 300, resetsAt: now + 1 } } }),
        "claude",
        q,
        now,
      ),
    ).toMatchObject({ available: true });
  });
  test("expired window counts as zero", () => {
    expect(
      availability(
        rl({ windows: { session: { usedPercent: 100, windowMinutes: 300, resetsAt: now - 1 } } }),
        "claude",
        q,
        now,
      ),
    ).toMatchObject({ available: true });
  });
  test("a bucket over its cap also blocks", () => {
    expect(
      availability(
        rl({ buckets: [{ name: "opus", usedPercent: 99, windowMinutes: 10080, resetsAt: now + 1 }] }),
        "claude",
        q,
        now,
      ),
    ).toMatchObject({ available: false, reason: "quota", detail: "claude, opus, 99" });
  });
  test("stale snapshot is advisory: available, with the enum code quota_stale and the snapshot's age in minutes beside it (F10)", () => {
    expect(availability(rl({ updatedAt: now - 7 * 3_600_000 }), "claude", q, now)).toEqual({
      available: true,
      attention: ["quota_stale"],
      ageMin: 420,
    });
    expect(availability(rl({}), "claude", q, now)).toEqual({ available: true, attention: [], ageMin: 1 });
    expect(availability(rl({ updatedAt: null }), "claude", q, now)).toEqual({
      available: true,
      attention: [],
      ageMin: null,
    });
  });
  test("F10: quotaAttention keeps the evaluated providers whose snapshot is stale — enum codes and the age only; fresh, unreadable or over-cap ones carry none", () => {
    const stale = now - 7 * 3_600_000;
    const limits: RateLimits = {
      ...rl({ updatedAt: stale }),
      codex: { ...(rl({}).claude as ProviderLimits), updatedAt: now - 5 * 60_000 },
      cursor: { ...(rl({ updatedAt: stale }).claude as ProviderLimits) },
    };
    expect(quotaAttention(limits, ["claude", "codex"], q, now)).toEqual({
      claude: { attention: ["quota_stale"], ageMin: 420 },
    }); // cursor is stale too, but not a provider the tick evaluates
    const overCap = rl({
      updatedAt: stale,
      windows: { weekly: { usedPercent: 99, windowMinutes: 10080, resetsAt: now + 1 } },
    });
    expect(quotaAttention(overCap, ["claude"], q, now)).toEqual({}); // unavailable: its skip reason says why
    expect(quotaAttention({}, ["claude", "codex"], q, now)).toEqual({}); // quota_unknown, never stale
  });
  test("missing provider or status error → quota_unknown", () => {
    expect(availability({}, "codex", q, now)).toMatchObject({ available: false, reason: "quota_unknown" });
    expect(availability(rl({ status: "error", error: "sign-in expired" }), "claude", q, now)).toMatchObject({
      available: false,
      reason: "quota_unknown",
      detail: "sign-in expired",
    });
  });
  test("null windows mean no limit", () => {
    expect(availability(rl({ windows: {} }), "claude", q, now)).toMatchObject({ available: true });
  });
});
