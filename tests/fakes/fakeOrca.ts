// tests/fakes/fakeOrca.ts — in-memory OrcaPort: fleet rows, terminals, workers and receipts are programmable. With `root` set, a
// worktree is a real linked git worktree on disk (the kit, the outbox and the integrity check need real files and a real git).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { OrcaError } from "../../src/orca/cli";
import type {
  FleetRow,
  FleetSnapshot,
  OrcaPort,
  RateLimits,
  SendReceipt,
  TerminalRow,
  WorkerRow,
} from "../../src/ports";
import { run } from "../../src/shared/exec";

/** git for the fake's own repos: no user or system config, so the owner's settings never leak into a test. */
async function git(args: string[]): Promise<string> {
  const r = await run(["git", ...args], {
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (r.code !== 0) throw new Error(`fake orca: git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}
const ID = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"];

export class FakeOrca implements OrcaPort {
  rows = new Map<string, FleetRow>();
  terminals = new Map<string, TerminalRow[]>();
  workers = new Map<string, WorkerRow[]>();
  /** `orchestration run-list` rows (F8: a `run` intent is adopted only for a Run listed here with the coordinator's handle). */
  runs: { id: string; coordinatorHandle: string | null }[] = [];
  /** Runs `worker-list` cannot list (a deleted or made-up Run): the call fails as the CLI wrapper reports it. */
  failRuns = new Set<string>();
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
  /** When set to a verb, the next call of that verb throws once (crash/replay tests). */
  failNext: string | null = null;
  /** When set to a verb, the next call of that verb takes effect and then throws once (orca_timeout: the effect is real). */
  failAfter: string | null = null;
  /** Awaited after a call is recorded and before it acts: tests reach "into" a tick (lock reclaimed, stop requested). */
  onCall: ((verb: string, args: unknown) => void | Promise<void>) | null = null;
  /** Real worktrees live under `<root>/wt`, their repos under `<root>/repos/<repoId>` (null: paths only, nothing on disk). */
  root: string | null = null;
  /** Reports the git dirs of each real worktree (makeWorld hands them to FakeGit). */
  onWorktree: ((path: string, commonDir: string, gitDir: string) => void) | null = null;
  /** The clock agent states are stamped with (makeWorld: the world clock). */
  now = () => new Date().toISOString();
  closed: string[] = [];
  removed: string[] = [];
  previews = new Map<string, string>();
  private seq = 0;

  private tookEffect(verb: string) {
    if (this.failAfter !== verb) return;
    this.failAfter = null;
    throw new OrcaError("orca_timeout", `fake orca: ${verb} took effect, then timed out`);
  }

  private async rec(verb: string, args: unknown) {
    this.calls.push({ verb, args });
    if (this.failNext === verb) {
      this.failNext = null;
      throw new OrcaError("orca_unreachable", `fake orca failure: ${verb}`); // as the CLI wrapper reports a missing envelope
    }
    await this.onCall?.(verb, args);
  }

  /** A real linked worktree of the repo's main checkout (created on first use, one empty commit on `main`). */
  private async realWorktree(root: string, repoId: string, name: string, branch: string): Promise<string> {
    const main = join(root, "repos", repoId);
    if (!existsSync(join(main, ".git"))) {
      await git(["init", "-q", "-b", "main", main]);
      await git(["-C", main, ...ID, "commit", "-q", "--allow-empty", "-m", "init"]);
    }
    const path = join(root, "wt", name);
    await git(["-C", main, "worktree", "add", "-q", "-b", branch, path, "main"]);
    const common = await git(["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    this.onWorktree?.(path, common, await git(["-C", path, "rev-parse", "--absolute-git-dir"]));
    return path;
  }

  async worktreePs(): Promise<FleetSnapshot> {
    await this.rec("worktreePs", null);
    return {
      worktrees: [...this.rows.values()].map((r) => structuredClone(r)),
      truncated: false,
      omittedHostIds: this.partial ? ["ssh-1"] : [],
    };
  }
  async terminalList(wt: string) {
    await this.rec("terminalList", wt);
    return structuredClone(this.terminals.get(wt) ?? []);
  }
  async accountList() {
    await this.rec("accountList", null);
    return structuredClone(this.rateLimits);
  }
  async worktreeCreate(a: {
    repoId: string;
    name: string;
    baseBranch: string;
    linearIssue: string;
    comment: string;
  }) {
    await this.rec("worktreeCreate", a);
    const branch = `furoyce/${a.name}`;
    const path = this.root ? await this.realWorktree(this.root, a.repoId, a.name, branch) : `/wt/${a.name}`;
    const id = `${a.repoId}::${path}`;
    this.rows.set(id, {
      worktreeId: id,
      repoId: a.repoId,
      path,
      branch,
      displayName: a.name,
      linkedLinearIssue: a.linearIssue,
      status: "active",
      liveTerminalCount: 0,
      lastOutputAt: null,
      childWorktreeIds: [],
      agents: [],
    });
    this.terminals.set(id, []);
    return { id, path };
  }
  async worktreeShow(id: string) {
    await this.rec("worktreeShow", id);
    const r = this.rows.get(id);
    if (!r) throw new Error("no worktree");
    return { id, path: r.path, branch: r.branch, head: "deadbeef" };
  }
  async worktreeSet(id: string, a: unknown) {
    await this.rec("worktreeSet", { id, a });
  }
  async worktreeRm(id: string) {
    await this.rec("worktreeRm", id);
    const row = this.rows.get(id);
    if (!row) throw new OrcaError("orca_error", `fake orca: no worktree ${id}`); // as Orca reports an unknown id
    if (this.root && existsSync(row.path)) {
      const main = join(this.root, "repos", row.repoId);
      await git(["-C", main, "worktree", "remove", "--force", row.path]);
      await git(["-C", main, "branch", "-D", row.branch]);
    }
    this.removed.push(id);
    this.rows.delete(id);
    this.terminals.delete(id);
    this.tookEffect("worktreeRm");
  }
  async terminalCreate(wt: string, title: string, command: string) {
    await this.rec("terminalCreate", { wt, title, command });
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
        stateStartedAt: this.now(),
        updatedAt: null,
      });
    }
    this.tookEffect("terminalCreate");
    return { handle: t.handle, tabId: t.tabId, leafId: t.leafId };
  }
  async terminalWait(h: string, f: string, ms: number) {
    await this.rec("terminalWait", { h, f, ms });
    return {
      satisfied: this.nextWaitSatisfied,
      ...(this.nextBlockedReason ? { blockedReason: this.nextBlockedReason } : {}),
    };
  }
  async terminalKeys(h: string, k: { text?: string; enter?: boolean }) {
    await this.rec("terminalKeys", { h, k });
    if (k.enter && this.nextBlockedReason === "agent-trust-workspace") {
      this.nextBlockedReason = null;
      this.nextWaitSatisfied = true;
    }
  }
  async terminalSend(h: string, text: string, w: number, retry?: string): Promise<SendReceipt> {
    await this.rec("terminalSend", { h, text, w, retry });
    return { stage: this.nextSendStage, requestId: `req_${++this.seq}` };
  }
  async terminalClose(wt: string) {
    await this.rec("terminalClose", wt);
    if (!this.rows.has(wt)) return { ok: false }; // as the CLI wrapper reports a close for a worktree id Orca no longer knows
    this.closed.push(wt);
    this.terminals.set(wt, []);
    const row = this.rows.get(wt);
    if (row) {
      row.liveTerminalCount = 0;
      row.agents = []; // spike §3.3: `terminal close --worktree … --all` removes the agents[] entries
    }
    return { ok: true };
  }
  async terminalShowPreview(h: string) {
    return this.previews.get(h) ?? "";
  }
  async workerList(runId: string) {
    await this.rec("workerList", runId);
    if (this.failRuns.has(runId)) throw new OrcaError("orca_error", `fake orca: no run ${runId}`);
    return structuredClone(this.workers.get(runId) ?? []);
  }
  async workerStop(d: string, retry: string) {
    await this.rec("workerStop", { d, retry });
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
    await this.rec("workerAbandon", d);
  }
  async workerRelease(d: string) {
    await this.rec("workerRelease", d);
  }
  async orchestrationSend(to: string, subject: string, body: string) {
    await this.rec("orchestrationSend", { to, subject, body });
  }
  async runList() {
    await this.rec("runList", null);
    return structuredClone(this.runs);
  }
  async automationsList() {
    return [];
  }
  async automationsCreate(args: string[]) {
    await this.rec("automationsCreate", args);
    return { id: "auto-1" };
  }
  async automationsEdit(id: string, args: string[]) {
    await this.rec("automationsEdit", { id, args });
  }

  // --- test helpers ---
  setAgentState(wt: string, paneKey: string, state: "working" | "done", at: string) {
    const a = this.rows.get(wt)?.agents.find((x) => x.paneKey === paneKey);
    if (a) {
      a.state = state;
      a.stateStartedAt = at;
    }
  }
  /** The agent process ended (spike §3.3: the PTY ends with it, the row and its agents[] entry disappear). */
  killTerminal(wt: string, handle: string) {
    const gone = (this.terminals.get(wt) ?? []).find((t) => t.handle === handle);
    this.terminals.set(
      wt,
      (this.terminals.get(wt) ?? []).filter((t) => t.handle !== handle),
    );
    const row = this.rows.get(wt);
    if (row && gone) row.agents = row.agents.filter((a) => a.paneKey !== `${gone.tabId}:${gone.leafId}`);
  }
}
