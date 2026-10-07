// src/ops/pause.ts — pause.json is the sorted string array reconcile reads (§6.7, §13.3 i): "global" makes every tick reconcile-only;
// a project key makes that project's records reconcile-only and skips its candidates (`paused(<project>)`). `resume` removes a scope.
import { join } from "node:path";
import { z } from "zod";
import { WingmateError } from "../shared/errors";
import type { Dirs } from "../shared/paths";
import { readText, writeAtomic } from "../state/fs";

export const GLOBAL_SCOPE = "global";
const Scopes = z.array(z.string().min(1));
const file = (dirs: Dirs) => join(dirs.state, "pause.json");

export async function readPause(dirs: Dirs): Promise<string[]> {
  const text = await readText(file(dirs));
  if (text === null) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new WingmateError(
      "pause_invalid",
      `${file(dirs)} is not JSON (${(e as Error).message})`,
      "fix or delete that file (every tick refuses it too), then run `wingmate pause` or `wingmate resume` again",
    );
  }
  const parsed = Scopes.safeParse(raw);
  if (!parsed.success)
    throw new WingmateError(
      "pause_invalid",
      `${file(dirs)} is not an array of scope names`,
      "fix or delete that file (every tick refuses it too), then run `wingmate pause` or `wingmate resume` again",
    );
  return parsed.data;
}

/** Adds (`on`) or removes `scope`; returns the scopes now paused, sorted. */
export async function setPause(dirs: Dirs, scope: string, on: boolean): Promise<string[]> {
  if (!scope) throw new WingmateError("usage", "a pause scope is `global` or a project key");
  const cur = new Set(await readPause(dirs));
  if (on) cur.add(scope);
  else cur.delete(scope);
  const next = [...cur].sort();
  await writeAtomic(file(dirs), JSON.stringify(next));
  return next;
}
