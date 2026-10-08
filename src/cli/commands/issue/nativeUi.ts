// Agent-side native smoke: local request only. No Orca, simctl, app paths or host runtime access.
import { z } from "zod";
import { listIntents, writeIntent } from "../../../kit/intents";
import { type Local, readLaunch, readNoFollow, worktreeFile, writeStage } from "../../../kit/local";
import { NativeJobSchema, NativeRecipeSchema } from "../../../native/protocol";
import type { Out, Refuse } from "../issue";
import { gitHead } from "./gate";

export async function readNativeJobs(wt: string) {
  const f = await worktreeFile(wt, ".wingmate/native-ui.json");
  if (!f.ok) return [];
  return z
    .array(NativeJobSchema)
    .parse(JSON.parse((await readNoFollow(f.abs, 1024 * 1024)).toString("utf8")));
}
export async function requestNativeUi(
  wt: string,
  id: string,
  recipeFile: string,
  local: Local,
  out: Out,
  refuse: Refuse,
  role?: string,
): Promise<number> {
  if (role !== "coordinator")
    return refuse(
      "native_ui_role",
      "only the coordinator queues native UI; reviewers read its settled evidence",
    );
  if (local.record.pipelineStage !== "ui")
    return refuse("stage_prerequisite", "native UI requires the validated UI pipeline stage");
  if (
    (await listIntents(wt)).some((i) => i.kind === "native-ui") ||
    (await readNativeJobs(wt)).some(
      (j) =>
        j.cycle === local.record.cycle &&
        j.attempt === local.record.attempt &&
        (!j.notified || !j.cleanupComplete),
    )
  )
    return refuse(
      "native_ui_conflict",
      "one native request may be outstanding; wait for its dispatcher result",
    );
  const launch = await readLaunch(wt);
  if (launch.spawnMode !== "dispatcher" || launch.ui.kind !== "ios" || !launch.ui.nativePolicyHash)
    return refuse(
      "native_ui_unconfigured",
      "the owner must configure a native policy and a trusted isolated-build artifact producer before native UI can run",
    );
  if (local.record.cycle === undefined || local.record.attempt === undefined)
    return refuse(
      "native_ui_context_missing",
      "this kit lacks native request identity; re-queue with the current kit",
    );
  const file = await worktreeFile(wt, recipeFile, ".wingmate");
  if (!file.ok) return refuse("ui_smoke_recipe_invalid", file.error);
  const bytes = await readNoFollow(file.abs, 16_385);
  let recipe: unknown;
  try {
    recipe = JSON.parse(bytes.toString("utf8"));
  } catch {
    return refuse("ui_smoke_recipe_invalid", "native recipe is not JSON");
  }
  const p = NativeRecipeSchema.safeParse(recipe);
  if (bytes.length > 16_384 || !p.success)
    return refuse(
      "ui_smoke_recipe_invalid",
      "native recipe needs kind ios, 1..20 strict expectText/tapText/screenshot steps and an assertion; no URLs, devices or commands",
    );
  const head = await gitHead(wt);
  if (!head)
    return refuse("git_head_unavailable", "commit source and restore Git access before requesting native UI");
  const intent = await writeIntent(wt, {
    issue: id,
    kind: "native-ui",
    payload: {
      recipe: p.data,
      headSha: head,
      policyHash: launch.ui.nativePolicyHash,
      worktreeId: launch.worktreeId,
      cycle: local.record.cycle,
      attempt: local.record.attempt,
    },
  });
  await writeStage(wt, { pipelineStage: local.record.pipelineStage, via: "native-ui", requestId: intent.id });
  out({ ok: true, requestId: intent.id, next: "END YOUR TURN NOW" });
  return 0;
}
