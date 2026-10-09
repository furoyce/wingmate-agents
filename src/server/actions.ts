// src/server/actions.ts — Action handlers for the Wingmate Console API. Every handler validates its target against the
// configured scope or the current records before acting, and reports only what it observed (no success before proof).
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { type Config, projectFor } from "../config/schema";
import { GLOBAL_SCOPE, setPause } from "../ops/pause";
import type { LinearPort } from "../ports";
import { WingmateError } from "../shared/errors";
import { run } from "../shared/exec";
import type { Dirs } from "../shared/paths";
import type { Clock } from "../shared/time";
import { Ledger } from "../state/ledger";
import { listRecords } from "../state/records";

/** `confirmed`: the effect was re-observed; `launched`: the opener exited 0; `unknown`: the outcome could not be observed. */
export type ActionStatus = "confirmed" | "launched" | "failed" | "unknown";

export interface ActionResponse {
  ok: boolean;
  status?: ActionStatus;
  message: string;
  data?: unknown;
}

export const PromoteBody = z
  .object({
    linearId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/),
    providerLabel: z.string().min(1).max(64),
  })
  .strict();
export const PauseBody = z.object({ scope: z.string().min(1).max(128), on: z.boolean() }).strict();
export const OpenBody = z.object({ target: z.literal("orca"), path: z.string().min(1).max(4096) }).strict();

const PROMOTABLE_STATES = new Set(["backlog", "unstarted"]);
const TERMINAL_STAGES = new Set(["done", "released", "cancelled"]);

/** Records a Console mutation in the global ledger (local audit trail; never includes request bodies verbatim). */
export async function auditConsoleAction(
  dirs: Dirs,
  clock: Clock,
  action: string,
  issue: string | null,
  data: Record<string, unknown>,
): Promise<void> {
  await new Ledger(dirs).append({ at: clock.now().toISOString(), issue, type: `console_${action}`, data });
}

/**
 * Adds a configured provider label (from `labels.agent.supported`, under the Agent group) to an issue in a configured project.
 * Refuses issues outside configured projects, closed/started issues, and issues that already carry a different Agent label.
 * Success is reported only after re-reading the issue shows the label.
 */
export async function handlePromoteIssue(
  linearClient: LinearPort | null,
  cfg: Config,
  linearId: string,
  providerLabel: string,
): Promise<ActionResponse> {
  if (!linearClient) {
    throw new WingmateError("linear_unavailable", "Linear credentials not configured on this host");
  }
  if (!cfg.labels.agent.supported.includes(providerLabel)) {
    throw new WingmateError(
      "label_not_allowed",
      `"${providerLabel}" is not a configured provider label (${cfg.labels.agent.supported.join(", ")})`,
    );
  }

  const teamMeta = await linearClient.teamMeta(cfg.workspace.team);
  const group = teamMeta.labels.find((l) => l.parentId === null && l.name === cfg.labels.agentGroup);
  const inGroup = (l: { parentId: string | null; parentName: string | null }) =>
    l.parentName === cfg.labels.agentGroup || (group !== undefined && l.parentId === group.id);
  const targetLabel = teamMeta.labels.find((l) => l.name === providerLabel && inGroup(l));
  if (!targetLabel) {
    throw new WingmateError(
      "label_not_found",
      `Linear label "${providerLabel}" not found under the ${cfg.labels.agentGroup} group in team ${cfg.workspace.team}`,
    );
  }

  const issue = (await linearClient.getIssues([linearId]))[0];
  if (!issue) throw new WingmateError("issue_not_found", `Linear issue ${linearId} not found`);
  const project = issue.projectId ? projectFor(cfg, issue.projectId) : undefined;
  if (!project) {
    throw new WingmateError("issue_out_of_scope", `${issue.identifier} is not in a configured project`);
  }
  if (issue.archivedAt || issue.trashed || !PROMOTABLE_STATES.has(issue.state.type)) {
    throw new WingmateError(
      "issue_not_promotable",
      `${issue.identifier} is ${issue.state.name}; only backlog/todo issues can be promoted`,
    );
  }
  const agentLabels = issue.labels.filter(inGroup);
  const other = agentLabels.find((l) => l.id !== targetLabel.id);
  if (other) {
    throw new WingmateError(
      "conflicting_agent_label",
      `${issue.identifier} already has Agent label "${other.name}"; change it in Linear`,
    );
  }

  const data = { identifier: issue.identifier, project: project.key, label: providerLabel };
  if (agentLabels.length > 0) {
    return {
      ok: true,
      status: "confirmed",
      message: `${issue.identifier} already has "${providerLabel}"`,
      data,
    };
  }
  await linearClient.updateIssue(issue.id, { labelIds: [...issue.labels.map((l) => l.id), targetLabel.id] });

  const after = (await linearClient.getIssues([issue.id]))[0];
  if (!after?.labels.some((l) => l.id === targetLabel.id)) {
    return {
      ok: false,
      status: "unknown",
      message: `Label update for ${issue.identifier} was sent but not observed; check the issue in Linear`,
      data,
    };
  }
  return {
    ok: true,
    status: "confirmed",
    message: `${issue.identifier} labeled "${providerLabel}" in Linear; the dispatcher evaluates eligibility on its next tick`,
    data,
  };
}

