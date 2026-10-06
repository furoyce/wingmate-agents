// tests/unit/machine/states.test.ts
import { describe, expect, test } from "bun:test";
import { TERMINAL, TRANSITIONS, addAttention, dropAttention, isEdge } from "../../../src/machine/states";
import { newRecord } from "../../../src/state/records";

describe("TRANSITIONS (§5.2.1)", () => {
  test("allowed edges", () => {
    expect(isEdge("claimed", "working", "turn_started")).toBe(true);
    expect(isEdge("working", "awaiting-human", "ask")).toBe(true);
    expect(isEdge("awaiting-human", "working", "answer")).toBe(true);
    expect(isEdge("review", "working", "review_feedback")).toBe(true);
    expect(isEdge("blocked", "working", "continue")).toBe(true);
    expect(isEdge("working", "claimed", "handoff")).toBe(true);
    expect(isEdge("awaiting-human", "released", "override")).toBe(true);
    expect(isEdge("working", "done", "owner_done")).toBe(true);
  });
  test("forbidden edges", () => {
    expect(isEdge("blocked", "working", "answer")).toBe(false);
    expect(isEdge("review", "awaiting-human", "ask")).toBe(false);
    expect(isEdge("done", "working", "continue")).toBe(false);
    expect(isEdge("claimed", "review", "finish")).toBe(false);
  });
  test("every stage except terminal ones has an exit", () => {
    for (const s of ["claimed", "working", "awaiting-human", "review", "blocked"] as const)
      expect(Object.keys(TRANSITIONS[s]).length).toBeGreaterThan(0);
  });
  test("a claimed record (between a handoff and its successor's turn) can be blocked by the same causes as a working one", () => {
    for (const cause of [
      "kit_tampered",
      "cascade_exhausted",
      "provider_unavailable",
      "grace_expired_no_cascade",
      "owner_stop",
    ])
      expect(isEdge("claimed", "blocked", cause)).toBe(true);
    expect(isEdge("claimed", "blocked", "publish_guard")).toBe(false);
  });
  test("released, done and cancelled have no exits; blocked is terminal for the cycle but keeps its continue edge", () => {
    for (const s of ["released", "done", "cancelled"] as const) expect(TRANSITIONS[s]).toEqual({});
    expect(TERMINAL.has("blocked")).toBe(true);
    expect(TERMINAL.has("working")).toBe(false);
  });
});

describe("attention is a set (R20)", () => {
  test("a code is added once and dropped by exact match", () => {
    const r = newRecord({
      identifier: "JRF-1",
      linearId: "l",
      project: "bouncr",
      repo: "api",
      provider: "claude",
      autonomy: "ask-first",
      now: "2026-10-06T10:00:00.000Z",
    });
    addAttention(r, "unauthorized_label_change");
    addAttention(r, "unauthorized_label_change");
    addAttention(r, "cap_passed");
    expect(r.attention).toEqual(["unauthorized_label_change", "cap_passed"]);
    dropAttention(r, "cap_passed");
    expect(r.attention).toEqual(["unauthorized_label_change"]);
  });
});
