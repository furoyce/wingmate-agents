// src/machine/mirror.ts — refreshes the agent-readable mirror in `.wingmate/` from the record (§8.0) after every tick that touched it.
import { readIntentFiles } from "../kit/intents";
import { readMirrorQuestions, worktreeDir, writeMirror } from "../kit/local";
import { errorCode } from "../shared/errors";
import type { WRecord } from "../state/records";

/** The pending `ask` intents; none when the outbox is unsafe (F7: it is never read then). */
async function pendingAsks(wt: string): Promise<Set<string>> {
  try {
    return new Set((await readIntentFiles(wt)).intents.filter((i) => i.kind === "ask").map((i) => i.id));
  } catch (e) {
    if (errorCode(e) !== "outbox_unsafe") throw e;
    return new Set();
  }
}

/**
 * `record.json` from the record; `questions.json` merged: the record's questions with their statuses, plus local entries the
 * dispatcher does not know yet because their `ask` intent is still pending. A local question whose intent is gone (dropped as
 * `secret_detected` or `workers_live`, or quarantined) is removed, so the agent is not told to `--append` to it forever.
 */
export async function syncMirror(r: WRecord): Promise<void> {
  const wt = r.worktree?.path;
  // F7: `.wingmate` must be a plain directory of the worktree (missing, or a planted symlink: nothing is written)
  if (!wt || !(await worktreeDir(wt, ".wingmate").catch(() => null))) return;
  const asks = await pendingAsks(wt);
  const known = new Set(r.questions.map((q) => q.id));
  const questions = [
    ...r.questions.map((q) => ({ id: q.id, status: q.status, askedAt: q.askedAt })),
    ...(await readMirrorQuestions(wt)).filter((q) => !known.has(q.id) && asks.has(q.id)),
  ];
  await writeMirror(wt, {
    record: {
      identifier: r.identifier,
      stage: r.stage,
      pipelineStage: r.pipelineStage,
      provider: r.provider,
      childRunId: r.coordinator.childRunId,
    },
    questions,
  });
}
