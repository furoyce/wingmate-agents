// tests/fakes/fakeOrca.ts — in-memory OrcaPort: fleet rows, terminals, workers and receipts are programmable
import type {
  FleetRow,
  FleetSnapshot,
  OrcaPort,
  RateLimits,
  SendReceipt,
  TerminalRow,
  WorkerRow,
} from "../../src/ports";

export class FakeOrca implements OrcaPort {
  rows = new Map<string, FleetRow>();
  terminals = new Map<string, TerminalRow[]>();
  workers = new Map<string, WorkerRow[]>();
  rateLimits: RateLimits = {
    claude: {
      status: "ok",
      error: null,
      updatedAt: Date.now(),
      windows: {
        session: { usedPercent: 5, windowMinutes: 300, resetsAt: null },
        weekly: { usedPercent: 20, windowMinutes: 10080, resetsAt: null },
      },
      buckets: [],
    },
    codex: {
      status: "ok",
      error: null,
      updatedAt: Date.now(),
      windows: { weekly: { usedPercent: 10, windowMinutes: 10080, resetsAt: null } },
      buckets: [],
    },
  };
  calls: { verb: string; args: unknown }[] = [];
  partial = false;
  nextSendStage: SendReceipt["stage"] = "turn_started";
  nextWaitSatisfied = true;
  /** When set, `terminalWait` reports it as `blockedReason` (e.g. "agent-trust-workspace"). */
  nextBlockedReason: string | null = null;
  closed: string[] = [];
  removed: string[] = [];
  previews = new Map<string, string>();
  private seq = 0;

  private rec(verb: string, args: unknown) {
    this.calls.push({ verb, args });
  }

  async worktreePs(): Promise<FleetSnapshot> {
    this.rec("worktreePs", null);
    return {
      worktrees: [...this.rows.values()].map((r) => structuredClone(r)),
      truncated: false,
      omittedHostIds: this.partial ? ["ssh-1"] : [],
    };
  }
  async terminalList(wt: string) {
    this.rec("terminalList", wt);
    return structuredClone(this.terminals.get(wt) ?? []);
  }
  async accountList() {
    this.rec("accountList", null);
    return structuredClone(this.rateLimits);
  }
  async worktreeCreate(a: {
    repoId: string;
    name: string;
    baseBranch: string;
    linearIssue: string;
    comment: string;
  }) {
    this.rec("worktreeCreate", a);
    const id = `${a.repoId}::/wt/${a.name}`;
    this.rows.set(id, {
      worktreeId: id,
      repoId: a.repoId,
      path: `/wt/${a.name}`,
      branch: `furoyce/${a.name}`,
      displayName: a.name,
      linkedLinearIssue: a.linearIssue,
      status: "active",
      liveTerminalCount: 0,
      lastOutputAt: null,
      childWorktreeIds: [],
      agents: [],
    });
    this.terminals.set(id, []);
    return { id, path: `/wt/${a.name}` };
  }
  async worktreeShow(id: string) {
    const r = this.rows.get(id);
    if (!r) throw new Error("no worktree");
    return { id, path: r.path, branch: r.branch, head: "deadbeef" };
  }
  async worktreeSet(id: string, a: unknown) {
    this.rec("worktreeSet", { id, a });
  }
  async worktreeRm(id: string) {
    this.rec("worktreeRm", id);
    this.removed.push(id);
    this.rows.delete(id);
    this.terminals.delete(id);
  }
  async terminalCreate(wt: string, title: string, command: string) {
    this.rec("terminalCreate", { wt, title, command });
    const n = ++this.seq;
    const t: TerminalRow = {
      handle: `term_${n}`,
      tabId: `tab${n}`,
      leafId: `leaf${n}`,
      worktreeId: wt,
      title,
      lastOutputAt: null,
    };
    this.terminals.set(wt, [...(this.terminals.get(wt) ?? []), t]);
    const row = this.rows.get(wt);
    if (row) {
      row.liveTerminalCount++;
      row.agents.push({
        paneKey: `tab${n}:leaf${n}`,
        state: "working",
        agentType: command.includes("codex") ? "codex" : "claude",
        stateStartedAt: new Date().toISOString(),
        updatedAt: null,
      });
    }
    return { handle: t.handle, tabId: t.tabId, leafId: t.leafId };
  }
  async terminalWait(h: string, f: string, ms: number) {
    this.rec("terminalWait", { h, f, ms });
    return {
      satisfied: this.nextWaitSatisfied,
      ...(this.nextBlockedReason ? { blockedReason: this.nextBlockedReason } : {}),
    };
  }
  async terminalKeys(h: string, k: { text?: string; enter?: boolean }) {
    this.rec("terminalKeys", { h, k });
    if (k.enter && this.nextBlockedReason === "agent-trust-workspace") {
      this.nextBlockedReason = null;
      this.nextWaitSatisfied = true;
    }
  }
  async terminalSend(h: string, text: string, w: number, retry?: string): Promise<SendReceipt> {
    this.rec("terminalSend", { h, text, w, retry });
    return { stage: this.nextSendStage, requestId: `req_${++this.seq}` };
  }
  async terminalClose(wt: string) {
    this.rec("terminalClose", wt);
    this.closed.push(wt);
    this.terminals.set(wt, []);
    const row = this.rows.get(wt);
    if (row) row.liveTerminalCount = 0;
    return { ok: true };
  }
  async terminalShowPreview(h: string) {
    return this.previews.get(h) ?? "";
  }
  async workerList(runId: string) {
    this.rec("workerList", runId);
    return structuredClone(this.workers.get(runId) ?? []);
  }
  async workerStop(d: string, retry: string) {
    this.rec("workerStop", { d, retry });
    for (const rows of this.workers.values()) {
      for (const w of rows) {
        if (w.dispatchId === d) {
          w.verdict = "exited";
          w.workerState = "stopped";
        }
      }
    }
    return { verdict: "exited" };
  }
  async workerAbandon(d: string) {
    this.rec("workerAbandon", d);
  }
  async workerRelease(d: string) {
    this.rec("workerRelease", d);
  }
  async orchestrationSend(to: string, subject: string, body: string) {
    this.rec("orchestrationSend", { to, subject, body });
  }
  async runList() {
    return [];
  }
  async automationsList() {
    return [];
  }
  async automationsCreate(args: string[]) {
    this.rec("automationsCreate", args);
    return { id: "auto-1" };
  }
  async automationsEdit(id: string, args: string[]) {
    this.rec("automationsEdit", { id, args });
  }

  // --- test helpers ---
  setAgentState(wt: string, paneKey: string, state: "working" | "done", at: string) {
    const a = this.rows.get(wt)?.agents.find((x) => x.paneKey === paneKey);
    if (a) {
      a.state = state;
      a.stateStartedAt = at;
    }
  }
  killTerminal(wt: string, handle: string) {
    this.terminals.set(
      wt,
      (this.terminals.get(wt) ?? []).filter((t) => t.handle !== handle),
    );
  }
}
