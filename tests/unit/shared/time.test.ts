import { describe, expect, test } from "bun:test";
import { FixedClock, fromEpochMs, iso } from "../../../src/shared/time";
describe("time", () => {
  test("iso renders UTC with milliseconds", () => {
    expect(iso(new Date(Date.UTC(2026, 9, 6, 12, 0, 0, 5)))).toBe("2026-10-06T12:00:00.005Z");
  });
  test("fromEpochMs normalizes Orca timestamps", () => {
    expect(fromEpochMs(1791228347000)).toBe("2026-10-05T19:25:47.000Z");
  });
  test("FixedClock advances deterministically", () => {
    const c = new FixedClock(new Date("2026-10-06T00:00:00Z"));
    c.advance(90_000);
    expect(iso(c.now())).toBe("2026-10-06T00:01:30.000Z");
  });
});