/** Fail closed until Console can use the verified owner-identity dispatcher resume flow. */
export async function handleAnswerQuestion(
  _dirs: Dirs,
  _identifier: string,
  _questionId: string,
  _answerText: string,
  _linearClient?: LinearPort | null,
  _clock?: Clock,
): Promise<ActionResponse> {
  throw new WingmateError(
    "console_answer_unavailable",
    "Console answers are unavailable. Open the issue in Linear and reply to Wingmate's existing question as your signed-in owner account. The dispatcher checks and delivers eligible replies on its next tick. Submitting here posts nothing and does not resume an agent.",
  );
}

/**
 * Pauses or resumes exactly one scope: `global` or a configured project key. Global and project pauses are independent, so
 * resuming `global` leaves separately paused projects paused (and the response says so).
 */
export async function handleTogglePause(
  dirs: Dirs,
  cfg: Config,
  scope: string,
  on: boolean,
): Promise<ActionResponse> {
  if (scope !== GLOBAL_SCOPE && !Object.hasOwn(cfg.projects, scope)) {
    throw new WingmateError(
      "pause_scope_invalid",
      `pause scope must be "global" or a configured project key`,
    );
  }
  const pausedScopes = await setPause(dirs, scope, on);
  const stillPaused = pausedScopes.filter((s) => s !== scope);
  const label = scope === GLOBAL_SCOPE ? "global dispatch" : `project "${scope}"`;
  const tail = !on && stillPaused.length ? `; still paused: ${stillPaused.join(", ")}` : "";
  return {
    ok: true,
    status: "confirmed",
    message: `${on ? "Paused" : "Resumed"} ${label}${tail}`,
    data: { scope, pausedScopes },
  };
}

export interface LaunchResult {
  code: number | null;
  error: string | null;
  /** The executable does not exist (ENOENT): nothing was launched. */
  missing?: boolean;
}
/** Runs an opener and resolves with its exit status; a launch counts only when the opener exits 0. */
export type Launcher = (cmd: string, args: string[]) => Promise<LaunchResult>;

export const defaultLauncher: Launcher = async (cmd, args) => {
  try {
    // The shared runner withholds the personal Linear token and kills the process group on timeout.
    const result = await run([cmd, ...args], { timeoutMs: 10_000 });
    return {
      code: result.code,
      error: result.timedOut ? "timed out" : result.code === 0 ? null : `exit ${result.code}`,
    };
  } catch (err) {
    return {
      code: null,
      error: "Could not launch opener",
      missing: (err as NodeJS.ErrnoException).code === "ENOENT",
    };
  }
};

/** An allowed open target: the exact worktree path of an active (non-terminal) record that exists as a directory. */
export async function allowedWorktreePath(dirs: Dirs, path: string): Promise<string | null> {
  if (!isAbsolute(path) || resolve(path) !== path) return null;
  const records = await listRecords(dirs);
  const owner = records.find((r) => !TERMINAL_STAGES.has(r.stage) && r.worktree?.path === path);
  if (!owner) return null;
  const st = await stat(path).catch(() => null);
  return st?.isDirectory() ? owner.identifier : null;
}

/**
 * Focuses an active record's worktree in Orca; success requires an exit-0 launch. The system opener is tried only when the
 * Orca CLI is absent, so an Orca launch that failed late (or timed out after acting) is never duplicated.
 */
export async function handleOpenTarget(
  dirs: Dirs,
  path: string,
  launch: Launcher = defaultLauncher,
): Promise<ActionResponse> {
  const identifier = await allowedWorktreePath(dirs, path);
  if (!identifier) {
    throw new WingmateError("open_target_refused", "Only an active record's existing worktree can be opened");
  }
  const orca = await launch("orca", ["file", "open", "README.md", "--worktree", `path:${path}`, "--focus"]);
  if (orca.code === 0) {
    return {
      ok: true,
      status: "launched",
      message: `Orca accepted the request to open ${identifier}'s worktree`,
    };
  }
  if (!orca.missing) {
    return {
      ok: false,
      status: "failed",
      message: `Orca did not open ${identifier}'s worktree: ${orca.error ?? `exit ${orca.code}`}`,
      data: { identifier },
    };
  }
  const sys = await launch("open", [path]);
  if (sys.code === 0) {
    return {
      ok: true,
      status: "launched",
      message: "Orca CLI not found; opened the worktree folder with the system opener",
    };
  }
  return {
    ok: false,
    status: "failed",
    message: `Could not open ${identifier}'s worktree: ${orca.error ?? `orca exit ${orca.code}`}; ${sys.error ?? `open exit ${sys.code}`}`,
    data: { identifier },
  };
}
