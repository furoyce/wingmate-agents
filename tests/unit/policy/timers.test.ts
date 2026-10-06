import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ConfigSchema, withDefaults } from "../../../src/config/schema";
import { capMinFor, timerState } from "../../../src/policy/timers";
import { newRecord } from "../../../src/state/records";

const cfg = withDefaults(
  ConfigSchema.parse(JSON.parse(readFileSync("tests/fixtures/config.min.json", "utf8"))),
);
const timers = cfg.defaults.timers;

describe("timers", () => {
  test("caps per stage", () => {
    expect(capMinFor("implement", timers)).toBe(180);
    expect(capMinFor("pr", timers)).toBe(20);
    expect(capMinFor("intake", timers)).toBe(20);
  });
  test("working past cap → cap_passed; parked → none; after nudge grace runs then expires", () => {
    const r = newRecord({
      identifier: "JRF-1",
      linearId: "l",
      project: "bouncr",
      repo: "api",
      provider: "claude",
      autonomy: "ask-first",
      now: "2026-10-06T08:00:00.000Z",
    });
    r.stage = "working";
    r.pipelineStage = "plan";
    r.timers.capMin = 45;
    expect(timerState(r, "2026-10-06T08:30:00.000Z", timers)).toBe("none");
    expect(timerState(r, "2026-10-06T08:46:00.000Z", timers)).toBe("cap_passed");
    r.timers.nudgedAt = "2026-10-06T08:46:00.000Z";
    r.timers.graceEndsAt = "2026-10-06T09:16:00.000Z";
    expect(timerState(r, "2026-10-06T09:00:00.000Z", timers)).toBe("grace_running");
    expect(timerState(r, "2026-10-06T09:17:00.000Z", timers)).toBe("grace_expired");
    r.stage = "awaiting-human";
    expect(timerState(r, "2026-10-06T12:00:00.000Z", timers)).toBe("none");
    r.stage = "working";
    r.paused = true;
    expect(timerState(r, "2026-10-06T12:00:00.000Z", timers)).toBe("none");
  });
  test("a zero capMin falls back to the configured stage cap", () => {
    const r = newRecord({
      identifier: "JRF-2",
      linearId: "l",
      project: "bouncr",
      repo: "api",
      provider: "claude",
      autonomy: "ask-first",
      now: "2026-10-06T08:00:00.000Z",
    });
    r.stage = "claimed";
    r.pipelineStage = "intake";
    r.timers.capMin = 0;
    expect(timerState(r, "2026-10-06T08:19:00.000Z", timers)).toBe("none");
    expect(timerState(r, "2026-10-06T08:21:00.000Z", timers)).toBe("cap_passed");
  });
});
