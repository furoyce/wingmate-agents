// src/server/actions.ts — Action handlers for the Wingmate Console API.
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config/schema";
import { setPause } from "../ops/pause";
import type { LinearPort } from "../ports";
import { WingmateError } from "../shared/errors";
import { newUuid } from "../shared/ids";
import type { Dirs } from "../shared/paths";
import type { Clock } from "../shared/time";
import { readText, writeAtomic } from "../state/fs";
import { RecordSchema } from "../state/records";

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

/** Delivers an owner answer to an open question in an active worktree. */
export async function handleAnswerQuestion(
  dirs: Dirs,
  identifier: string,
  questionId: string,
  answerText: string,
  linearClient?: LinearPort | null,
  clock?: Clock,
): Promise<ActionResponse> {
  const recordFile = join(dirs.records, `${identifier}.json`);
  const content = await readText(recordFile);
  if (!content) {
    throw new WingmateError("record_not_found", `No active record found for ${identifier}`);
  }

  const record = RecordSchema.parse(JSON.parse(content));
  const worktreePath = record.worktree?.path;
  if (!worktreePath) {
    throw new WingmateError("worktree_missing", `Record ${identifier} has no worktree attached`);
  }

  // 1. Deliver answer file to worktree inbox
  const inboxDir = join(worktreePath, ".wingmate", "inbox");
  await mkdir(inboxDir, { recursive: true });

  const answerFile = join(inboxDir, `answer-${questionId}.md`);
  const answerMarkdown = `# Answer for ${questionId}\n\n${answerText.trim()}\n`;
  await writeFile(answerFile, answerMarkdown, "utf8");

  // 2. Post comment to Linear if linearClient is available
  let commentId: string | null = null;
  const q = record.questions.find((x) => x.id === questionId);
  if (linearClient && record.linearId) {
    try {
      const res = await linearClient.createComment(record.linearId, answerText.trim(), {
        id: newUuid(),
        ...(q?.commentId ? { parentId: q.commentId } : {}),
      });
      commentId = res.id;
    } catch {
      // Non-fatal if worktree inbox file is already recorded
    }
  }

  // 3. Update record state to resume agent immediately
  if (q) {
    q.status = "answered";
    q.answeredAt = (clock?.now() ?? new Date()).toISOString();
    if (commentId) q.answerCommentId = commentId;
  }
  if (record.stage === "awaiting-human") {
    record.stage = "working";
  }
  await writeAtomic(recordFile, JSON.stringify(record, null, 2));

  return {
    ok: true,
    message: `Answer recorded for question ${questionId}. Agent resumed in worktree.`,
    data: { identifier, questionId, file: answerFile, commentId },
  };
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
    // Try orca tab create or fall back to open
    const child = spawn("orca", ["tab", "create", "--url", urlOrPath], {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {
      spawn("open", [urlOrPath], { stdio: "ignore", detached: true }).unref();
    });
    child.unref();
    return { ok: true, message: `Opened ${urlOrPath} in Orca` };
  }

  return { ok: false, message: `Unknown target ${target}` };
}
