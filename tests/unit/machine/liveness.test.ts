import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentActiveAt, coordinatorLiveness, coordinatorRow } from "../../../src/machine/liveness";
import { parseFleet, parseTerminals } from "../../../src/orca/fleet";
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

describe("INT-2 + N3 (R32): coordinatorRow — the coordinator's terminal re-resolved each tick (§4.4: handles are runtime-scoped)", () => {
  const fixture = (name: string): unknown =>
    JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "fixtures", "orca", name), "utf8"));
  /** The spike's own capture (§3.3): Orca's default shell and the agent terminal, listed under the title Claude set (OSC). */
  const captured = (moment: "working" | "idle") => {
    const terminals = parseTerminals(fixture(`terminal-list-${moment}.json`));
    const fleetRow = parseFleet(fixture(`worktree-ps-${moment}.json`)).worktrees[0];
    const agent = terminals.find((t) => /^[◑✳]/.test(t.title));
    if (!fleetRow || !agent) throw new Error("the fixture lost its agent row");
    return { terminals, fleetRow, agent };
  };
  /** The record as it stood before an Orca restart that re-issued both its handle and its pane key. */
  const beforeRestart = () => {
    const r = rec();
    r.coordinator.terminalHandle = "term_before_restart";
    r.coordinator.paneKey = "tab-before:leaf-before";
    return r;
  };
  const agentAt = (paneKey: string, state = "working") =>
    ({ ...row(null), agents: [{ ...row(state).agents[0], paneKey }] }) as FleetRow;

  test("by its handle; after Orca re-issued the handle, by its recorded pane key", () => {
    expect(coordinatorRow(rec(), [term], row("working"))).toMatchObject({ handle: "term_1" });
    const reissued = { ...term, handle: "term_99" };
    expect(coordinatorRow(rec(), [reissued], row("working"))).toMatchObject({ handle: "term_99" });
    expect(coordinatorLiveness(rec(), [reissued], row("working"))).toBe("working");
  });

  test("after both changed: the one terminal running a live Claude or Codex agent — Orca lists the title the agent set, never `wingmate <id>`", () => {
    const working = captured("working");
    expect(working.agent.title).toBe("◑ Sleep command test"); // created with --title "wingmate spike"
    expect(working.terminals.some((t) => t.title.startsWith("wingmate"))).toBe(false);
    expect(coordinatorRow(beforeRestart(), working.terminals, working.fleetRow)).toEqual(working.agent);
    expect(coordinatorLiveness(beforeRestart(), working.terminals, working.fleetRow)).toBe("working");
    const idle = captured("idle");
    expect(coordinatorLiveness(beforeRestart(), idle.terminals, idle.fleetRow)).toBe("idle");
    const codex = agentAt("tab7:leaf7", "done");
    for (const a of codex.agents) a.agentType = "codex";
    const moved = { ...term, handle: "term_77", tabId: "tab7", leafId: "leaf7", title: "✳ Codex" };
    expect(coordinatorRow(beforeRestart(), [moved], codex)).toMatchObject({ handle: "term_77" });
  });

  test("never a guess: a role agent of the child Run, a bare shell or another agent kind is no coordinator; two live agent terminals are ambiguous (unverifiable); none is exited", () => {
    const { terminals, fleetRow, agent } = captured("working");
    const roles = new Set([agent.handle]);
    expect(coordinatorRow(beforeRestart(), terminals, fleetRow, roles)).toBeUndefined();
    expect(coordinatorLiveness(beforeRestart(), terminals, fleetRow, undefined, roles)).toBe("exited");
    const shellsOnly = { ...fleetRow, agents: [] };
    expect(coordinatorRow(beforeRestart(), terminals, shellsOnly)).toBeUndefined(); // Orca's default shell: no agent
    const antigravity = {
      ...fleetRow,
      agents: fleetRow.agents.map((a) => ({ ...a, agentType: "antigravity" })),
    };
    expect(coordinatorRow(beforeRestart(), terminals, antigravity)).toBeUndefined();
    const twin = { ...agent, handle: "term_twin", leafId: "leaf-twin", title: "✳ Another session" };
    const both = {
      ...fleetRow,
      agents: [
        ...fleetRow.agents,
        ...fleetRow.agents.map((a) => ({ ...a, paneKey: `${twin.tabId}:${twin.leafId}` })),
      ],
    };
    expect(coordinatorRow(beforeRestart(), [...terminals, twin], both)).toBe("ambiguous");
    expect(coordinatorLiveness(beforeRestart(), [...terminals, twin], both)).toBe("unverifiable");
    expect(coordinatorRow(beforeRestart(), [...terminals, twin], both, new Set([twin.handle]))).toEqual(
      agent,
    );
    expect(coordinatorLiveness(beforeRestart(), [], { ...fleetRow, agents: [] })).toBe("exited");
    const fresh = rec();
    fresh.coordinator.terminalHandle = null;
    expect(coordinatorRow(fresh, terminals, fleetRow)).toBeUndefined(); // never launched: nothing is adopted here
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
