// Advisory mirror for sandboxed agents. The dispatcher verifies gates against its protected record.
import { z } from "zod";
import { errorCode } from "../shared/errors";
import { RoleJobSchema } from "../state/roles";
import { readLaunch, readNoFollow, worktreeFile } from "./local";

export async function dispatcherMode(wt: string): Promise<boolean> {
  try {
    return (await readLaunch(wt)).spawnMode === "dispatcher";
  } catch (e) {
    if (errorCode(e) === "launch_missing") return false;
    throw e;
  }
}

export async function readRoleJobs(wt: string) {
  const f = await worktreeFile(wt, ".wingmate/roles.json");
  if (!f.ok) return [];
  return z
    .array(RoleJobSchema)
    .parse(JSON.parse((await readNoFollow(f.abs, 2 * 1024 * 1024)).toString("utf8")));
}
