// src/machine/handoff.ts — §9.4 mid-issue handoff to the next untried provider in the same worktree, and the `handoff --repo`
// reroute (§8.1, §10.3): same provider and cycle, a new worktree in the other repo.
import { gitTarget } from "../git/trust";
import { coordinatorArgv } from "../kit/settings";
import { renderHandoff } from "../linear/templates";
import { type Coordinator, nextInCascade, resolveTier } from "../policy/providers";
import { availability } from "../policy/quota";
import { errorText } from "../shared/errors";
import { newUuid } from "../shared/ids";
import { PIPELINE, type WRecord } from "../state/records";
import { provisionAndLaunch } from "./claim";
import { isTickAbort } from "./guard";
import { refreshRepoSiblings } from "./launch";
import { LinearWrites } from "./linearWrites";
import { type HandoffIntent, consumeHandoff } from "./outbox";
import { block, closeClaimEntries, stopAgents } from "./release";
import { relaunch } from "./resume";
import { saveRecord } from "./save";
import { addAttention, endAttempt, enterPipelineStage, stageOf, transition, worktreeOf } from "./states";
import { addNote } from "./status";
import type { Advance } from "./step";

const isCoordinator = (p: string): p is Coordinator => p === "claude" || p === "codex";

async function stopped(a: Advance): Promise<void> {
  const { unverifiable } = await stopAgents(a.ctx, a.r);
  if (unverifiable.length)
    addAttention(a.r, `release_unverifiable(${unverifiable.map((u) => u.split(":")[0]).join(",")})`);
}

/**
 * §9.4 (one per tick): write the handoff comment, stop workers and coordinator, and launch the next provider of the coordinator
 * cascade not yet tried in this cycle — its first launch is not one of the attempt's relaunches; none left (handoffs per cycle are
 * bounded by cascade length − 1) → `blocked`. F2: the keyed comment comes first, so a failed Linear write changes nothing (the
 * coordinator keeps running, an agent's `handoff` intent stays pending) and a retry never posts it twice; the new attempt is on disk
 * before the intent leaves the outbox.
 */
export async function doHandoff(
  a: Advance,
  trigger: string,
  reason: string | null = null,
  intent: HandoffIntent | null = null,
): Promise<void> {
  const { ctx, r, s } = a;
  const wt = r.worktree?.path ?? "";
  const cascade = ctx.cfg.defaults.providers.coordinatorCascade;
  const tried = [...new Set(r.attempts.filter((x) => x.cycle === r.cycle).map((x) => x.provider))].filter(
    isCoordinator,
  );
  const nowMs = Date.parse(ctx.now());
  const next = nextInCascade(
    cascade,
    tried.length ? tried : [r.provider],
    (p) => availability(a.rec.rateLimits, p, ctx.cfg.defaults.quota, nowMs).available,
  );
  const blockWith = async (cause: string, detail: string, nextAction: string) => {
    endAttempt(ctx, r, "handoff", trigger);
    try {
      await block(ctx, r, a.issue, cause, detail, nextAction); // stops the agents; `blocked` is on disk before any Linear write
    } finally {
      // the block is decided and on disk even when its label or comment is still due (finishBlock): the request is answered
      if (stageOf(r) === "blocked") await consumeHandoff(ctx, r, wt, intent);
    }
    s.blocked.push(r.identifier);
  };
  if (!next || r.handoffs.thisCycle >= cascade.length - 1) {
    const cause = trigger === "grace_expired" ? "grace_expired_no_cascade" : "cascade_exhausted";
    const detail = `trigger ${trigger}; no untried available provider`;
    return blockWith(cause, detail, "move the issue back to Todo to re-queue it when ready");
  }
  const tier = await resolveTier(next, { home: ctx.home });
  if (!tier)
    return blockWith(
      "provider_unavailable",
      `${next}: model_unresolved`,
      "set the provider CLI's default model, then re-queue",
    );
  const body = renderHandoff({
    from: r.provider,
    to: next,
    trigger,
    summary: `stage ${r.pipelineStage}${reason ? `; reason: ${reason}` : ""}`,
    evidence: r.worktree ? [`worktree ${r.worktree.path}`] : [],
    openQuestions: [],
    blockers: [],
  });
  await new LinearWrites(ctx).postComment(r, a.issue, body, {
    key: `handoff:${r.identifier}:${r.cycle}:${r.coordinator.attempt}`,
  });
  await stopped(a);
  endAttempt(ctx, r, "handoff", trigger);
  r.provider = next;
  r.coordinator.attempt += 1;
  r.coordinator.relaunches = 0;
  r.coordinator.launchRetries = 0; // REL-1: launch retries are counted per claim entry; a handoff opens none
  r.coordinator.launch = { model: tier.model, effort: tier.effort };
  r.handoffs.total += 1;
  r.handoffs.thisCycle += 1;
  await transition(ctx, r, "claimed", "handoff", trigger);
  const sessionId = newUuid();
  r.coordinator.argv = coordinatorArgv({
    provider: next,
    model: tier.model,
    effort: tier.effort,
    sessionId,
    kitDir: ctx.kitDirFor(r.identifier),
    worktreePath: r.worktree?.path ?? ".",
  });
  r.coordinator.sessionId = next === "claude" ? sessionId : null;
  await saveRecord(ctx, r);
  await consumeHandoff(ctx, r, wt, intent);
  if (await relaunch(ctx, r, `handoff:${trigger}`, { counted: false })) s.handoffs.push(r.identifier);
  else addAttention(r, "launch_unconfirmed");
}

