// src/machine/watch.ts — §6.3 steps 4–7 for one record: coordinator liveness, stage timers, kit integrity, budgets.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { verifyIntegrity } from "../kit/install";
import { timerState } from "../policy/timers";
import { errorCode } from "../shared/errors";
import { readText } from "../state/fs";
import { doHandoff } from "./handoff";
import { kitHashes } from "./launch";
import { block } from "./release";
import { deliver, relaunch } from "./resume";
import { addAttention, dropAttention, ensureAttempt, transition } from "./states";
import { type Advance, type StepOut, WORKING } from "./step";

const INTEGRITY_STAGES = new Set(["claimed", "working", "awaiting-human"]);
const minutesSince = (now: string, iso: string) => (Date.parse(now) - Date.parse(iso)) / 60_000;
const inMinutes = (now: string, min: number) => new Date(Date.parse(now) + min * 60_000).toISOString();

/** claimed → working once the coordinator is proven to have started (§5.4 step 5). */
async function started(a: Advance, how: string): Promise<void> {
  await transition(a.ctx, a.r, "working", "turn_started", how);
  ensureAttempt(a.ctx, a.r);
  dropAttention(a.r, "launch_unconfirmed");
  a.dirty = true;
}

/** Whether the agent itself wrote `.wingmate/stage.json` (a verb did; the dispatcher's own deliveries say `via: dispatcher`). */
async function agentProgressed(wt: string): Promise<boolean> {
  const t = await readText(join(wt, ".wingmate", "stage.json"));
  if (!t) return false;
  try {
    const via = (JSON.parse(t) as { via?: unknown }).via;
    return via === "gate" || via === "ask";
  } catch {
    return false;
  }
}

async function exited(a: Advance): Promise<StepOut> {
  const { ctx, r } = a;
  if (r.coordinator.relaunches < 1) {
    if (a.budget.resumes <= 0) return "next";
    a.budget.resumes -= 1;
    await relaunch(ctx, r, "exited");
    a.s.relaunches.push(r.identifier);
    a.launched = true;
    a.dirty = true;
    return "next";
  }
  if (a.budget.handoffs <= 0) return "next";
  a.budget.handoffs -= 1;
  await doHandoff(a, "exited_twice");
  a.launched = true;
  a.dirty = true;
  return "stop";
}

/** §6.3 step 4: idle with no progress → two nudges, then the §9.6 grace clock as if the stage cap had been crossed. */
async function idle(a: Advance): Promise<StepOut> {
  const { ctx, r, project } = a;
  const now = ctx.now();
  if (r.stage === "claimed") {
    // §5.4 step 5, launch_unconfirmed: the agent already reported progress, or it gets one "start now" nudge
    if (r.worktree && (await agentProgressed(r.worktree.path))) await started(a, "stage_json");
    else if (
      (await deliver(
        ctx,
        r,
        "nudge",
        "start now: read .wingmate/BRIEF.md and begin the intake stage",
        "idle",
        r.pipelineStage,
      )) === "turn_started"
    )
      await started(a, "nudge");
    return "next";
  }
  const idleMin = minutesSince(now, r.timers.lastActivityAt);
  const n = project.timers.idleNudgeMin;
  if (r.timers.nudges < 2 && idleMin > n * (r.timers.nudges + 1)) {
    const text = `continue from stage ${r.pipelineStage}; if blocked, run wingmate issue ${r.identifier} ask`;
    await deliver(ctx, r, "nudge", text, "idle", r.pipelineStage);
    r.timers.nudges += 1;
    r.timers.nudgedAt = now;
  } else if (r.timers.nudges >= 2 && idleMin > n * 3 && !r.timers.graceEndsAt) {
    addAttention(r, "cap_passed");
    r.timers.graceEndsAt = inMinutes(now, project.timers.graceMin);
  }
  return "next";
}

/** §6.3 step 4. `unverifiable` is recorded and never acted on (I8); reconcile-only ticks only keep the books. */
export async function liveness(a: Advance): Promise<StepOut> {
  const { r } = a;
  if (!WORKING.has(r.stage) || !a.live || a.launched) return "next";
  if (a.live === "unverifiable") {
    addAttention(r, "liveness_unverifiable");
    return "next";
  }
  dropAttention(r, "liveness_unverifiable");
  if (a.ro) return "next";
  if (a.live === "exited") return exited(a);
  if (a.live === "working") {
    // a working coordinator is activity (§9.6): its idle nudges start over
    r.timers.lastActivityAt = a.ctx.now();
    r.timers.nudges = 0;
    if (r.stage === "claimed") await started(a, "pane_working");
    return "next";
  }
  return idle(a);
}

