import { describe, expect, test } from "bun:test";
import { agentActiveAt, coordinatorLiveness } from "../../../src/machine/liveness";
import type { FleetRow, TerminalRow } from "../../../src/ports";
import { newRecord } from "../../../src/state/records";

const rec = () => {
  const r = newRecord({
    identifier: "JRF-1",
    linearId: "l",
    project: "bouncr",
    repo: "api",
    provider: "claude",
    autonomy: "ask-first",
    now: "2026-10-06T09:00:00.000Z",
  });
  r.coordinator.terminalHandle = "term_1";
  r.coordinator.paneKey = "tab1:leaf1";
  return r;
};
const term: TerminalRow = {
  handle: "term_1",
  tabId: "tab1",
  leafId: "leaf1",
  worktreeId: "w",
  title: "t",
  lastOutputAt: "2026-10-06T09:30:00.000Z",
};
const row = (state: string | null): FleetRow => ({
  worktreeId: "w",
  repoId: "r",
  path: "/p",
  branch: "b",
  displayName: "d",
  linkedLinearIssue: "JRF-1",
  status: "active",
  liveTerminalCount: 1,
  lastOutputAt: null,
  childWorktreeIds: [],
  agents: state
    ? [
        {
          paneKey: "tab1:leaf1",
          state,
          agentType: "claude",
          stateStartedAt: "2026-10-06T09:00:00.000Z",
          updatedAt: null,
        },
      ]
    : [],
});

describe("coordinatorLiveness", () => {
  test("working / idle / exited / unverifiable", () => {
    expect(coordinatorLiveness(rec(), [term], row("working"))).toBe("working");
    expect(coordinatorLiveness(rec(), [term], row("done"))).toBe("idle");
    expect(coordinatorLiveness(rec(), [], row("done"))).toBe("exited");
    expect(coordinatorLiveness(rec(), [term], row(null), "bash-3.2$ ")).toBe("exited");
    expect(coordinatorLiveness(rec(), [term], row(null), "")).toBe("unverifiable");
    expect(coordinatorLiveness(rec(), [term], undefined)).toBe("exited");
  });
  test("a retained ps entry for a closed tab is ignored", () => {
    expect(coordinatorLiveness(rec(), [{ ...term, tabId: "other", leafId: "x" }], row("done"), "zsh% ")).toBe(
      "exited",
    );
  });
  test("a record without a handle is exited", () => {
    const r = rec();
    r.coordinator.terminalHandle = null;
    expect(coordinatorLiveness(r, [term], row("working"))).toBe("exited");
  });
});

describe("agentActiveAt", () => {
  test("true inside a working interval with margin, false after done with margin", () => {
    const r = row("done");
    const first = r.agents[0];
    if (!first) throw new Error("fixture row has no agent");
    first.stateStartedAt = "2026-10-06T09:10:00.000Z";
    expect(agentActiveAt(r, [term], "2026-10-06T09:10:30.000Z", 60)).toBe(true);
    expect(agentActiveAt(r, [term], "2026-10-06T09:12:00.000Z", 60)).toBe(false);
    const w = row("working");
    expect(agentActiveAt(w, [term], "2026-10-06T09:40:00.000Z", 60)).toBe(true);
  });
  test("terminal output within the margin counts as activity; no row means inactive", () => {
    const r = row(null);
    expect(agentActiveAt(r, [term], "2026-10-06T09:30:20.000Z", 60)).toBe(true);
    expect(agentActiveAt(r, [term], "2026-10-06T09:35:00.000Z", 60)).toBe(false);
    expect(agentActiveAt(undefined, [term], "2026-10-06T09:30:00.000Z", 60)).toBe(false);
  });
  test("an agent entry whose pane is no longer listed is ignored", () => {
    const r = row("working");
    expect(agentActiveAt(r, [], "2026-10-06T09:40:00.000Z", 60)).toBe(false);
  });
});
