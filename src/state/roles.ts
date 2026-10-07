import { z } from "zod";
import { SPAWN_ROLES } from "../kit/settings";

export const RoleJobSchema = z.object({
  id: z.string().regex(/^[0-9A-Za-z]{1,64}$/),
  mode: z.literal("terminal-job"),
  role: z.enum(SPAWN_ROLES),
  cycle: z.number().int(),
  attempt: z.number().int(),
  provider: z.enum(["claude", "codex"]),
  status: z.enum(["starting", "running", "succeeded", "failed", "unverifiable"]),
  launchUncertain: z.boolean().optional(),
  terminalHandle: z.string().nullable(),
  paneKey: z.string().nullable(),
  headSha: z.string(),
  planHash: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  verdict: z.enum(["PASS", "FAIL"]).nullable(),
  reportPath: z.string().nullable(),
  reportHash: z.string().nullable().default(null),
  notified: z.boolean(),
});
export type RoleJob = z.infer<typeof RoleJobSchema>;
export const rolePending = (j: RoleJob): boolean =>
  j.status === "starting" || j.status === "running" || j.status === "unverifiable";
