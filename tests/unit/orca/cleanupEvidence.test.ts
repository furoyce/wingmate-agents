import { expect, test } from "bun:test";
import { GhCli } from "../../../src/gh/cli";
import { OrcaClient } from "../../../src/orca/client";
import { parseCleanupTerminals, parseFleet } from "../../../src/orca/fleet";
import { fakeExec } from "../../fakes/fakeExec";

test("fleet compatibility defaults do not become cleanup completeness evidence", () => {
  const row = {
    worktreeId: "wt",
    repoId: "repo",
    path: "/owned",
    liveTerminalCount: 0,
    agents: [],
    childWorktreeIds: [],
  };
  const result = { worktrees: [row], truncated: false, hostScope: { omittedHostIds: [] } };
  expect(parseFleet({ ok: true, result }).cleanupVerified).toBe(true);
  for (const incomplete of [
    { worktrees: [row] },
    { ...result, hostScope: {} },
    { ...result, worktrees: [{ worktreeId: "wt", repoId: "repo", path: "/owned" }] },
  ])
    expect(parseFleet({ ok: true, result: incomplete }).cleanupVerified).toBe(false);
});

test("worker adapter requires explicit full run/all-host/page proof, never an empty mapped default", () => {
  const result = {
    workers: [],
    page: { hasMore: false },
    scope: { runId: "run", includeRemote: true, omittedHostIds: [] },
  };
  expect(OrcaClient.mapCleanupWorkers("run", result).complete).toBe(true);
  for (const incomplete of [
    {},
    { workers: [] },
    { ...result, workers: null },
    { ...result, workers: [null] },
    { ...result, workers: [{}] },
    { ...result, page: { hasMore: true } },
    { ...result, scope: { ...result.scope, runId: "other" } },
    { ...result, scope: { runId: "run" } },
    { ...result, scope: { ...result.scope, includeRemote: false } },
    { ...result, scope: { ...result.scope, omittedHostIds: ["offline-host"] } },
  ])
    expect(OrcaClient.mapCleanupWorkers("run", incomplete).complete).toBe(false);
});

test("observed Orca 1.4.222 final page still cannot prove all-host worker coverage", () => {
  // Read-only coordinator capture: --include-remote does not add coverage fields to this runtime's DTO.
  const currentRuntime = {
    workers: [],
    scope: { run: "run", source: "flag" },
    page: { limit: 100, total: 0, hasMore: false, nextCursor: null },
  };
  expect(OrcaClient.mapCleanupWorkers("run", currentRuntime)).toEqual({ complete: false, workers: [] });
});

test("fresh open PR query requires successful complete JSON and never invokes creation", async () => {
  for (const kind of ["empty", "open", "failed", "truncated", "timeout", "malformed"]) {
    const exec = fakeExec([
      {
        match: () => true,
        reply: () => ({
          stdout:
            kind === "malformed"
              ? "not-json"
              : kind === "open"
                ? '[{"number":1,"url":"https://github.com/owner/repo/pull/1"}]'
                : "[]",
          code: kind === "failed" ? 1 : 0,
          truncated: kind === "truncated",
          timedOut: kind === "timeout",
        }),
      },
    ]);
    const gh = new GhCli(exec.exec);
    if (kind === "empty" || kind === "open")
      expect(await gh.hasOpenPr("owner/repo", "branch")).toBe(kind === "open");
    else await expect(gh.hasOpenPr("owner/repo", "branch")).rejects.toBeDefined();
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0]?.argv).toEqual([
      "gh",
      "pr",
      "list",
      "--repo",
      "owner/repo",
      "--head",
      "branch",
      "--state",
      "open",
      "--json",
      "number,url",
      "--limit",
      "1",
    ]);
    expect(exec.calls[0]?.opts.cwd).toBe("/");
  }
});

test("cleanup terminal observation preserves completeness and pins local worktree scope", () => {
  // Exact result keys/metadata from the coordinator's read-only Orca 1.4.222 capture.
  const terminal = {
    handle: "term-owned",
    tabId: "tab",
    leafId: "leaf",
    worktreeId: "wt",
    title: "",
    lastOutputAt: null,
  };
  const result = {
    terminals: [terminal],
    hostScope: { hostIds: ["local"], omittedHostIds: [] },
    topologyRevisions: { wt: 1 },
    totalCount: 1,
    truncated: false,
  };
  expect(parseCleanupTerminals({ ok: true, result }, "wt")).toMatchObject({
    complete: true,
    terminals: [terminal],
  });
  const empty = { ...result, terminals: [], totalCount: 0 };
  expect(parseCleanupTerminals({ ok: true, result: empty }, "wt")).toEqual({ complete: true, terminals: [] });
  for (const incomplete of [
    { terminals: [] },
    { ...empty, truncated: true },
    { ...empty, truncated: "false" },
    { ...empty, hostScope: undefined },
    { ...empty, hostScope: { hostIds: ["local"] } },
    { ...empty, hostScope: { hostIds: ["remote"], omittedHostIds: [] } },
    { ...empty, hostScope: { hostIds: ["local"], omittedHostIds: ["unreachable"] } },
    { ...empty, totalCount: 1 },
    { ...empty, totalCount: "0" },
    { ...result, terminals: [{ ...terminal, worktreeId: "foreign" }] },
  ])
    expect(parseCleanupTerminals({ ok: true, result: incomplete }, "wt").complete).toBe(false);
  expect(parseCleanupTerminals({ ok: false, result: empty }, "wt").complete).toBe(false);
  expect(() => parseCleanupTerminals({ ok: true, result: { ...empty, terminals: [{}] } }, "wt")).toThrow();
});