/** §9.6: a crossed cap nudges once and starts the grace clock; grace expiring with no activity hands off; activity resets it. */
export async function timers(a: Advance): Promise<StepOut> {
  const { ctx, r, project } = a;
  if (a.launched || a.ro) return "next";
  const now = ctx.now();
  const ts = timerState(r, now, project.timers);
  if (ts === "cap_passed" && !r.timers.graceEndsAt) {
    const text = `stage ${r.pipelineStage} passed its cap; report progress with a gate or note`;
    await deliver(ctx, r, "nudge", text, a.live ?? "exited", r.pipelineStage);
    addAttention(r, "cap_passed");
    r.timers.graceEndsAt = inMinutes(now, project.timers.graceMin);
    return "next";
  }
  if (ts !== "grace_expired") return "next";
  const quiet =
    a.live !== "working" &&
    a.live !== "unverifiable" &&
    minutesSince(now, r.timers.lastActivityAt) > project.timers.graceMin;
  if (!quiet) {
    r.timers.graceEndsAt = null;
    dropAttention(r, "cap_passed");
    return "next";
  }
  if (a.budget.handoffs <= 0) return "next";
  a.budget.handoffs -= 1;
  await doHandoff(a, "grace_expired");
  a.launched = true;
  a.dirty = true;
  return "stop";
}

/** Task 9 carry-over: the worktree is gone. A parked issue is blocked (§5.2.1); a running one takes the exited-liveness path. */
async function worktreeGone(a: Advance): Promise<StepOut> {
  const { ctx, r } = a;
  addAttention(r, "worktree_gone");
  if (r.stage !== "awaiting-human") return "next";
  await block(
    ctx,
    r,
    a.issue,
    "worktree_gone",
    `the worktree ${r.worktree?.path ?? ""} was removed; branch ${r.worktree?.branch ?? ""} is retained`,
    "move the issue back to Todo to start a new cycle (Wingmate never re-creates a removed worktree)",
  );
  a.s.blocked.push(r.identifier);
  a.dirty = true;
  return "stop";
}

/** §6.3 step 6: any change to the integrity set since the kit was installed blocks the issue (`kit_tampered`). */
export async function integrity(a: Advance): Promise<StepOut> {
  const { ctx, r } = a;
  const wt = r.worktree;
  if (!wt || !INTEGRITY_STAGES.has(r.stage)) return "next";
  const expected = await kitHashes(ctx, r);
  if (!expected) return "next";
  let changed: string[];
  try {
    changed = await verifyIntegrity(wt.path, wt.gitCommonDir, expected);
  } catch (e) {
    if (errorCode(e) !== "integrity_unverifiable") throw e;
    if (!existsSync(wt.path)) return worktreeGone(a);
    addAttention(r, "integrity_unverifiable"); // cannot be checked this tick: surfaced, never a block
    return "next";
  }
  dropAttention(r, "integrity_unverifiable");
  if (!changed.length) return "next";
  await block(
    ctx,
    r,
    a.issue,
    "kit_tampered",
    changed.slice(0, 5).join(","),
    "inspect the worktree, then move the issue back to Todo to re-queue it when it is safe",
  );
  a.s.blocked.push(r.identifier);
  a.dirty = true;
  return "stop";
}

/** §9.6 budgets: over the optional hard cap → `blocked` (`budget`) until a `continue` lifts it. */
export async function budgets(a: Advance): Promise<StepOut> {
  const { ctx, r } = a;
  const hard = r.budget.hardTokens;
  if (!hard || r.budget.capLifted || r.stage !== "working" || (r.usage.tokens ?? 0) <= hard) return "next";
  await block(
    ctx,
    r,
    a.issue,
    "budget",
    `${r.usage.tokens} tokens > hard cap ${hard}`,
    "comment `continue` to lift the cap",
  );
  a.s.blocked.push(r.identifier);
  a.dirty = true;
  return "stop";
}
