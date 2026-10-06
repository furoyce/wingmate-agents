import { describe, expect, test } from "bun:test";
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
