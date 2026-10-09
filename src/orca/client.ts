import { z } from "zod";
// src/orca/client.ts — OrcaPort over the `orca` CLI. argv builders live in `argvFor` and result mappers are static so
// tests cover both without spawning Orca. Result shapes follow spike results §4 (nested result.worktree/terminal/wait/send.prompt).
import type {
  AutomationRow,
  FleetSnapshot,
  OrcaPort,
  RateLimits,
  SendReceipt,
  TerminalRow,
  WorkerRow,
} from "../ports";
import { OrcaError, type OrcaOptions, orca } from "./cli";
import { parseCleanupTerminals, parseFleet, parseRateLimits, parseTerminals } from "./fleet";

type R = Record<string, unknown>;
const rec = (v: unknown): R | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as R) : undefined;
const str = (v: unknown): string => (v == null ? "" : String(v));
const shortBranch = (b: unknown) => str(b).replace(/^refs\/heads\//, "");
/** Validate the identity fields of an `ok:true` result: an unexpected shape is an error with context, never a silent default. */
function shape<T>(verb: string, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const fields = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
  throw new OrcaError("orca_shape", `${verb}: missing or invalid ${fields}`, value);
}
const PANE_KEY = /^[^:]+:[^:]+$/;

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
      // the long-lived dispatcher worktree and doctor's probe worktree belong to no issue (§4.3)
      ...(a.linearIssue ? ["--linear-issue", a.linearIssue] : []),
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
    terminalKeys: (h: string, k: { text?: string; enter?: boolean }) => {
      if (k.text === undefined && !k.enter) throw new Error("terminalKeys needs text and/or enter");
      return [
        "terminal",
        "send",
        "--terminal",
        h,
        ...(k.text !== undefined ? ["--text", k.text] : []),
        ...(k.enter ? ["--enter"] : []),
      ];
    },
    orchestrationSend: (to: string, subject: string, body: string) => {
      if (!to.startsWith("run:"))
        throw new Error(`orchestrationSend only targets run:<id> mailboxes, got ${to}`);
      return ["orchestration", "send", "--to", to, "--type", "status", "--subject", subject, "--body", body];
    },
  };

  // --- result mappers (spike results §4) ---
  static mapTerminalCreate(r: R): { handle: string; tabId: string; leafId: string } {
    const t = shape(
      "terminal create",
      z.object({
        handle: z.string().min(1),
        tabId: z.string().min(1).optional(),
        leafId: z.string().min(1).optional(),
        paneKey: z.string().regex(PANE_KEY).optional(),
      }),
      rec(r.terminal) ?? r,
    );
    const pane = t.paneKey?.split(":") ?? [];
    const tabId = t.tabId ?? pane[0];
    const leafId = t.leafId ?? pane[1];
    if (!tabId || !leafId)
      throw new OrcaError("orca_shape", "terminal create: missing paneKey or tabId/leafId", r);
    return { handle: t.handle, tabId, leafId };
  }
  static mapWorktreeCreate(r: R): { id: string; path: string } {
    const w = shape(
      "worktree create",
      z.object({ id: z.string().min(1), path: z.string().min(1) }),
      rec(r.worktree) ?? r,
    );
    return { id: w.id, path: w.path };
  }
  static mapWait(r: R): { satisfied: boolean; blockedReason?: string } {
    const w = shape(
      "terminal wait",
      z.object({ satisfied: z.boolean(), blockedReason: z.string().nullish() }),
      rec(r.wait) ?? r,
    );
    return {
      satisfied: w.satisfied,
      ...(typeof w.blockedReason === "string" ? { blockedReason: w.blockedReason } : {}),
    };
  }
  static mapSend(r: R): SendReceipt {
    const pr = shape(
      "terminal send",
      z.object({ stages: z.array(z.string()), requestId: z.string().nullish() }),
      rec(rec(r.send)?.prompt) ?? r,
    );
    return {
      stage: pr.stages.includes("turn_started") ? "turn_started" : "input_accepted",
      requestId: pr.requestId ?? null,
    };
  }
  /** `worktree current` (spike §4: nested `result.worktree.{id, repoId, branch, path, …}`). */
  static mapWorktreeCurrent(r: R): { repoId: string; worktreeId: string; path: string; head: string | null } {
    const row = rec(r.worktree) ?? r;
    const w = shape(
      "worktree current",
      z.object({ id: z.string().min(1), repoId: z.string().min(1), path: z.string().min(1) }),
      row,
    );
    // R34: only a full object id (SHA-1 or SHA-256) — doctor's probe creates its scratch worktree at this commit
    const head =
      typeof row.head === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(row.head) ? row.head : null;
    return { repoId: w.repoId, worktreeId: w.id, path: w.path, head };
  }
  /** `automations list` rows (spike §4 row keys); a row without an id or name is `orca_shape`. */
  static mapAutomations(r: R): AutomationRow[] {
    const rows = shape(
      "automations list",
      z.array(
        z
          .object({
            id: z.string().min(1),
            name: z.string(),
            enabled: z.boolean().optional(),
            nextRunAt: z.number().nullish(),
            lastRunAt: z.number().nullish(),
            prompt: z.string().nullish(),
            precheck: z
              .object({ command: z.string().nullish(), timeoutSeconds: z.number().nullish() })
              .passthrough()
              .nullish(),
            workspaceMode: z.string().nullish(),
          })
          .passthrough(),
      ),
      Array.isArray(r.automations) ? r.automations : [],
    );
    return rows.map((a) => ({
      id: a.id,
      name: a.name,
      enabled: a.enabled === true,
      nextRunAt: a.nextRunAt ?? null,
      lastRunAt: a.lastRunAt ?? null,
      prompt: a.prompt ?? null,
      precheckCommand: a.precheck?.command ?? null,
      precheckTimeoutSec: a.precheck?.timeoutSeconds ?? null,
      workspaceMode: a.workspaceMode ?? null,
    }));
  }
  /** `automations create` (not exercised live in Task 0): the new id at `result.automation.id` or `result.id`. */
  static mapAutomationCreate(r: R): { id: string } {
    const a = shape("automations create", z.object({ id: z.string().min(1) }), rec(r.automation) ?? r);
    return { id: a.id };
  }
  static mapWorktreeShow(id: string, r: R): { id: string; path: string; branch: string; head: string } {
    const w = shape(
      "worktree show",
      z.object({ path: z.string().min(1) }).passthrough(),
      rec(r.worktree) ?? r,
    );
    return { id, path: w.path, branch: shortBranch(w.branch), head: str(w.head) };
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

  private call = (args: string[], timeoutMs?: number, cwd?: string): Promise<R> =>
    orca(args, { ...this.opts, ...(timeoutMs ? { timeoutMs } : {}), ...(cwd ? { cwd } : {}) }).then(
      (v) => rec(v) ?? {},
    );

  async worktreePs(): Promise<FleetSnapshot> {
    return parseFleet({ ok: true, result: await this.call(["worktree", "ps"], 20_000) });
  }
  async worktreeCurrent(
    cwd: string,
  ): Promise<{ repoId: string; worktreeId: string; path: string; head: string | null }> {
    return OrcaClient.mapWorktreeCurrent(await this.call(["worktree", "current"], 15_000, cwd));
  }
  async terminalList(wt: string): Promise<TerminalRow[]> {
    return parseTerminals({
      ok: true,
      result: await this.call(["terminal", "list", "--worktree", `id:${wt}`], 15_000),
    });
  }
  async cleanupTerminals(wt: string): Promise<{ complete: boolean; terminals: TerminalRow[] }> {
    return parseCleanupTerminals(
      {
        ok: true,
        result: await this.call(["terminal", "list", "--worktree", `id:${wt}`], 15_000),
      },
      wt,
    );
  }
  async accountList(): Promise<RateLimits> {
    return parseRateLimits({ ok: true, result: await this.call(["account", "list"], 15_000) });
  }
  async worktreeCreate(
    a: Parameters<OrcaClient["argvFor"]["worktreeCreate"]>[0],
  ): Promise<{ id: string; path: string }> {
    return OrcaClient.mapWorktreeCreate(await this.call(this.argvFor.worktreeCreate(a), 120_000));
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
  async cleanupWorkers(runId: string): Promise<{ complete: boolean; workers: WorkerRow[] }> {
    const result = await this.call(
      ["orchestration", "worker-list", "--run", runId, "--include-remote"],
      30_000,
    );
    return OrcaClient.mapCleanupWorkers(runId, result);
  }
  static mapCleanupWorkers(runId: string, result: R): { complete: boolean; workers: WorkerRow[] } {
    // Pagination or an old adapter without an explicit completion marker is insufficient evidence.
    const page = rec(result.page);
    const scope = rec(result.scope);
    const workers = OrcaClient.mapWorkers(runId, result);
    const complete =
      page?.hasMore === false &&
      scope?.runId === runId &&
      scope?.includeRemote === true &&
      Array.isArray(scope.omittedHostIds) &&
      scope.omittedHostIds.length === 0 &&
      Array.isArray(result.workers) &&
      workers.length === result.workers.length &&
      workers.every((w) => w.dispatchId && w.taskId && w.runId === runId);
    return { complete, workers };
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
  async automationsList(): Promise<AutomationRow[]> {
    return OrcaClient.mapAutomations(await this.call(["automations", "list"]));
  }
  async automationsCreate(flags: string[]): Promise<{ id: string }> {
    return OrcaClient.mapAutomationCreate(await this.call(["automations", "create", ...flags]));
  }
  async automationsEdit(id: string, flags: string[]): Promise<void> {
    await this.call(["automations", "edit", id, ...flags]);
  }
}
