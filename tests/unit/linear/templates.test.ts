// tests/unit/linear/templates.test.ts
import { describe, expect, test } from "bun:test";
import { renderCompletion, renderQuestion, renderStatus } from "../../../src/linear/templates";

describe("templates", () => {
  test("question includes numbered options, recommendation, how-to-answer and the stop hint", () => {
    const md = renderQuestion({
      identifier: "JRF-404",
      questionId: "01H",
      stage: "intake",
      context: "Two sentences of context.",
      options: ["unit", "accuracy"],
      recommend: 2,
      mention: "@[Royce Fu](71aef180-1742-4a76-8d49-51f14e8ada1e)",
    });
    expect(md.startsWith("<!-- wingmate:question id=01H -->")).toBe(true);
    expect(md).toContain("2. accuracy (recommended)");
    expect(md).toContain("add the label `human`");
    expect(md).toContain("signed-in owner account");
    expect(md).toContain("Answer in Linear");
    expect(md).toContain("Console answer submission is unavailable");
    expect(md).toContain("next dispatcher tick");
    expect(md).not.toContain("Console replies immediately");
  });
  test("status comment stays under 6 KB with a long activity log", () => {
    const md = renderStatus({
      identifier: "JRF-404",
      stage: "working",
      pipelineStage: "implement",
      waitingOn: null,
      nextAction: "implement",
      provider: "claude",
      model: "claude-fable-5-1",
      effort: "max",
      worktree: "/x",
      branch: "furoyce/wm-jrf-404",
      agents: { coordinator: 1, workers: 2 },
      gates: [
        ["intake", "PASS", 1],
        ["plan", "PASS", 2],
      ],
      pr: null,
      cost: { tokens: 123456, costUsd: null, provenance: "measured-transcript" },
      updatedAt: "2026-10-06T10:00:00.000Z",
      notes: Array.from({ length: 40 }, (_, i) => `note ${i} ${"x".repeat(300)}`),
    });
    expect(Buffer.byteLength(md)).toBeLessThan(6144);
    expect(md.split("note ").length - 1).toBe(5);
  });
  test("completion carries the request-changes instruction", () => {
    const md = renderCompletion({
      prs: [{ url: "https://github.com/x/y/pull/1", repo: "api" }],
      summary: "Done.",
      gates: [["validate", "PASS"]],
      limitations: [],
      followups: [],
    });
    expect(md).toContain("move this issue back to In Progress");
    expect(md).toContain("move this issue to Done as a configured human approver");
    expect(md).toContain("reopen and close it yourself");
  });
});
