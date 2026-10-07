import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Dirs } from "../shared/paths";
import { readText, writeAtomic } from "./fs";

export const HeartbeatSchema = z.object({
  kind: z.enum(["scan", "tick"]),
  at: z.string(),
  exitCode: z.number().int(),
  outcome: z.enum([
    "idle",
    "work",
    "paused",
    "lock_held",
    // R16: the tick's lock was reclaimed while it was frozen (another tick now holds it); it aborted before acting
    "lock_lost",
    "orca_unreachable",
    "linear_error",
    "stopped",
    "error",
  ]),
  reason: z.string().nullable(),
  durationMs: z.number(),
  pausedScopes: z.array(z.string()),
  linearAuth: z.object({ ok: z.boolean(), expiresAt: z.string().nullable() }),
  orcaReachable: z.boolean(),
  counts: z.record(z.number()),
});
export type Heartbeat = z.infer<typeof HeartbeatSchema>;

const lastTickPath = (dirs: Dirs) => join(dirs.state, "last-tick.json");

/** §6.5: `heartbeat.json` holds the latest heartbeat of either kind; a tick's is also kept as the last tick's (C17). */
export async function writeHeartbeat(dirs: Dirs, h: Heartbeat): Promise<void> {
  const text = JSON.stringify(HeartbeatSchema.parse(h), null, 2);
  await writeAtomic(join(dirs.state, "heartbeat.json"), text);
  if (h.kind === "tick") await writeAtomic(lastTickPath(dirs), text);
}

export async function readHeartbeat(dirs: Dirs): Promise<Heartbeat | null> {
  const t = await readText(join(dirs.state, "heartbeat.json"));
  return t ? HeartbeatSchema.parse(JSON.parse(t)) : null;
}

/**
 * C17: the last tick's heartbeat. §6.7 measures the reconcile-only gap from it, so a manual `scan` (which writes `heartbeat.json`
 * too) never turns the first tick after a long sleep into a normal one. Until a tick has written `last-tick.json`, `heartbeat.json`
 * counts only when a tick wrote it.
 */
export async function readLastTick(dirs: Dirs): Promise<Heartbeat | null> {
  const t = await readText(lastTickPath(dirs));
  if (t) return HeartbeatSchema.parse(JSON.parse(t));
  const h = await readHeartbeat(dirs);
  return h?.kind === "tick" ? h : null;
}

const StopSchema = z.object({
  scopes: z.array(
    z.object({
      scope: z.enum(["all", "project", "issue"]),
      key: z.string().nullable(),
      at: z.string(),
      reason: z.string().nullable().default(null),
    }),
  ),
});
const stopPath = (dirs: Dirs) => join(dirs.state, "stop-requested.json");

/** `wingmate stop` writes this flag (§13.3 i); the tick checks it before every external action. */
export async function requestStop(
  dirs: Dirs,
  s: { scope: "all" | "project" | "issue"; key?: string; at: string; reason?: string },
) {
  const t = await readText(stopPath(dirs));
  const cur: z.infer<typeof StopSchema> = t ? StopSchema.parse(JSON.parse(t)) : { scopes: [] };
  cur.scopes.push({ scope: s.scope, key: s.key ?? null, at: s.at, reason: s.reason ?? null });
  await writeAtomic(stopPath(dirs), JSON.stringify(cur, null, 2));
}

export async function stopRequested(dirs: Dirs, projectKey?: string, identifier?: string): Promise<boolean> {
  const t = await readText(stopPath(dirs));
  if (!t) return false;
  const { scopes } = StopSchema.parse(JSON.parse(t));
  return scopes.some(
    (s) =>
      s.scope === "all" ||
      (s.scope === "project" && s.key === projectKey) ||
      (s.scope === "issue" && s.key === identifier),
  );
}

export const clearStop = (dirs: Dirs) => unlink(stopPath(dirs)).catch(() => undefined);
