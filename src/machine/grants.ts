// src/machine/grants.ts — §13.3(e) allow-deps: the grant rule, and (C28) the kit's launch.json following it, so the agent-side
// `gate security` passes a dependency change the owner authorized. Publish recomputes the policy from the grant all the same.
import { join } from "node:path";
import { gitTarget } from "../git/trust";
import { contentDigest, verifyIntegrity } from "../kit/install";
import { LaunchSchema, worktreeDir, writeInWorktree } from "../kit/local";
import type { LinearIssue } from "../ports";
import { errorCode } from "../shared/errors";
import { readText } from "../state/fs";
import type { WRecord } from "../state/records";
import type { Ctx } from "./context";
import { kitHashes } from "./launch";
import { worktreeGone } from "./liveness";
import { addNote } from "./status";
import type { Advance, StepOut } from "./step";

const EPOCH = "1970-01-01T00:00:00.000Z";
const ms = (iso: string) => Date.parse(iso);
const LAUNCH = ".wingmate/launch.json";
/** Where the agent runs `gate security` — or is parked until it can (a grant may be the answer to its question). */
const GRANTABLE: ReadonlySet<string> = new Set(["claimed", "working", "awaiting-human"]);

/**
 * §13.3(e): `allow-deps` counts only while the label is on the issue and its latest grant — the history entry that last added it — was
 * made by an approver as a human (no bot actor), before this cycle's claim or while the record was parked `awaiting-human` (the owner
 * granting it in answer to a question).
 */
export async function allowDepsGranted(ctx: Ctx, r: WRecord, issue: LinearIssue): Promise<boolean> {
  const labelId = ctx.meta.labels.find((l) => l.name === ctx.cfg.labels.allowDeps)?.id;
  if (!labelId || !issue.labels.some((l) => l.id === labelId)) return false;
  const grant = (await ctx.linear.issueHistory(issue.id, EPOCH))
    .filter((h) => h.addedLabelIds.includes(labelId))
    .sort((a, b) => ms(a.createdAt) - ms(b.createdAt))
    .at(-1);
  if (!grant || grant.botActorId || !grant.actorId || !ctx.cfg.workspace.approvers.includes(grant.actorId))
    return false;
  const at = ms(grant.createdAt);
  if (at < ms(r.claimedAt)) return true;
  return r.history.some((h, i) => {
    const out = r.history[i + 1];
    return h.to === "awaiting-human" && at >= ms(h.at) && (!out || at <= ms(out.at));
  });
}

/** launch.json as written, or null when it is missing or no longer a launch file (a kit change: the integrity step blocks it). */
async function launchText(wt: string): Promise<{ text: string; raw: Record<string, unknown> } | null> {
  const text = await readText(join(wt, LAUNCH));
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  return LaunchSchema.safeParse(raw).success ? { text, raw: raw as Record<string, unknown> } : null;
}

/**
 * C28, a step of the advance before answers are delivered: `.wingmate/launch.json` `allowDeps` follows the grant rule — as the claim
 * found it, and again whenever it changes (an approver granting it in answer to a question, or removing the label). launch.json is
 * integrity-protected, so it is rewritten only while the rest of the kit hashes as pinned and launch.json itself either as pinned or
 * exactly as the grant rule writes it (a tampered kit is left for the integrity step to block, never overwritten). The new hash is
 * then pinned in spawn's copy (`.wingmate/integrity.json`) and in the ledger (`kit_rehashed`), in that order, so a crash between the
 * writes is repaired by the next tick instead of reading as tampering.
 */
export async function allowDepsGrant(a: Advance): Promise<StepOut> {
  const { ctx, r } = a;
  const wt = r.worktree;
  if (!wt || !GRANTABLE.has(r.stage) || worktreeGone(wt.path)) return "next";
  const expected = await kitHashes(ctx, r);
  const launch = await launchText(wt.path);
  if (!expected || !launch) return "next";
  const granted = await allowDepsGranted(ctx, r, a.issue);
  const want = JSON.stringify({ ...launch.raw, allowDeps: granted }, null, 2);
  const pin = contentDigest(want, false);
  if (expected[LAUNCH] === pin) return "next"; // pinned as the grant rule has it
  let changed: string[];
  try {
    changed = await verifyIntegrity(wt.path, wt.gitCommonDir, expected, gitTarget(wt).gitDir);
  } catch (e) {
    if (errorCode(e) === "integrity_unverifiable") return "next"; // the integrity step surfaces it
    throw e;
  }
  const launchOk = !changed.includes(LAUNCH) || launch.text === want;
  if (!launchOk || changed.some((c) => c !== LAUNCH)) return "next";
  let dir: string;
  try {
    dir = await worktreeDir(wt.path, ".wingmate");
  } catch (e) {
    if (errorCode(e) === "outbox_unsafe") return "next"; // never written through a symlink; the outbox and inbox surface it
    throw e;
  }
  if (launch.text !== want) await writeInWorktree(dir, "launch.json", want);
  const hashes = { ...expected, [LAUNCH]: pin };
  await writeInWorktree(
    dir,
    "integrity.json",
    JSON.stringify({ commonDir: wt.gitCommonDir, hashes }, null, 2),
  );
  const data = { hashes, file: LAUNCH, allowDeps: granted };
  await ctx.ledger.append({ at: ctx.now(), issue: r.identifier, type: "kit_rehashed", data });
  addNote(r, `allow-deps ${granted ? "granted" : "withdrawn"}: launch.json allowDeps is ${granted}`);
  return "next";
}
