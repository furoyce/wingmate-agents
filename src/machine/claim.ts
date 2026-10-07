// src/machine/claim.ts — the §5.4 sequence as one journal entry with ordered steps; provisionAndLaunch is also the replay path
// (tick, unfinished claim steps) and the reroute launch.
import { basename } from "node:path";
import { type ProjectConfig, type RepoConfig, repoFor } from "../config/schema";
import { pointerBrief } from "../kit/brief";
import { installKit } from "../kit/install";
import { agentEnv, coordinatorArgv, launchCommand } from "../kit/settings";
import { MARK } from "../linear/markers";
import { resolveTier } from "../policy/providers";
import { capMinFor } from "../policy/timers";
import type { LinearIssue } from "../ports";
import { WingmateError, errorText } from "../shared/errors";
import { run } from "../shared/exec";
import { newUlid, newUuid } from "../shared/ids";
import type { JournalEntry } from "../state/journal";
import { type WRecord, createRecordExclusive, newRecord } from "../state/records";
import type { Ctx } from "./context";
import { isTickAbort } from "./guard";
import { kitNonce, prepareLaunch } from "./launch";
import { LinearWrites } from "./linearWrites";
import { block } from "./release";
import { waitForTui } from "./resume";
import { saveRecord, trackRecord } from "./save";
import { addAttention, dropAttention, ensureAttempt, transition } from "./states";
import { syncStatus } from "./status";

export interface ClaimInput {
  issue: LinearIssue;
  project: ProjectConfig;
  provider: "claude" | "codex";
  repoName: string;
  routing: WRecord["routing"];
  cycle?: number;
  existingStatusCommentId?: string | null;
}
export type Tier = { model: string; effort: string };

export const CLAIM_STEPS = ["linear", "worktree", "kit", "launch", "orcaMeta"];
const EPOCH = "1970-01-01T00:00:00.000Z";

/** F4: the keys of the record's current claim entry — its claim (cycle, attempt), or the reroute it is in. */
const claimKeys = (r: WRecord): string[] => [
  `claim:${r.identifier}:${r.cycle}:${r.coordinator.attempt}`,
  `reroute:${r.identifier}:${r.cycle}:${r.repo}`,
];

/** F4: the record's own open claim entry (the newest keyed to its current claim), never another cycle's or attempt's. */
export async function openClaimEntry(ctx: Ctx, r: WRecord): Promise<JournalEntry | undefined> {
  const keys = claimKeys(r);
  return (await ctx.journal.pending())
    .filter((e) => e.issue === r.identifier && e.kind === "claim" && keys.includes(e.key))
    .at(-1);
}

const lifecycleOf = (ctx: Ctx, issue: LinearIssue): string | null =>
  issue.labels.find((l) => ctx.meta.lifecycleIds.has(l.id))?.name ?? null;

export async function claimIssue(ctx: Ctx, c: ClaimInput): Promise<WRecord> {
  const tier = await resolveTier(c.provider, { home: ctx.home });
  if (!tier) throw new WingmateError("model_unresolved", `no tier best for ${c.provider}`);
  const r = newRecord({
    identifier: c.issue.identifier,
    linearId: c.issue.id,
    project: c.project.key,
    repo: c.repoName,
    provider: c.provider,
    autonomy: c.project.autonomy,
    now: ctx.now(),
    cycle: c.cycle ?? 1,
    routing: c.routing,
    capMin: capMinFor("intake", c.project.timers),
  });
  r.coordinator.launch = { model: tier.model, effort: tier.effort };
  r.linear.statusCommentId = c.existingStatusCommentId ?? null;
  r.budget = {
    softTokens: c.project.budgets.softTokens,
    hardTokens: c.project.budgets.hardTokens,
    capLifted: false,
    softNoticeAt: null,
  };
  r.linear.lifecycleLabelAtClaim = lifecycleOf(ctx, c.issue);
  r.linear.lifecycleLabel = r.linear.lifecycleLabelAtClaim;
  r.linear.state = c.issue.state.name;
  await createRecordExclusive(ctx.dirs, r); // step 1: the claim itself (O_EXCL)
  trackRecord(r); // F1: every later write of this claim is a compare-and-write
  const entry = await ctx.journal.intent({
    issue: r.identifier,
    kind: "claim",
    key: `claim:${r.identifier}:${r.cycle}:${r.coordinator.attempt}`,
    input: { provider: c.provider, repo: c.repoName },
    steps: CLAIM_STEPS,
  });
  try {
    await claimLinear(ctx, r, c.issue, entry.id);
    await provisionAndLaunch(ctx, r, c.issue, c.project, entry.id, tier);
    return r;
  } catch (err) {
    if (isTickAbort(err)) {
      await saveRecord(ctx, r); // keep the progress; the abort is not a failed step
      throw err;
    }
    await ctx.journal.failed(entry.id, errorText(err));
    r.coordinator.launchRetries += 1;
    addAttention(r, "claim_step_failed");
    await saveRecord(ctx, r);
    throw err;
  }
}

