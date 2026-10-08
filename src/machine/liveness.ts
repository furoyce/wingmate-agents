// src/machine/liveness.ts — §5.5: one function decides whether the coordinator is working, idle, exited or unverifiable
import { statSync } from "node:fs";
import type { FleetRow, TerminalRow, WorkerRow } from "../ports";
import type { WRecord } from "../state/records";

export type Liveness = "working" | "idle" | "exited" | "unverifiable";

const SHELL_PROMPT = /(\$|%|#|>)\s*$/;

/** §5.5 "… or the worktree is gone": its path is no longer a directory on disk, whatever Orca still lists for it. */
export function worktreeGone(path: string): boolean {
  try {
    return !statSync(path).isDirectory();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR"; // anything else (EACCES) cannot tell: the path is not judged gone
  }
}

/** N3 (R32): the agents Wingmate starts a coordinator as (`worktree ps` `agents[].agentType`). */
const COORDINATOR_AGENTS: ReadonlySet<string> = new Set(["claude", "codex"]);
const NO_ROLES: ReadonlySet<string> = new Set();

/** N3: the terminal handles of the child Run's role agents (worker-list `agentTerminalHandle`): never the coordinator. */
export function roleHandles(
  r: WRecord,
  workers: ReadonlyMap<string, WorkerRow[]>,
  terminals: TerminalRow[] = [],
): Set<string> {
  const run = r.coordinator.childRunId;
  return new Set([
    ...r.roleJobs.flatMap((j) =>
      [
        j.terminalHandle,
        ...terminals.filter((t) => `${t.tabId}:${t.leafId}` === j.paneKey).map((t) => t.handle),
      ].filter((h): h is string => h !== null),
    ),
    ...(run ? (workers.get(run) ?? []) : []).flatMap((w) =>
      w.agentTerminalHandle ? [w.agentTerminalHandle] : [],
    ),
  ]);
}

/**
 * N3 (R32): the worktree's terminals that can be its coordinator once Orca lists neither the recorded handle nor the recorded pane —
 * each with a live Claude or Codex agent in its pane (the `worktree ps` `agents[]` entry joined by `tabId:leafId`; an agent's entry
 * goes with its process, spike §3.3), none a role agent of the child Run, none the handle `except`. A title proves nothing: Orca
 * lists the title the agent itself sets (spike §3.3: "◑ Sleep command test"), never the `--title` it was created with.
 */
export function coordinatorCandidates(
  terminals: TerminalRow[],
  row: FleetRow | undefined,
  roles: ReadonlySet<string>,
  except: string | null = null,
): TerminalRow[] {
  const agents = new Set(
    (row?.agents ?? [])
      .filter((a) => a.agentType !== null && COORDINATOR_AGENTS.has(a.agentType))
      .map((a) => a.paneKey),
  );
  return terminals.filter(
    (t) => t.handle !== except && !roles.has(t.handle) && agents.has(`${t.tabId}:${t.leafId}`),
  );
}

/**
 * INT-2 + N3 (R32; §4.4: handles are runtime-scoped, so the coordinator is re-resolved from `terminal list` each tick): its terminal row
 * — by the recorded handle; when Orca re-issued handles (a restart re-attaching its terminals), by the recorded pane key `tabId:leafId`
 * (UUIDs); when both changed, the one terminal of the worktree that runs a live Claude or Codex agent other than the child Run's role
 * agents (`coordinatorCandidates`). Several such terminals are `ambiguous`, never a guess (§5.5: liveness unverifiable, attention
 * `coordinator_ambiguous`; I1, I8); none means the coordinator is gone. A record that never had a terminal has none.
 */
export function coordinatorRow(
  r: WRecord,
  terminals: TerminalRow[],
  row: FleetRow | undefined,
  roles: ReadonlySet<string> = NO_ROLES,
): TerminalRow | "ambiguous" | undefined {
  const handle = r.coordinator.terminalHandle;
  if (!handle) return undefined;
  const byHandle = terminals.find((t) => t.handle === handle);
  if (byHandle) return byHandle;
  const pane = r.coordinator.paneKey;
  const byPane = pane ? terminals.find((t) => `${t.tabId}:${t.leafId}` === pane) : undefined;
  if (byPane) return byPane;
  // An uncertain role create cannot be distinguished from a replacement coordinator.
  if (unknownRoleTerminal(r, terminals)) return "ambiguous";
  const live = coordinatorCandidates(terminals, row, roles);
  return live.length > 1 ? "ambiguous" : live[0];
}

export function unknownRoleTerminal(r: WRecord, terminals: TerminalRow[]): boolean {
  return r.roleJobs.some(
    (j) =>
      (j.launchUncertain || ["starting", "running", "unverifiable"].includes(j.status)) &&
      !terminals.some((t) => t.handle === j.terminalHandle || `${t.tabId}:${t.leafId}` === j.paneKey),
  );
}

/**
 * Inputs: the record's terminal handle and worktree path, the worktree's `terminal list` rows and its `worktree ps` row, and (N3) the
 * child Run's role-agent handles. `exited` when the worktree (its fleet row, or C12 its path on disk) or the coordinator's terminal is
 * gone (`coordinatorRow`); `unverifiable` when several live agents could be it (N3); `working`/`idle` from the `agents[]` entry
 * joined on `tabId:leafId`; a bare shell prompt in the preview means the agent process ended; otherwise unverifiable.
 */
export function coordinatorLiveness(
  r: WRecord,
  terminals: TerminalRow[],
  row: FleetRow | undefined,
  shellPreview?: string,
  roles: ReadonlySet<string> = NO_ROLES,
): Liveness {
  if (!row || (r.worktree && worktreeGone(r.worktree.path))) return "exited";
  const term = coordinatorRow(r, terminals, row, roles);
  if (term === "ambiguous") return "unverifiable";
  if (!term) return "exited";
  const paneKey = `${term.tabId}:${term.leafId}`;
  const entry = row.agents.find((a) => a.paneKey === paneKey);
  if (entry?.state === "working") return "working";
  if (entry?.state === "done") return "idle";
  if (shellPreview !== undefined && shellPreview !== "" && SHELL_PROMPT.test(shellPreview.trimEnd())) {
    return "exited";
  }
  return "unverifiable";
}

/** §7.1 step 3: was any agent of this worktree active at `atIso` (± margin)? Used by the self-answer rule. */
export function agentActiveAt(
  row: FleetRow | undefined,
  terminals: TerminalRow[],
  atIso: string,
  marginSec: number,
): boolean {
  if (!row) return false;
  const at = Date.parse(atIso);
  const m = marginSec * 1000;
  const live = new Set(terminals.map((t) => `${t.tabId}:${t.leafId}`));
  for (const a of row.agents) {
    if (!live.has(a.paneKey)) continue;
    const start = a.stateStartedAt ? Date.parse(a.stateStartedAt) : 0;
    if (a.state === "working") {
      if (at >= start - m) return true;
    } else if (a.state === "done" && start > at - m) {
      return true;
    }
  }
  for (const t of terminals) {
    if (t.lastOutputAt && Math.abs(Date.parse(t.lastOutputAt) - at) <= m) return true;
  }
  return false;
}
