import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ConfigSchema, withDefaults } from "../../../src/config/schema";
import { slots } from "../../../src/policy/concurrency";
import { type Stage, newRecord } from "../../../src/state/records";

const cfg = withDefaults(
  ConfigSchema.parse(JSON.parse(readFileSync("tests/fixtures/config.min.json", "utf8"))),
);
const rec = (id: string, project: string, provider: "claude" | "codex", stage: Stage) => ({
  ...newRecord({
    identifier: id,
    linearId: id,
    project,
    repo: "api",
    provider,
    autonomy: "ask-first",
    now: "2026-10-06T09:00:00.000Z",
  }),
  stage,
});

describe("slots", () => {
  test("a working record holds the per-project slot", () => {
    expect(
      slots([rec("JRF-1", "bouncr", "claude", "working")], 1, cfg).canClaim("bouncr", "claude"),
    ).toMatchObject({
      reason: "cap_project",
      detail: "JRF-1",
    });
  });
  test("awaiting-human does not consume a working slot", () => {
    expect(
      slots([rec("JRF-1", "bouncr", "claude", "awaiting-human")], 1, cfg).canClaim("bouncr", "claude"),
    ).toBeNull();
  });
  test("review, blocked and released records do not consume working or in-flight slots", () => {
    const rs = [
      rec("JRF-1", "bouncr", "claude", "review"),
      rec("JRF-2", "bouncr", "claude", "blocked"),
      rec("JRF-3", "bouncr", "claude", "released"),
    ];
    expect(slots(rs, 3, cfg).canClaim("bouncr", "claude")).toBeNull();
  });
  test("global cap of 3 working", () => {
    const rs = [
      rec("JRF-1", "bouncr", "claude", "working"),
      rec("JRF-2", "smart-dispatcher", "claude", "working"),
      rec("JRF-3", "jr-learning-plus", "codex", "claimed"),
    ];
    expect(slots(rs, 3, cfg).canClaim("jr-travel-atlas", "codex")).toMatchObject({ reason: "cap_global" });
  });
  test("per-provider cap of 2", () => {
    const rs = [
      rec("JRF-1", "bouncr", "claude", "working"),
      rec("JRF-2", "smart-dispatcher", "claude", "working"),
    ];
    expect(slots(rs, 2, cfg).canClaim("jr-travel-atlas", "claude")).toMatchObject({ reason: "cap_provider" });
    expect(slots(rs, 2, cfg).canClaim("jr-travel-atlas", "codex")).toBeNull();
  });
  test("maxInFlight counts parked issues", () => {
    const rs = ["a", "b", "c", "d", "e", "f"].map((_k, i) =>
      rec(`JRF-${i}`, "bouncr", "claude", "awaiting-human"),
    );
    expect(slots(rs, 6, cfg).canClaim("smart-dispatcher", "claude")).toMatchObject({
      reason: "cap_inflight",
    });
  });
  test("maxLiveWorktrees", () => {
    expect(slots([], 8, cfg).canClaim("bouncr", "claude")).toMatchObject({ reason: "cap_worktrees" });
  });
});
