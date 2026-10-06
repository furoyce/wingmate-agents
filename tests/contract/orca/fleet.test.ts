import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { joinPane, parseFleet, parseRateLimits, parseTerminals } from "../../../src/orca/fleet";

const read = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PANE = /^[0-9a-f-]+:[0-9a-f-]+$/;

describe("fleet parsing (contract against the scrubbed Task 0 captures)", () => {
  test("parses worktree ps rows and agent entries, normalizing epoch ms to ISO", () => {
    const raw = read("tests/fixtures/orca/worktree-ps.json") as { result: { totalCount: number } };
    const f = parseFleet(raw);
    expect(f.truncated).toBe(false);
    expect(f.omittedHostIds).toEqual([]);
    expect(f.worktrees.length).toBeGreaterThan(0);
    expect(f.worktrees.length).toBe(raw.result.totalCount);
    for (const w of f.worktrees) {
      expect(w.worktreeId).toContain("::");
      expect(w.branch).not.toMatch(/^refs\/heads\//);
      expect(typeof w.liveTerminalCount).toBe("number");
      if (w.lastOutputAt !== null) expect(w.lastOutputAt).toMatch(ISO);
    }
    const withAgent = f.worktrees.find((w) => w.agents.length > 0);
    expect(withAgent).toBeDefined();
    const a = withAgent?.agents[0];
    expect(a?.paneKey).toMatch(PANE);
    expect(["working", "done"]).toContain(a?.state ?? "");
    expect(a?.stateStartedAt).toMatch(ISO);
    expect(a?.updatedAt).toMatch(ISO);
  });

  test("the working/idle/exited snapshots carry the liveness vocabulary", () => {
    const working = parseFleet(read("tests/fixtures/orca/worktree-ps-working.json"));
    const idle = parseFleet(read("tests/fixtures/orca/worktree-ps-idle.json"));
    const exited = parseFleet(read("tests/fixtures/orca/worktree-ps-exited.json"));
    expect(working.worktrees[0]?.agents[0]?.state).toBe("working");
    expect(idle.worktrees[0]?.agents[0]?.state).toBe("done");
    expect(exited.worktrees[0]?.agents).toEqual([]);
    expect(exited.worktrees[0]?.liveTerminalCount).toBe(0);
  });

  test("parses terminal rows and derives the pane key; agentIdentity is not required", () => {
    const rows = parseTerminals(read("tests/fixtures/orca/terminal-list-sample.json"));
    expect(rows.length).toBeGreaterThan(0);
    const first = rows[0];
    if (!first) throw new Error("fixture has no terminal rows");
    expect(first.handle).toMatch(/^term_/);
    expect(joinPane(first)).toBe(`${first.tabId}:${first.leafId}`);
    for (const r of rows) {
      expect(r.worktreeId).toContain("::");
      if (r.lastOutputAt !== null) expect(r.lastOutputAt).toMatch(ISO);
    }
    const shellRows = parseTerminals(read("tests/fixtures/orca/terminal-list-working.json"));
    expect(shellRows.length).toBe(2);
  });

  test("a working agent's paneKey joins the terminal row of the same snapshot", () => {
    const fleet = parseFleet(read("tests/fixtures/orca/worktree-ps-working.json"));
    const terms = parseTerminals(read("tests/fixtures/orca/terminal-list-working.json"));
    const paneKey = fleet.worktrees[0]?.agents[0]?.paneKey;
    expect(paneKey).toBeDefined();
    expect(terms.map(joinPane)).toContain(paneKey ?? "");
  });

  test("an empty terminal list parses to no rows", () => {
    expect(parseTerminals(read("tests/fixtures/orca/terminal-list-exited.json"))).toEqual([]);
  });

  test("parses account list into windows per provider and skips non-provider keys", () => {
    const rl = parseRateLimits(read("tests/fixtures/orca/account-list.json"));
    expect(rl.claude?.status).toBe("ok");
    expect(rl.claude?.windows.weekly?.windowMinutes).toBe(10080);
    expect(rl.claude?.windows.session).toBeDefined();
    expect(typeof rl.claude?.updatedAt).toBe("number");
    expect(rl.codex).toBeDefined();
    expect(rl.minimaxCookieConfigured).toBeUndefined();
    expect(rl.claudeTarget).toBeUndefined();
  });

  test("a partial fleet read is flagged", () => {
    const j = read("tests/fixtures/orca/worktree-ps.json") as {
      result: { hostScope: { omittedHostIds: string[] } };
    };
    j.result.hostScope.omittedHostIds = ["ssh-1"];
    expect(parseFleet(j).omittedHostIds).toEqual(["ssh-1"]);
  });

  test("a non-envelope or malformed payload is rejected, never defaulted", () => {
    expect(() => parseFleet({ nope: true })).toThrow();
    expect(() => parseFleet({ ok: true, result: { worktrees: [{ worktreeId: 1 }] } })).toThrow();
    expect(() => parseTerminals({ ok: true, result: {} })).toThrow();
  });
});
