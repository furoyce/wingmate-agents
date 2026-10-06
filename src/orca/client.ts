// src/orca/client.ts — OrcaPort over the `orca` CLI. argv builders live in `argvFor` and result mappers are static so
// tests cover both without spawning Orca. Result shapes follow spike results §4 (nested result.worktree/terminal/wait/send.prompt).
import type { FleetSnapshot, OrcaPort, RateLimits, SendReceipt, TerminalRow, WorkerRow } from "../ports";
import { type OrcaOptions, orca } from "./cli";
import { parseFleet, parseRateLimits, parseTerminals } from "./fleet";

type R = Record<string, unknown>;
const rec = (v: unknown): R | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as R) : undefined;
const str = (v: unknown): string => (v == null ? "" : String(v));
const shortBranch = (b: unknown) => str(b).replace(/^refs\/heads\//, "");

export class OrcaClient implements OrcaPort {
  constructor(private opts: OrcaOptions = {}) {}

  readonly argvFor = {
    worktreeCreate: (a: {
      repoId: string;
      name: string;
      baseBranch: string;
      linearIssue: string;
      comment: string;
    }) => [
      "worktree",
      "create",
      "--repo",
      `id:${a.repoId}`,
      "--name",
      a.name,
      "--no-parent",
      "--base-branch",
      a.baseBranch,
      "--linear-issue",
      a.linearIssue,
      "--comment",
      a.comment,
      "--setup",
      "skip",
    ],
    terminalCreate: (wt: string, title: string, command: string) => [
      "terminal",
      "create",
      "--worktree",
      `id:${wt}`,
      "--title",
      title,
      "--command",
      command,
    ],
    terminalWait: (h: string, f: string, ms: number) => [
      "terminal",
      "wait",
      "--terminal",
      h,
      "--for",
      f,
      "--timeout-ms",
      String(ms),
    ],
    terminalSend: (h: string, text: string, waitSubmit: number, retry?: string) => [
      "terminal",
      "send",
      "--terminal",
      h,
      "--text",
      text,
      "--enter",
      "--wait-submit",
      String(waitSubmit),
      ...(retry ? ["--retry-request", retry] : []),
    ],
    terminalKeys: (h: string, k: { text?: string; enter?: boolean }) => [
      "terminal",
      "send",
      "--terminal",
      h,
      ...(k.text !== undefined ? ["--text", k.text] : []),
      ...(k.enter ? ["--enter"] : []),
    ],
    orchestrationSend: (to: string, subject: string, body: string) => {
      if (!to.startsWith("run:"))
        throw new Error(`orchestrationSend only targets run:<id> mailboxes, got ${to}`);
      return ["orchestration", "send", "--to", to, "--type", "status", "--subject", subject, "--body", body];
    },
  };

  // --- result mappers (spike results §4) ---
  static mapTerminalCreate(r: R): { handle: string; tabId: string; leafId: string } {
    const t = rec(r.terminal) ?? r;
    const pane = str(t.paneKey).split(":");
    return { handle: str(t.handle), tabId: str(t.tabId ?? pane[0]), leafId: str(t.leafId ?? pane[1]) };
  }
  static mapWait(r: R): { satisfied: boolean; blockedReason?: string } {
    const w = rec(r.wait) ?? r;
    return {
      satisfied: w.satisfied === true,
      ...(typeof w.blockedReason === "string" ? { blockedReason: w.blockedReason } : {}),
    };
  }
  static mapSend(r: R): SendReceipt {
    const pr = rec(rec(r.send)?.prompt) ?? r;
    const stages = Array.isArray(pr.stages)
      ? pr.stages.filter((s): s is string => typeof s === "string")
      : [];
    return {
      stage: stages.includes("turn_started") ? "turn_started" : "input_accepted",
      requestId: typeof pr.requestId === "string" ? pr.requestId : null,
    };
  }
  static mapWorktreeShow(id: string, r: R): { id: string; path: string; branch: string; head: string } {
    const w = rec(r.worktree) ?? r;
    return { id, path: str(w.path), branch: shortBranch(w.branch), head: str(w.head) };
  }
  static mapPreview(r: R): string {
    const t = rec(r.terminal) ?? r;
    return typeof t.preview === "string" ? t.preview : "";
  }
  static mapWorkers(runId: string, r: R): WorkerRow[] {
    const rows = Array.isArray(r.workers)
      ? r.workers.map((w) => rec(w)).filter((w): w is R => w !== undefined)
      : [];
    return rows.map((w) => {
      const v = rec(rec(w.projection)?.liveness)?.verdict;
      return {
        dispatchId: str(w.dispatchId),
        taskId: str(w.taskId),
        runId: typeof w.runId === "string" ? w.runId : runId,
        workerState: str(w.workerState),
        dispatchStatus: str(w.dispatchStatus),
        agentTerminalHandle: typeof w.agentTerminalHandle === "string" ? w.agentTerminalHandle : null,
        verdict: v === "live" || v === "unverifiable" || v === "exited" ? v : null,
      };
    });
  }

  private call = (args: string[], timeoutMs?: number): Promise<R> =>
    orca(args, { ...this.opts, ...(timeoutMs ? { timeoutMs } : {}) }).then((v) => rec(v) ?? {});

  async worktreePs(): Promise<FleetSnapshot> {
    return parseFleet({ ok: true, result: await this.call(["worktree", "ps"], 20_000) });
  }
  async terminalList(wt: string): Promise<TerminalRow[]> {
    return parseTerminals({
      ok: true,
      result: await this.call(["terminal", "list", "--worktree", `id:${wt}`], 15_000),
    });
  }
  async accountList(): Promise<RateLimits> {
    return parseRateLimits({ ok: true, result: await this.call(["account", "list"], 15_000) });
  }
  async worktreeCreate(
    a: Parameters<OrcaClient["argvFor"]["worktreeCreate"]>[0],
  ): Promise<{ id: string; path: string }> {
    const r = await this.call(this.argvFor.worktreeCreate(a), 120_000);
    const w = rec(r.worktree) ?? r;
    return { id: str(w.id), path: str(w.path) };
  }
  async worktreeShow(id: string): Promise<{ id: string; path: string; branch: string; head: string }> {
    return OrcaClient.mapWorktreeShow(id, await this.call(["worktree", "show", "--worktree", `id:${id}`]));
  }
  async worktreeSet(
    id: string,
    a: { workspaceStatus?: string; comment?: string; linearIssue?: string | null },
  ): Promise<void> {
    const args = ["worktree", "set", "--worktree", `id:${id}`];
    if (a.workspaceStatus) args.push("--workspace-status", a.workspaceStatus);
    if (a.comment !== undefined) args.push("--comment", a.comment);
    if (a.linearIssue !== undefined) args.push("--linear-issue", a.linearIssue ?? "null");
    await this.call(args);
  }
  async worktreeRm(id: string): Promise<void> {
    await this.call(["worktree", "rm", "--worktree", `id:${id}`], 120_000);
  }
  async terminalCreate(
    wt: string,
    title: string,
    command: string,
  ): Promise<{ handle: string; tabId: string; leafId: string }> {
    return OrcaClient.mapTerminalCreate(
      await this.call(this.argvFor.terminalCreate(wt, title, command), 60_000),
    );
  }
  async terminalWait(
    h: string,
    f: "tui-idle" | "exit",
    ms: number,
  ): Promise<{ satisfied: boolean; blockedReason?: string }> {
    return OrcaClient.mapWait(await this.call(this.argvFor.terminalWait(h, f, ms), ms + 10_000));
  }
  async terminalKeys(h: string, k: { text?: string; enter?: boolean }): Promise<void> {
    await this.call(this.argvFor.terminalKeys(h, k), 15_000);
  }
  async terminalSend(h: string, text: string, waitSubmit: number, retry?: string): Promise<SendReceipt> {
    return OrcaClient.mapSend(
      await this.call(this.argvFor.terminalSend(h, text, waitSubmit, retry), (waitSubmit + 20) * 1000),
    );
  }
  async terminalClose(wt: string): Promise<{ ok: boolean }> {
    try {
      await this.call(["terminal", "close", "--worktree", `id:${wt}`, "--all"], 60_000);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }
  async terminalShowPreview(h: string): Promise<string> {
    return OrcaClient.mapPreview(await this.call(["terminal", "show", "--terminal", h]));
  }
  async workerList(runId: string): Promise<WorkerRow[]> {
    return OrcaClient.mapWorkers(
      runId,
      await this.call(["orchestration", "worker-list", "--run", runId], 30_000),
    );
  }
  async workerStop(d: string, retry: string): Promise<{ verdict: string }> {
    const r = await this.call(
      ["orchestration", "worker-stop", "--dispatch", d, "--retry-request", retry],
      60_000,
    );
    const v = rec(r.liveness)?.verdict ?? rec(rec(r.worker)?.liveness)?.verdict ?? r.verdict;
    return { verdict: typeof v === "string" ? v : "unverifiable" };
  }
  async workerAbandon(d: string): Promise<void> {
    await this.call(["orchestration", "worker-abandon", "--dispatch", d]);
  }
  async workerRelease(d: string): Promise<void> {
    await this.call(["orchestration", "worker-release", "--dispatch", d]);
  }
  async orchestrationSend(to: string, subject: string, body: string): Promise<void> {
    await this.call(this.argvFor.orchestrationSend(to, subject, body));
  }
  async runList(): Promise<{ id: string; coordinatorHandle: string | null }[]> {
    const r = await this.call(["orchestration", "run-list"]);
    const runs = Array.isArray(r.runs)
      ? r.runs.map((x) => rec(x)).filter((x): x is R => x !== undefined)
      : [];
    return runs.map((x) => ({
      id: str(x.id),
      coordinatorHandle: typeof x.coordinator_handle === "string" ? x.coordinator_handle : null,
    }));
  }
  async automationsList(): Promise<
    { id: string; name: string; enabled: boolean; nextRunAt: number | null; lastRunAt: number | null }[]
  > {
    const r = await this.call(["automations", "list"]);
    const rows = Array.isArray(r.automations)
      ? r.automations.map((x) => rec(x)).filter((x): x is R => x !== undefined)
      : [];
    return rows.map((a) => ({
      id: str(a.id),
      name: str(a.name),
      enabled: a.enabled === true,
      nextRunAt: typeof a.nextRunAt === "number" ? a.nextRunAt : null,
      lastRunAt: typeof a.lastRunAt === "number" ? a.lastRunAt : null,
    }));
  }
  async automationsCreate(args: string[]): Promise<{ id: string }> {
    const r = await this.call(["automations", "create", ...args]);
    return { id: str(rec(r.automation)?.id ?? r.id) };
  }
  async automationsEdit(id: string, args: string[]): Promise<void> {
    await this.call(["automations", "edit", id, ...args]);
  }
}
