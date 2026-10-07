import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrcaError } from "../../../src/orca/cli";
import { OrcaClient } from "../../../src/orca/client";

const client = () => new OrcaClient({ bin: "/bin/true" });

describe("OrcaClient argv construction (never spawns Orca)", () => {
  test("worktreeCreate builds the §5.4 step 3 command", () => {
    expect(
      client().argvFor.worktreeCreate({
        repoId: "r1",
        name: "wm-jrf-404",
        baseBranch: "origin/main",
        linearIssue: "JRF-404",
        comment: "wingmate: claimed",
      }),
    ).toEqual([
      "worktree",
      "create",
      "--repo",
      "id:r1",
      "--name",
      "wm-jrf-404",
      "--no-parent",
      "--base-branch",
      "origin/main",
      "--linear-issue",
      "JRF-404",
      "--comment",
      "wingmate: claimed",
      "--setup",
      "skip",
    ]);
  });
  test("terminalCreate targets the worktree by id and passes the command verbatim", () => {
    expect(client().argvFor.terminalCreate("wt1", "wingmate JRF-404", "exec claude --model 'x[1m]'")).toEqual(
      [
        "terminal",
        "create",
        "--worktree",
        "id:wt1",
        "--title",
        "wingmate JRF-404",
        "--command",
        "exec claude --model 'x[1m]'",
      ],
    );
  });
  test("terminalWait uses --for and --timeout-ms", () => {
    expect(client().argvFor.terminalWait("term_1", "tui-idle", 120000)).toEqual([
      "terminal",
      "wait",
      "--terminal",
      "term_1",
      "--for",
      "tui-idle",
      "--timeout-ms",
      "120000",
    ]);
  });
  test("terminalSend passes --wait-submit and the retry request", () => {
    expect(client().argvFor.terminalSend("term_1", "hello", 10, "01H")).toEqual([
      "terminal",
      "send",
      "--terminal",
      "term_1",
      "--text",
      "hello",
      "--enter",
      "--wait-submit",
      "10",
      "--retry-request",
      "01H",
    ]);
    expect(client().argvFor.terminalSend("term_1", "hello", 10)).toEqual([
      "terminal",
      "send",
      "--terminal",
      "term_1",
      "--text",
      "hello",
      "--enter",
      "--wait-submit",
      "10",
    ]);
  });
  test("terminalKeys sends raw keystrokes without --wait-submit (trust dialog answer)", () => {
    expect(client().argvFor.terminalKeys("term_1", { text: "\x1b[B" })).toEqual([
      "terminal",
      "send",
      "--terminal",
      "term_1",
      "--text",
      "\x1b[B",
    ]);
    expect(client().argvFor.terminalKeys("term_1", { enter: true })).toEqual([
      "terminal",
      "send",
      "--terminal",
      "term_1",
      "--enter",
    ]);
  });
  test("orchestrationSend addresses a run mailbox, never a dispatch", () => {
    expect(client().argvFor.orchestrationSend("run:run_1", "s", "b")).toEqual([
      "orchestration",
      "send",
      "--to",
      "run:run_1",
      "--type",
      "status",
      "--subject",
      "s",
      "--body",
      "b",
    ]);
    expect(() => client().argvFor.orchestrationSend("dispatch:ctx_1", "s", "b")).toThrow(/run:/);
  });
});

