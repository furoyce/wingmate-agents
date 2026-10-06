import { join } from "node:path";
import { z } from "zod";
import type { Dirs } from "../shared/paths";
import { readText, writeAtomic } from "./fs";

export const SKIP_REASONS = [
  "cap_global",
  "cap_project",
  "cap_provider",
  "cap_inflight",
  "cap_worktrees",
  "quota",
  "provider_unavailable",
  "model_unresolved",
  "prerequisite_open",
  "has_open_children",
  "unsupported_provider",
  "human",
  "conflicting_agent_labels",
  "label_by_unlisted_actor",
  "veto_label",
  "paused",
  "live_owner",
  "not_todo",
  "archived",
] as const;

export const QueueSchema = z.object({
  at: z.string(),
  items: z.array(
    z.object({
      identifier: z.string(),
      project: z.string(),
      status: z.enum(["eligible", "skipped"]),
      reason: z.enum(SKIP_REASONS).nullable().default(null),
      detail: z.string().nullable().default(null),
      nextEvalAt: z.string().nullable().default(null),
    }),
  ),
});
export type Queue = z.infer<typeof QueueSchema>;
export type SkipReason = (typeof SKIP_REASONS)[number];

export const writeQueue = (dirs: Dirs, q: Queue) =>
  writeAtomic(join(dirs.state, "queue.json"), JSON.stringify(QueueSchema.parse(q), null, 2));

export async function readQueue(dirs: Dirs): Promise<Queue | null> {
  const t = await readText(join(dirs.state, "queue.json"));
  return t ? QueueSchema.parse(JSON.parse(t)) : null;
}
