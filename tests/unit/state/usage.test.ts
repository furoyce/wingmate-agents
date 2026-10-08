import { expect, test } from "bun:test";
import { usageSummary } from "../../../src/state/usage";

test("usage distinguishes measured role subtotals from unknown coordinator totals", () => {
  const usage = {
    tokens: null,
    costUsd: null,
    agentMinutes: 6,
    bySession: [
      {
        role: "code-reviewer",
        provider: "codex",
        sessionRef: "a",
        tokens: 12,
        costUsd: null,
        agentMinutes: 1,
        provenance: "measured-transcript" as const,
      },
      {
        role: "code-reviewer",
        provider: "codex",
        sessionRef: "b",
        tokens: 8,
        costUsd: null,
        agentMinutes: 2,
        provenance: "measured-transcript" as const,
      },
      {
        role: "coordinator",
        provider: "claude",
        sessionRef: "c",
        tokens: null,
        costUsd: null,
        agentMinutes: 3,
        provenance: "timed" as const,
      },
    ],
  };
  const summary = usageSummary(usage);
  expect(summary).toContain("code-reviewer/codex: 20 tokens; 3.0 agent-min (measured-transcript)");
  expect(summary).toContain("coordinator/claude: dollars and tokens unknown; 3.0 agent-min (timed)");
  expect(summary).not.toContain("$0");
  expect(usage.bySession[0]?.tokens).toBe(12);
  expect(usageSummary({ ...usage, bySession: [] })).toBe("unknown");
});