describe("OrcaClient result mapping (spike results §4 shapes)", () => {
  test("maps nested result shapes for create/wait/send/show/preview", () => {
    expect(
      OrcaClient.mapTerminalCreate({ terminal: { handle: "term_9", tabId: "tab", paneKey: "tab:leaf" } }),
    ).toEqual({ handle: "term_9", tabId: "tab", leafId: "leaf" });
    expect(
      OrcaClient.mapWait({ wait: { satisfied: false, blockedReason: "agent-trust-workspace" } }),
    ).toEqual({ satisfied: false, blockedReason: "agent-trust-workspace" });
    expect(OrcaClient.mapWait({ wait: { satisfied: true } })).toEqual({ satisfied: true });
    expect(
      OrcaClient.mapSend({
        send: { prompt: { stages: ["input_accepted", "turn_started"], requestId: "req_1" } },
      }),
    ).toEqual({ stage: "turn_started", requestId: "req_1" });
    expect(
      OrcaClient.mapSend({ send: { prompt: { stages: ["input_accepted"], requestId: "req_2" } } }),
    ).toEqual({ stage: "input_accepted", requestId: "req_2" });
    expect(
      OrcaClient.mapWorktreeShow("wt1", { worktree: { path: "/p", branch: "refs/heads/wm-x", head: "abc" } }),
    ).toEqual({ id: "wt1", path: "/p", branch: "wm-x", head: "abc" });
    expect(OrcaClient.mapPreview({ terminal: { preview: "zsh% " } })).toBe("zsh% ");
  });
  test("maps worker rows with the projection liveness verdict", () => {
    const rows = OrcaClient.mapWorkers("run_1", {
      workers: [
        {
          dispatchId: "ctx_1",
          taskId: "task_1",
          workerState: "running",
          dispatchStatus: "active",
          agentTerminalHandle: "term_w",
          projection: { liveness: { verdict: "live" } },
        },
      ],
    });
    expect(rows).toEqual([
      {
        dispatchId: "ctx_1",
        taskId: "task_1",
        runId: "run_1",
        workerState: "running",
        dispatchStatus: "active",
        agentTerminalHandle: "term_w",
        verdict: "live",
      },
    ]);
    expect(
      OrcaClient.mapWorkers("run_1", {
        workers: [{ dispatchId: "ctx_2", taskId: "t", projection: { liveness: { verdict: "bogus" } } }],
      })[0]?.verdict,
    ).toBeNull();
  });
});

describe("OrcaClient result mappers reject unexpected shapes (orca_shape, never a silent default)", () => {
  const shapeError = (fn: () => unknown, verb: string) => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(OrcaError);
      expect((e as OrcaError).code).toBe("orca_shape");
      expect((e as OrcaError).message).toContain(verb);
      return;
    }
    throw new Error(`expected orca_shape for ${verb}`);
  };
  test("terminal create without a handle or without pane identity", () => {
    shapeError(
      () => OrcaClient.mapTerminalCreate({ terminal: { tabId: "tab", paneKey: "tab:leaf" } }),
      "terminal create",
    );
    shapeError(() => OrcaClient.mapTerminalCreate({ terminal: { handle: "term_1" } }), "terminal create");
    shapeError(
      () => OrcaClient.mapTerminalCreate({ terminal: { handle: "term_1", paneKey: "no-colon" } }),
      "terminal create",
    );
  });
  test("worktree create without id or path; worktree show without path", () => {
    shapeError(() => OrcaClient.mapWorktreeCreate({ worktree: { path: "/p" } }), "worktree create");
    shapeError(
      () => OrcaClient.mapWorktreeCreate({ worktree: { id: "r::/p", path: "" } }),
      "worktree create",
    );
    shapeError(
      () => OrcaClient.mapWorktreeShow("wt", { worktree: { branch: "refs/heads/x" } }),
      "worktree show",
    );
  });
  test("terminal wait without a boolean satisfied; terminal send without stages", () => {
    shapeError(
      () => OrcaClient.mapWait({ wait: { blockedReason: "agent-trust-workspace" } }),
      "terminal wait",
    );
    shapeError(() => OrcaClient.mapWait({ wait: { satisfied: "yes" } }), "terminal wait");
    shapeError(() => OrcaClient.mapSend({ send: { prompt: { requestId: "req_1" } } }), "terminal send");
  });
  test("valid shapes still map: worktree create, empty stages, null requestId", () => {
    expect(OrcaClient.mapWorktreeCreate({ worktree: { id: "r::/p", path: "/p" } })).toEqual({
      id: "r::/p",
      path: "/p",
    });
    expect(OrcaClient.mapSend({ send: { prompt: { stages: [], requestId: null } } })).toEqual({
      stage: "input_accepted",
      requestId: null,
    });
    expect(OrcaClient.mapTerminalCreate({ terminal: { handle: "term_2", tabId: "t", leafId: "l" } })).toEqual(
      {
        handle: "term_2",
        tabId: "t",
        leafId: "l",
      },
    );
  });
  test("terminalKeys with neither text nor enter throws instead of sending a bare command", () => {
    expect(() => new OrcaClient({ bin: "/bin/true" }).argvFor.terminalKeys("term_1", {})).toThrow(
      /text|enter/,
    );
  });
});

