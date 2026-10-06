import { describe, expect, test } from "bun:test";
import type { ProviderLimits, RateLimits } from "../../../src/ports";
import { availability } from "../../../src/policy/quota";

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
  test("stale snapshot is advisory", () => {
    const r = availability(rl({ updatedAt: now - 7 * 3_600_000 }), "claude", q, now);
    expect(r).toMatchObject({ available: true });
    expect((r as { attention: string[] }).attention[0]).toMatch(/^quota_stale\(claude, \d+\)$/);
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
