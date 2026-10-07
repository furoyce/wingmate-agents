import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentActiveAt, coordinatorLiveness, coordinatorRow } from "../../../src/machine/liveness";
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

describe("INT-2: coordinatorRow — the coordinator's terminal re-resolved each tick (§4.4: handles are runtime-scoped)", () => {
  const agentAt = (paneKey: string, state = "working") =>
    ({ ...row(null), agents: [{ ...row(state).agents[0], paneKey }] }) as FleetRow;
  test("by its handle; after Orca re-issued the handle, by its recorded pane key; after both changed, by its title with an agent in its pane", () => {
    expect(coordinatorRow(rec(), [term], row("working"))?.handle).toBe("term_1");
    const reissued = { ...term, handle: "term_99" };
    expect(coordinatorRow(rec(), [reissued], row("working"))?.handle).toBe("term_99");
    expect(coordinatorLiveness(rec(), [reissued], row("working"))).toBe("working");
    const moved = { ...term, handle: "term_77", tabId: "tab7", leafId: "leaf7", title: "wingmate JRF-1" };
    expect(coordinatorRow(rec(), [moved], agentAt("tab7:leaf7"))?.handle).toBe("term_77");
    expect(coordinatorLiveness(rec(), [moved], agentAt("tab7:leaf7", "done"))).toBe("idle");
  });
  test("never a guess: a titled row without an agent, two titled rows, another issue's or a role's title, or a record never launched → none (exited)", () => {
    const moved = { ...term, handle: "term_77", tabId: "tab7", leafId: "leaf7", title: "wingmate JRF-1" };
    expect(coordinatorRow(rec(), [moved], row(null))).toBeUndefined(); // a bare shell is no coordinator
    const twin = { ...moved, handle: "term_78", leafId: "leaf8" };
    const both = {
      ...row(null),
      agents: [agentAt("tab7:leaf7").agents[0], agentAt("tab7:leaf8").agents[0]],
    } as FleetRow;
    expect(coordinatorRow(rec(), [moved, twin], both)).toBeUndefined();
    for (const title of ["wingmate JRF-11", "wingmate JRF-1 code-reviewer"])
      expect(coordinatorRow(rec(), [{ ...moved, title }], agentAt("tab7:leaf7"))).toBeUndefined();
    const fresh = rec();
    fresh.coordinator.terminalHandle = null;
    expect(coordinatorRow(fresh, [moved], agentAt("tab7:leaf7"))).toBeUndefined();
    expect(coordinatorLiveness(rec(), [moved], row(null))).toBe("exited");
  });
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
  test("C12 (§5.5 '… or the worktree is gone'): a worktree removed from disk is exited while Orca still lists its row and terminal", () => {
    const r = rec();
    const dir = mkdtempSync(join(tmpdir(), "wm-live-"));
    r.worktree = { id: "w", path: dir, branch: "b", baseSha: "s", gitCommonDir: "/c", gitdirName: "g" };
    expect(coordinatorLiveness(r, [term], row("working"))).toBe("working");
    rmSync(dir, { recursive: true, force: true });
    expect(coordinatorLiveness(r, [term], row("working"))).toBe("exited");
    expect(coordinatorLiveness(r, [term], row("done"))).toBe("exited");
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
