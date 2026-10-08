import { describe, expect, test } from "bun:test";
import { parseRoleOutput, rolePrintArgv } from "../../../src/machine/roles";

describe("dispatcher role results", () => {
  test("Claude accepts only the successful final result, with measured usage", () => {
    const result = parseRoleOutput(
      "claude",
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "PASS\nReviewed the plan.",
        usage: { input_tokens: 12, output_tokens: 8, cache_read_input_tokens: 30 },
        total_cost_usd: 0.01,
      }),
      0,
    );
    expect(result).toMatchObject({ verdict: "PASS", tokens: 50, costUsd: 0.01 });
    expect(
      parseRoleOutput("claude", JSON.stringify({ type: "result", subtype: "error", result: "PASS" }), 0),
    ).toBeNull();
    expect(parseRoleOutput("claude", "PASS", 0)).toBeNull();
  });

  test("Codex reads the final agent message, never tool output or a failed turn", () => {
    const rows = [
      { type: "item.completed", item: { type: "command_execution", aggregated_output: "PASS" } },
      { type: "item.completed", item: { type: "agent_message", text: "FAIL\nMissing acceptance." } },
      { type: "turn.completed", usage: { input_tokens: 17, output_tokens: 3 } },
    ];
    expect(parseRoleOutput("codex", rows.map((x) => JSON.stringify(x)).join("\n"), 0)).toMatchObject({
      verdict: "FAIL",
      tokens: 20,
      costUsd: null,
    });
    expect(
      parseRoleOutput(
        "codex",
        rows
          .slice(0, 1)
          .map((x) => JSON.stringify(x))
          .join("\n"),
        0,
      ),
    ).toBeNull();
    expect(parseRoleOutput("codex", rows.map((x) => JSON.stringify(x)).join("\n"), 1)).toBeNull();
    expect(
      parseRoleOutput(
        "codex",
        `${rows.map((x) => JSON.stringify(x)).join("\n")}\n{\"type\":\"turn.failed\"}`,
        0,
      ),
    ).toBeNull();
  });

  test("print roles retain sandbox flags; the worker uses provider defaults", () => {
    const common = {
      role: "plan-verifier" as const,
      tier: { model: null, effort: "max" },
      sessionId: "session",
      settingsFile: "/kit/settings.json",
      worktreePath: "/wt",
    };
    expect(rolePrintArgv({ ...common, provider: "claude" })).toContain("--print");
    const codex = rolePrintArgv({ ...common, provider: "codex" });
    expect(codex.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(codex).toContain("read-only");
    expect(codex).toContain("approval_policy=never");
    expect(codex).toContain("--json");
    expect(rolePrintArgv({ ...common, provider: "claude", role: "worker", tier: null })).not.toContain(
      "--model",
    );
  });
});