/** The rerouted-from worktree is removed only when its branch has nothing beyond `baseSha` (unknown, or links moved (C22) → kept). */
async function retire(a: Advance, old: NonNullable<WRecord["worktree"]>): Promise<void> {
  const { ctx, r } = a;
  const ahead = await ctx.git.commitsAhead(gitTarget(old), old.baseSha).catch(() => 1);
  if (ahead !== 0) {
    addNote(r, `kept worktree ${old.path} (it has commits)`);
    return;
  }
  try {
    await ctx.orca.worktreeRm(old.id);
    await refreshRepoSiblings(ctx, a.rec.records, old.gitCommonDir, r.identifier);
  } catch (e) {
    if (isTickAbort(e)) throw e;
    addAttention(r, "cleanup_failed");
    ctx.log.warn({ issue: r.identifier, err: errorText(e) }, "reroute: old worktree not removed");
  }
}

/**
 * `handoff --repo <name>`: same provider and cycle, no handoff counted, a new attempt in a new worktree of the other repo. F2: the
 * agent's intent leaves the old worktree's outbox once the reroute is on disk; F4: the record's earlier claim entries are closed
 * before the reroute's own entry opens.
 */
export async function doReroute(
  a: Advance,
  repoName: string,
  intent: HandoffIntent | null = null,
): Promise<void> {
  const { ctx, r, s } = a;
  if (!a.project.repos[repoName]) {
    addAttention(r, "reroute_unknown_repo");
    await consumeHandoff(ctx, r, r.worktree?.path ?? "", intent); // a request that can never be honored
    return;
  }
  await stopped(a);
  const old = r.worktree;
  endAttempt(ctx, r, "reroute", repoName);
  r.repo = repoName;
  r.routing = { basis: "rule", candidates: [repoName], rerouteFrom: old?.id ?? null };
  r.worktree = null;
  Object.assign(r.coordinator, {
    terminalHandle: null,
    paneKey: null,
    sessionId: null,
    childRunId: null,
    argv: [],
    attempt: r.coordinator.attempt + 1,
    relaunches: 0,
    launchRetries: 0, // REL-1: the reroute's own claim entry starts its retries afresh
  });
  for (const g of PIPELINE)
    r.gates[g] = {
      verdict: null,
      failCount: 0,
      at: null,
      evidencePath: null,
      headSha: null,
      dispatchId: null,
      note: null,
    };
  await transition(ctx, r, "claimed", "reroute", repoName);
  enterPipelineStage(ctx, r, "intake");
  await saveRecord(ctx, r);
  if (old) await consumeHandoff(ctx, r, old.path, intent);
  if (old) await retire(a, old);
  const l = r.coordinator.launch;
  // the tier the claim resolved (R31: a null model is the CLI's own default, resolved all the same); re-resolved only if none was
  const tier = l.effort
    ? { model: l.model, effort: l.effort }
    : await resolveTier(r.provider, { home: ctx.home });
  if (!tier) {
    addAttention(r, "model_unresolved");
    return;
  }
  await closeClaimEntries(ctx, r.identifier, "rerouted");
  const entry = await ctx.journal.intent({
    issue: r.identifier,
    kind: "claim",
    key: `reroute:${r.identifier}:${r.cycle}:${repoName}`,
    input: { repo: repoName },
    steps: ["worktree", "kit", "launch", "orcaMeta"],
  });
  try {
    await provisionAndLaunch(ctx, r, a.issue, a.project, entry.id, tier);
    if (stageOf(r) === "working") s.resumes.push(r.identifier);
    await refreshRepoSiblings(ctx, a.rec.records, worktreeOf(r)?.gitCommonDir, r.identifier);
  } catch (e) {
    if (isTickAbort(e)) throw e;
    await ctx.journal.failed(entry.id, errorText(e));
    addAttention(r, "claim_step_failed");
  }
}