/** §5.4 step 2, as Wingmate with the pre-write re-read: In Progress, `In-Agent`, the owner subscribed, the status comment. */
export async function claimLinear(ctx: Ctx, r: WRecord, issue: LinearIssue, entryId: string): Promise<void> {
  const w = new LinearWrites(ctx);
  await w.setState(r, issue, "In Progress");
  await w.setLifecycle(r, issue, "In-Agent");
  await w.subscribeOwner(r, issue);
  await syncStatus(ctx, r, issue, null, "claiming");
  await ctx.journal.stepDone(entryId, "linear", { statusCommentId: r.linear.statusCommentId });
  await saveRecord(ctx, r);
}

const worktreeName = (r: WRecord) =>
  `wm-${r.identifier.toLowerCase()}${r.routing.rerouteFrom ? `-${r.repo}` : ""}`;

/**
 * §5.4 step 3: the issue worktree — the one already linked to the issue when it exists (a previous cycle, or a crash after
 * `worktree create`), else a new one. The git paths come from git itself and have no fallback: the agent's sandbox grants and
 * denies are spelled from them.
 */
async function provisionWorktree(ctx: Ctx, r: WRecord, repo: RepoConfig, entryId: string): Promise<void> {
  const name = worktreeName(r);
  const existing = (await ctx.orca.worktreePs()).worktrees.find(
    (x) => x.linkedLinearIssue === r.identifier && x.displayName === name && x.repoId === repo.orcaRepo,
  );
  const created = existing
    ? { id: existing.worktreeId, path: existing.path }
    : await ctx.orca.worktreeCreate({
        repoId: repo.orcaRepo,
        name,
        baseBranch: repo.base,
        linearIssue: r.identifier,
        comment: "wingmate: claimed",
      });
  const shown = await ctx.orca.worktreeShow(created.id);
  const baseSha = await ctx.git.revParse(shown.path, repo.base).catch(async (e: unknown) => {
    ctx.log.warn({ issue: r.identifier, err: errorText(e) }, "base ref unresolved; using the worktree head");
    return shown.head;
  });
  const gitCommonDir = await ctx.git.commonDir(shown.path);
  const gitdirName = basename(await ctx.git.gitDir(shown.path));
  r.worktree = {
    id: created.id,
    path: shown.path,
    branch: shown.branch.replace(/^refs\/heads\//, ""),
    baseSha,
    gitCommonDir,
    gitdirName,
  };
  await ctx.journal.stepDone(entryId, "worktree", {
    id: created.id,
    branch: shown.branch,
    reused: !!existing,
  });
  await saveRecord(ctx, r);
}

/** §5.4 step 4: kit (with tier `best` of both providers for review roles), install policy, hashes; then the repo's setup. */
async function installAndSetup(
  ctx: Ctx,
  r: WRecord,
  issue: LinearIssue,
  project: ProjectConfig,
  repo: RepoConfig,
  entryId: string,
  tier: Tier,
): Promise<boolean> {
  const wt = r.worktree;
  if (!wt) throw new WingmateError("kit_no_worktree", `${r.identifier} has no worktree`);
  const kitDir = ctx.kitDirFor(r.identifier);
  const nonce = newUlid();
  const comments = (await ctx.linear.listComments([issue.id], EPOCH)).filter(
    (x) => !x.body.startsWith(MARK.status),
  );
  const tiers = {
    claude: await resolveTier("claude", { home: ctx.home }),
    codex: await resolveTier("codex", { home: ctx.home }),
  };
  const res = await installKit({
    worktreePath: wt.path,
    kitDir,
    record: r,
    cfg: ctx.cfg,
    project,
    issue: {
      identifier: r.identifier,
      title: issue.title,
      description: issue.description,
      url: issue.url,
      comments: comments.map((x) => ({ author: x.userId ?? x.botActorId ?? "unknown", body: x.body })),
      parent: issue.parent?.identifier ?? null,
      children: issue.children
        .filter((ch) => ch.stateType !== "completed" && ch.stateType !== "canceled")
        .map((ch) => ch.identifier),
    },
    nonce,
    launch: tier,
    tiers,
    toolchainPaths: ctx.toolchainPaths,
  });
  await ctx.ledger.append({
    at: ctx.now(),
    issue: r.identifier,
    type: "kit_installed",
    data: { hashes: res.hashes, nonce, courtesySettings: res.courtesySettings },
  });
  if (repo.setup !== "none") {
    const s = await run(repo.setup, { cwd: wt.path, timeoutMs: 10 * 60_000, env: agentEnv(kitDir) });
    await ctx.ledger.append({
      at: ctx.now(),
      issue: r.identifier,
      type: "setup",
      data: { code: s.code, timedOut: s.timedOut },
    });
    if (s.code !== 0) {
      // the command's output can carry secrets: the blocked comment names only the exit code
      await block(
        ctx,
        r,
        issue,
        "setup_failed",
        `the repository setup command exited ${s.code}${s.timedOut ? " (timeout)" : ""}`,
        "fix the setup command in config/projects.yaml or the repo, then move the issue back to Todo to re-queue",
      );
      await ctx.journal.abandon(entryId, "setup_failed");
      return false;
    }
  }
  await ctx.journal.stepDone(entryId, "kit", { nonce });
  return true;
}

/**
 * §5.4 step 5: the coordinator terminal (never a second one while a handle is recorded). F5 (§6.6, Appendix D): a `terminal create`
 * that took effect but reported a failure (a timeout, an unparseable receipt) is never repeated — `terminal list` proves the effect,
 * and the worktree's terminal titled `wingmate <identifier>` is adopted with the argv and session the failed attempt recorded.
 */
async function createCoordinator(ctx: Ctx, r: WRecord, tier: Tier): Promise<void> {
  const wt = r.worktree;
  if (!wt) throw new WingmateError("kit_no_worktree", `${r.identifier} has no worktree`);
  await prepareLaunch(ctx, r);
  const kitDir = ctx.kitDirFor(r.identifier);
  const title = `wingmate ${r.identifier}`;
  const prior = (await ctx.orca.terminalList(wt.id)).find((t) => t.title === title);
  if (!prior || !r.coordinator.argv.length) {
    const sessionId = newUuid();
    r.coordinator.argv = coordinatorArgv({
      provider: r.provider,
      model: tier.model,
      effort: tier.effort,
      sessionId,
      kitDir,
      worktreePath: wt.path,
    });
    r.coordinator.sessionId = r.provider === "claude" ? sessionId : null;
  }
  if (prior)
    await ctx.ledger.append({
      at: ctx.now(),
      issue: r.identifier,
      type: "terminal_adopted",
      data: { handle: prior.handle },
    });
  else r.coordinator.startedAt = ctx.now();
  const term = prior
    ? { handle: prior.handle, tabId: prior.tabId, leafId: prior.leafId }
    : await ctx.orca.terminalCreate(wt.id, title, launchCommand(r.coordinator.argv, agentEnv(kitDir)));
  r.coordinator.terminalHandle = term.handle;
  r.coordinator.paneKey = `${term.tabId}:${term.leafId}`;
  await saveRecord(ctx, r);
}

/**
 * Steps worktree → kit → launch → orcaMeta of §5.4. Each step is skipped when the record already proves it happened, so a crashed
 * claim replays without a second worktree or terminal (S7). A launch that never reaches tui-idle leaves the record `claimed` with
 * the failure journaled; the next tick waits on the same handle again.
 */
export async function provisionAndLaunch(
  ctx: Ctx,
  r: WRecord,
  issue: LinearIssue,
  project: ProjectConfig,
  entryId: string,
  tier: Tier,
): Promise<void> {
  const repo = repoFor(project, r.repo);
  if (!r.worktree) await provisionWorktree(ctx, r, repo, entryId);
  if (!r.coordinator.terminalHandle) {
    if (!(await installAndSetup(ctx, r, issue, project, repo, entryId, tier))) return;
    await createCoordinator(ctx, r, tier);
  }
  const wt = r.worktree;
  const handle = r.coordinator.terminalHandle;
  if (!wt || !handle)
    throw new WingmateError("launch_failed", `${r.identifier}: no worktree or terminal after provisioning`);
  if (!(await waitForTui(ctx, r, handle))) {
    addAttention(r, "launch_not_ready");
    r.coordinator.launchRetries += 1;
    await saveRecord(ctx, r);
    await ctx.journal.failed(entryId, "launch_not_ready");
    return;
  }
  const nonce = (await kitNonce(ctx, r)) ?? "";
  const receipt = await ctx.orca.terminalSend(handle, pointerBrief(r.identifier, wt.path, nonce), 10);
  if (receipt.stage === "turn_started") {
    await transition(ctx, r, "working", "turn_started");
    ensureAttempt(ctx, r);
    dropAttention(r, "launch_not_ready", "launch_unconfirmed", "claim_step_failed");
  } else {
    addAttention(r, "launch_unconfirmed");
    await ctx.ledger.append({
      at: ctx.now(),
      issue: r.identifier,
      type: "launch_unconfirmed",
      data: { requestId: receipt.requestId },
    });
  }
  await ctx.journal.stepDone(entryId, "launch", receipt);
  await ctx.orca
    .worktreeSet(wt.id, { workspaceStatus: "in-progress", comment: r.pipelineStage })
    .catch((e: unknown) => {
      if (isTickAbort(e)) throw e;
      ctx.log.warn({ issue: r.identifier, err: errorText(e) }, "worktree set failed");
    });
  await ctx.journal.stepDone(entryId, "orcaMeta", null);
  await ctx.journal.confirmed(entryId);
  await saveRecord(ctx, r);
}
