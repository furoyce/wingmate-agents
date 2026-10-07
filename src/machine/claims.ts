// src/machine/claims.ts — §6.2 queue evaluation and §6.4 claims: eligible issues in priority order, within caps (§9.5) and quota
// (§9.1), at most `claimsPerTick`, coordinators only from the coordinator cascade (§13.3 c).
import { readdir } from "node:fs/promises";
import { type ProjectConfig, projectFor } from "../config/schema";
import { slots } from "../policy/concurrency";
import { type Coordinator, nextInCascade, resolveTier } from "../policy/providers";
import { type Availability, availability } from "../policy/quota";
import { route } from "../policy/routing";
import type { LinearIssue } from "../ports";
import { errorCode, errorText } from "../shared/errors";
import { stopRequested } from "../state/heartbeat";
import type { Queue, SkipReason } from "../state/queue";
import { type WRecord, archiveRecord, listRecords, newRecord, readRecord } from "../state/records";
import { claimIssue } from "./claim";
import type { Ctx } from "./context";
import { isRecordAbort, isTickAbort, recordCtx } from "./guard";
import { refreshRepoSiblings } from "./launch";
import type { Candidate, Reconciled } from "./reconcile";
import { saveRecord } from "./save";
import { syncStatus } from "./status";
import type { TickOptions, TickSummary } from "./tick";

type Pick = { provider: Coordinator } | { reason: SkipReason; detail: string };
const isCoordinator = (p: string): p is Coordinator => p === "claude" || p === "codex";

const unavailable = (a: Exclude<Availability, { available: true }>, p: string): Pick =>
  a.reason === "quota"
    ? { reason: "quota", detail: a.detail }
    : { reason: "provider_unavailable", detail: `${p}: ${a.reason}` };

/**
 * §9.1: an explicit `claude`/`codex` label → that provider or a skip; `agent-ready` → the project default, else the next available
 * provider of the coordinator cascade. A provider outside `coordinatorCascade` never coordinates: the pilot keeps Codex to review
 * roles until the owner accepts the D14 extension (§13.3 c), whatever the label says.
 */
function pickProvider(
  ctx: Ctx,
  rec: Reconciled,
  label: "claude" | "codex" | "agent-ready",
  nowMs: number,
): Pick {
  const cascade = ctx.cfg.defaults.providers.coordinatorCascade;
  const avail = (p: Coordinator) => availability(rec.rateLimits, p, ctx.cfg.defaults.quota, nowMs);
  if (label !== "agent-ready") {
    if (!cascade.includes(label))
      return { reason: "provider_unavailable", detail: `${label} is not in coordinatorCascade` };
    const a = avail(label);
    return a.available ? { provider: label } : unavailable(a, label);
  }
  const def = ctx.cfg.defaults.providers.default;
  const first = isCoordinator(def) && cascade.includes(def) ? def : undefined;
  if (first && avail(first).available) return { provider: first };
  const next = nextInCascade(cascade, first ? [first] : [], (p) => avail(p).available);
  if (next) return { provider: next };
  const a = avail(first ?? cascade[0] ?? "claude");
  return a.available
    ? { reason: "provider_unavailable", detail: "no coordinator available" }
    : unavailable(a, first ?? "cascade");
}

/** The next cycle: one past the record's and every archived cycle, so an archive file is never overwritten. */
async function nextCycle(ctx: Ctx, identifier: string, old: WRecord | undefined): Promise<number> {
  const names = await readdir(ctx.dirs.archive).catch(() => [] as string[]);
  const archived = names
    .map((n) => new RegExp(`^${identifier}\\.(\\d+)\\.json$`).exec(n)?.[1])
    .filter((x): x is string => x !== undefined)
    .map(Number);
  return Math.max(old?.cycle ?? 0, ...archived) + 1;
}

/**
 * The claim's own status comment was written while the record was still `claimed`; once the launch moved it on (`working`, or
 * `blocked` by its setup) the comment says so (Ruling R1: a tick-level transition refreshes it). A failure here is only logged —
 * the claim itself succeeded and the next status edit catches up.
 */
async function refreshStatus(ctx: Ctx, r: WRecord, issue: LinearIssue): Promise<void> {
  try {
    await syncStatus(ctx, r, issue);
    await saveRecord(ctx, r);
  } catch (e) {
    if (isTickAbort(e)) throw e;
    ctx.log.warn(
      { issue: r.identifier, code: errorCode(e), err: errorText(e) },
      "status refresh after claim failed",
    );
  }
}