describe("Task 12: worktree current, automations and the dispatcher worktree", () => {
  // spike results §3.1/§4: `worktree current|show|create` nest the row under `result.worktree`, whose `id` is `<repoId>::<path>`
  const SPIKE_CURRENT = {
    worktree: {
      id: "1f1e7f87-e283-4432-beaf-92efba56ddb9::/Users/owner/orca/workspaces/wingmate-agents/orca-linear-wingmate-agents",
      repoId: "1f1e7f87-e283-4432-beaf-92efba56ddb9",
      branch: "refs/heads/orca-linear-wingmate-agents",
      path: "/Users/owner/orca/workspaces/wingmate-agents/orca-linear-wingmate-agents",
      head: "4856101c0ffee",
      displayName: "orca-linear-wingmate-agents",
    },
  };
  test("worktreeCurrent maps result.worktree.{id, repoId, path} (spike §4) and runs `worktree current` in the given cwd", async () => {
    expect(OrcaClient.mapWorktreeCurrent(SPIKE_CURRENT)).toEqual({
      repoId: "1f1e7f87-e283-4432-beaf-92efba56ddb9",
      worktreeId:
        "1f1e7f87-e283-4432-beaf-92efba56ddb9::/Users/owner/orca/workspaces/wingmate-agents/orca-linear-wingmate-agents",
      path: "/Users/owner/orca/workspaces/wingmate-agents/orca-linear-wingmate-agents",
    });
    // a fake orca that answers with the envelope and the cwd it ran in: the client passes cwd and parses the nested row
    const dir = mkdtempSync(join(tmpdir(), "wm-orca-current-"));
    const bin = join(dir, "orca");
    writeFileSync(
      bin,
      `#!/bin/sh\nif [ "$1 $2 $3" = "worktree current --json" ]; then printf '{"id":"x","ok":true,"result":{"worktree":{"id":"r1::%s","repoId":"r1","path":"%s","branch":"refs/heads/b"}}}' "$PWD" "$PWD"; else echo boom >&2; exit 3; fi\n`,
    );
    chmodSync(bin, 0o755);
    const real = realpathSync(dir);
    expect(await new OrcaClient({ bin }).worktreeCurrent(dir)).toEqual({
      repoId: "r1",
      worktreeId: `r1::${real}`,
      path: real,
    });
  });
  test("worktreeCurrent refuses a row without id, repoId or path (orca_shape), never a silent default", () => {
    for (const missing of ["id", "repoId", "path"] as const) {
      const w: Record<string, unknown> = { ...SPIKE_CURRENT.worktree };
      delete w[missing];
      expect(() => OrcaClient.mapWorktreeCurrent({ worktree: w })).toThrow(/worktree current/);
    }
  });
  test("automations list maps id, name, enabled, prompt, precheck command and workspace mode (spike §4 row keys)", () => {
    const fixture = JSON.parse(readFileSync("tests/fixtures/orca/automations-list.json", "utf8")) as {
      result: Record<string, unknown>;
    };
    const rows = OrcaClient.mapAutomations(fixture.result);
    expect(rows.length).toBe(3);
    expect(rows[0]).toEqual({
      id: "2631faa3-9ab9-4b64-81d8-9ced947506c4",
      name: "automation-1",
      enabled: false,
      nextRunAt: 1790949600000,
      lastRunAt: 1790944087491,
      prompt: "REDACTED",
      precheckCommand: "REDACTED",
      precheckTimeoutSec: 60,
      workspaceMode: "new_per_run",
    });
    expect(() => OrcaClient.mapAutomations({ automations: [{ name: "no id" }] })).toThrow(/automations list/);
  });
  test("automations create returns the new id from result.automation.id or result.id; anything else is orca_shape", () => {
    expect(OrcaClient.mapAutomationCreate({ automation: { id: "a-1" } })).toEqual({ id: "a-1" });
    expect(OrcaClient.mapAutomationCreate({ id: "a-2" })).toEqual({ id: "a-2" });
    expect(() => OrcaClient.mapAutomationCreate({ automation: {} })).toThrow(/automations create/);
  });
  test("worktreeCreate omits --linear-issue when there is no issue (the long-lived dispatcher and doctor worktrees)", () => {
    const argv = client().argvFor.worktreeCreate({
      repoId: "r1",
      name: "wingmate-dispatcher",
      baseBranch: "origin/main",
      linearIssue: "",
      comment: "wingmate dispatcher (long-lived)",
    });
    expect(argv).not.toContain("--linear-issue");
    expect(argv).toEqual([
      "worktree",
      "create",
      "--repo",
      "id:r1",
      "--name",
      "wingmate-dispatcher",
      "--no-parent",
      "--base-branch",
      "origin/main",
      "--comment",
      "wingmate dispatcher (long-lived)",
      "--setup",
      "skip",
    ]);
  });
});
