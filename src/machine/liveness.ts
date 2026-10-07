// src/machine/liveness.ts — §5.5: one function decides whether the coordinator is working, idle, exited or unverifiable
import { statSync } from "node:fs";
import type { FleetRow, TerminalRow } from "../ports";
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

/**
 * Inputs: the record's terminal handle and worktree path, the worktree's `terminal list` rows and its `worktree ps` row.
 * `exited` when the worktree (its fleet row, or C12 its path on disk) or the handle is gone; `working`/`idle` from the `agents[]`
 * entry joined on `tabId:leafId`; a bare shell prompt in the preview means the agent process ended; otherwise unverifiable.
 */
export function coordinatorLiveness(
  r: WRecord,
  terminals: TerminalRow[],
  row: FleetRow | undefined,
  shellPreview?: string,
): Liveness {
  if (!row || (r.worktree && worktreeGone(r.worktree.path))) return "exited";
  const handle = r.coordinator.terminalHandle;
  const term = handle ? terminals.find((t) => t.handle === handle) : undefined;
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
