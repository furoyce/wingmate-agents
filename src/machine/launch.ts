// src/machine/launch.ts — what every coordinator (re)launch needs first (Rulings R22/R24) and what the kit ledgered at install.
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { refreshSiblingDenies, verifyIntegrity } from "../kit/install";
import { WingmateError, errorCode, errorText } from "../shared/errors";
import type { WRecord } from "../state/records";
import type { Ctx } from "./context";

const ACTIVE = new Set(["claimed", "working", "awaiting-human", "review", "blocked"]);

/**
 * Before every coordinator (re)launch. F2: the kit's integrity set is verified first (§6.3 step 6 runs after liveness, so a tampered
 * kit could otherwise be relaunched into before it blocks; `kit_tampered`, or `integrity_unverifiable`, refuses the launch). R22/R24:
 * re-list the other worktrees' gitdirs and branches into the kit's settings files (Claude pins `--settings` at launch, so a refresh
 * applies from this launch on), and recreate the own branch's ref directory — an out-of-sandbox `git gc` can prune an empty
 * `refs/heads/<namespace>/`, and the sandbox denies creating it again.
 */
export async function prepareLaunch(ctx: Ctx, r: WRecord): Promise<void> {
  const wt = r.worktree;
  if (!wt) return;
  const expected = await kitHashes(ctx, r);
  const changed = expected ? await verifyIntegrity(wt.path, wt.gitCommonDir, expected) : [];
  if (changed.length)
    throw new WingmateError("kit_tampered", `${r.identifier}: ${changed.slice(0, 5).join(",")}`);
  await refreshSiblingDenies(ctx.kitDirFor(r.identifier), wt.gitCommonDir, wt.gitdirName, wt.branch);
  await mkdir(dirname(join(wt.gitCommonDir, "refs", "heads", wt.branch)), { recursive: true });
}

/**
 * R22/R24, after a claim or a cleanup changed the repo's set of worktrees: refresh the other active records of that repo, so the
 * role agents `spawn` launches next (and their coordinators' next relaunch) deny the new sibling. A failure is ledgered and logged,
 * never fatal to the claim that triggered it: the record's own next launch refreshes again.
 */
export async function refreshRepoSiblings(
  ctx: Ctx,
  records: WRecord[],
  commonDir: string | undefined,
  except: string | null,
): Promise<void> {
  if (!commonDir) return;
  for (const o of records) {
    if (
      o.identifier === except ||
      !o.worktree ||
      o.worktree.gitCommonDir !== commonDir ||
      !ACTIVE.has(o.stage)
    )
      continue;
    try {
      await refreshSiblingDenies(
        ctx.kitDirFor(o.identifier),
        commonDir,
        o.worktree.gitdirName,
        o.worktree.branch,
      );
    } catch (e) {
      await ctx.ledger.append({
        at: ctx.now(),
        issue: o.identifier,
        type: "sibling_refresh_failed",
        data: { code: errorCode(e) },
      });
      ctx.log.warn({ issue: o.identifier, err: errorText(e) }, "sibling deny refresh failed");
    }
  }
}

async function latestKit(ctx: Ctx, r: WRecord) {
  return [...(await ctx.ledger.readIssue(r.identifier))].reverse().find((e) => e.type === "kit_installed");
}

/** The nonce the brief fences the ticket with (§4.4): inbox messages are fenced with it too (§7.1 step 4). */
export async function kitNonce(ctx: Ctx, r: WRecord): Promise<string | null> {
  const n = (await latestKit(ctx, r))?.data.nonce;
  return typeof n === "string" && n ? n : null;
}

/** The integrity-set hashes ledgered at the latest kit install (§6.3 step 6), or null before any install. */
export async function kitHashes(ctx: Ctx, r: WRecord): Promise<Record<string, string> | null> {
  const h = (await latestKit(ctx, r))?.data.hashes;
  if (!h || typeof h !== "object" || Array.isArray(h)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (typeof v === "string") out[k] = v;
  return out;
}
