// src/server/actions.ts — Action handlers for the Wingmate Console API.
import { spawn } from "node:child_process";
import type { Config } from "../config/schema";
import { setPause } from "../ops/pause";
import type { LinearPort } from "../ports";
import { WingmateError } from "../shared/errors";
import type { Dirs } from "../shared/paths";
import type { Clock } from "../shared/time";

export interface ActionResponse {
  ok: boolean;
  message: string;
  data?: unknown;
}

/** Promotes a Linear issue to agent-ready by adding the agent label in Linear. */
export async function handlePromoteIssue(
  linearClient: LinearPort | null,
  cfg: Config,
  linearId: string,
  providerLabel = "agent-ready",
): Promise<ActionResponse> {
  if (!linearClient) {
    throw new WingmateError("linear_unavailable", "Linear credentials not configured on this host");
  }

  const teamMeta = await linearClient.teamMeta(cfg.workspace.team);
  const targetLabel = teamMeta.labels.find((l) => l.name.toLowerCase() === providerLabel.toLowerCase());

  if (!targetLabel) {
    throw new WingmateError(
      "label_not_found",
      `Linear label "${providerLabel}" not found in team ${cfg.workspace.team}`,
    );
  }

  const issues = await linearClient.getIssues([linearId]);
  const issue = issues[0];
  if (!issue) {
    throw new WingmateError("issue_not_found", `Linear issue ${linearId} not found`);
  }

  const existingLabelIds = issue.labels.map((l) => l.id);
  if (!existingLabelIds.includes(targetLabel.id)) {
    existingLabelIds.push(targetLabel.id);
    await linearClient.updateIssue(linearId, { labelIds: existingLabelIds });
  }

  return {
    ok: true,
    message: `Issue ${issue.identifier} labeled as "${providerLabel}" in Linear`,
    data: { identifier: issue.identifier, label: providerLabel },
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

/** Toggles pause state for global or project scope. */
export async function handleTogglePause(dirs: Dirs, scope = "global", on = true): Promise<ActionResponse> {
  const updated = await setPause(dirs, scope, on);
  return {
    ok: true,
    message: on ? `Paused scope "${scope}"` : `Resumed scope "${scope}"`,
    data: { pausedScopes: updated },
  };
}

/** Launches external opener for browser URL or Orca terminal/tab. */
export async function handleOpenTarget(
  target: "browser" | "orca",
  urlOrPath: string,
): Promise<ActionResponse> {
  if (target === "browser") {
    spawn("open", [urlOrPath], { stdio: "ignore", detached: true }).unref();
    return { ok: true, message: `Opened ${urlOrPath} in browser` };
  }

  if (target === "orca") {
    if (!urlOrPath) {
      return { ok: false, message: "No worktree path provided" };
    }

    if (urlOrPath.startsWith("http://") || urlOrPath.startsWith("https://")) {
      const child = spawn("orca", ["tab", "create", "--url", urlOrPath], {
        stdio: "ignore",
        detached: true,
      });
      child.on("error", () => {
        spawn("open", [urlOrPath], { stdio: "ignore", detached: true }).unref();
      });
      child.unref();
      return { ok: true, message: `Opened ${urlOrPath} in Orca browser tab` };
    }

    // Try orca worktree focus via file open
    try {
      const child = spawn(
        "orca",
        ["file", "open", "README.md", "--worktree", `path:${urlOrPath}`, "--focus"],
        { stdio: "ignore", detached: true },
      );
      child.on("error", () => {});
      child.unref();
    } catch {
      // non-fatal
    }

    // Fall back to system open to ensure folder / editor window is focused
    try {
      spawn("open", [urlOrPath], { stdio: "ignore", detached: true }).unref();
    } catch {
      // non-fatal
    }

    return { ok: true, message: `Opened worktree ${urlOrPath} in Orca` };
  }

  return { ok: false, message: `Unknown target ${target}` };
}