/** §5.2 re-claim: archive the terminal record, keep its status comment, start the next cycle; a failed claim still holds its slot. */
async function claimOne(
  ctx: Ctx,
  c: Candidate,
  project: ProjectConfig,
  provider: Coordinator,
  known: WRecord[],
  s: TickSummary,
): Promise<WRecord | null> {
  const id = c.issue.identifier;
  const old = known.find((x) => x.identifier === id);
  const cycle = await nextCycle(ctx, id, old);
  if (old) {
    await archiveRecord(ctx.dirs, id);
    known.splice(known.indexOf(old), 1);
  }
  const rt = route(project, c.issue.title, c.issue.description);
  const rctx = recordCtx(ctx, project.key, id); // F1: a stop scoped to this issue or project stops the claim at its next action
  try {
    const made = await claimIssue(rctx, {
      issue: c.issue,
      project,
      provider,
      repoName: rt.repo,
      routing: { basis: rt.basis, candidates: rt.candidates, rerouteFrom: null },
      cycle,
      existingStatusCommentId: old?.linear.statusCommentId ?? null,
    });
    s.claims.push(id);
    await refreshRepoSiblings(ctx, known, made.worktree?.gitCommonDir, id); // R22/R24: the repo gained a sibling
    if (made.stage !== "claimed") await refreshStatus(rctx, made, c.issue);
    return made;
  } catch (e) {
    if (isRecordAbort(e)) {
      s.skipped.push({ identifier: id, reason: e.code });
      await ctx.ledger.append({ at: ctx.now(), issue: id, type: e.code, data: {} });
      return readRecord(ctx.dirs, id); // the half-made claim holds its slot; the next tick replays it or sees the newer write
    }
    if (isTickAbort(e)) throw e;
    s.attention.push({ identifier: id, code: "claim_failed" });
    await ctx.ledger.append({ at: ctx.now(), issue: id, type: "claim_failed", data: { code: errorCode(e) } });
    ctx.log.error({ issue: id, code: errorCode(e), err: errorText(e) }, "claim failed");
    return readRecord(ctx.dirs, id); // a half-made claim still counts against the caps (I7); the next tick replays it
  }
}

/** A would-be claim for the dry-run plan, so the plan respects the caps exactly as the claims would. */
const planned = (ctx: Ctx, issue: LinearIssue, project: ProjectConfig, provider: Coordinator): WRecord =>
  newRecord({
    identifier: issue.identifier,
    linearId: issue.id,
    project: project.key,
    repo: project.routing.default,
    provider,
    autonomy: project.autonomy,
    now: ctx.now(),
  });

export async function claimCandidates(
  ctx: Ctx,
  rec: Reconciled,
  s: TickSummary,
  opts: TickOptions,
): Promise<Queue> {
  const queue: Queue = { at: ctx.now(), items: [] };
  // the advance already ran: caps count the records as they are now (a resume this tick holds its slot)
  const known = opts.dryRun ? [...rec.records] : await listRecords(ctx.dirs);
  let live = rec.fleet.worktrees.filter((wk) => wk.displayName.startsWith("wm-")).length;
  let sl = slots(known, live, ctx.cfg);
  let claimsLeft = s.reconcileOnly ? 0 : ctx.cfg.defaults.dispatcher.claimsPerTick;
  const nowMs = Date.parse(ctx.now());
  const item = (c: Candidate, project: string, reason: SkipReason | null, detail: string | null) =>
    queue.items.push({
      identifier: c.issue.identifier,
      project,
      status: reason ? "skipped" : "eligible",
      reason,
      detail,
      nextEvalAt: null,
    });
  for (const c of rec.candidates) {
    const id = c.issue.identifier;
    if (c.verdict.status === "skipped") {
      const key = c.issue.projectId ? (projectFor(ctx.cfg, c.issue.projectId)?.key ?? "?") : "?";
      item(c, key, c.verdict.reason, c.verdict.detail);
      s.skipped.push({ identifier: id, reason: c.verdict.reason });
      continue;
    }
    const project = c.verdict.project;
    const skipped = (sk: { reason: SkipReason; detail: string }) => {
      item(c, project.key, sk.reason, sk.detail);
      s.skipped.push({ identifier: id, reason: sk.reason });
    };
    const pick = pickProvider(ctx, rec, c.verdict.provider, nowMs);
    if ("reason" in pick) {
      skipped(pick);
      continue;
    }
    const cap = sl.canClaim(project.key, pick.provider);
    if (cap) {
      skipped(cap);
      continue;
    }
    if (!(await resolveTier(pick.provider, { home: ctx.home }))) {
      skipped({ reason: "model_unresolved", detail: pick.provider });
      continue;
    }
    item(c, project.key, null, null);
    if (claimsLeft <= 0) {
      s.skipped.push({ identifier: id, reason: s.reconcileOnly ? "reconcile_only" : "claims_per_tick" });
      continue;
    }
    if (await stopRequested(ctx.dirs, project.key, id)) {
      s.skipped.push({ identifier: id, reason: "stop_requested" });
      continue;
    }
    claimsLeft -= 1;
    const made = opts.dryRun
      ? planned(ctx, c.issue, project, pick.provider)
      : await claimOne(ctx, c, project, pick.provider, known, s);
    if (opts.dryRun) s.claims.push(id);
    if (made) {
      known.push(made);
      // a new `wm-` worktree counts against maxLiveWorktrees; a re-claim's reused one was counted already
      const reused = !!made.worktree && rec.fleet.worktrees.some((wk) => wk.worktreeId === made.worktree?.id);
      if (opts.dryRun || (made.worktree && !reused)) live += 1;
    }
    sl = slots(known, live, ctx.cfg);
  }
  return queue;
}
