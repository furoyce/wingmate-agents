// Shared read-only eligibility and fenced executor. Inventory absence never grants ownership.
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { isBranchName } from "../git/refname";
import { githubUrl, remoteBranch } from "../git/remote";
import { gitTarget, verifyGitLinks } from "../git/trust";
import type { Ctx } from "../machine/context";
import { RecordAbort, TickAbort, guardedCtx, isTickAbort, recordCtx } from "../machine/guard";
import { saveRecord, trackRecord } from "../machine/save";
import { addAttention, dropAttention } from "../machine/states";
import type { FleetSnapshot } from "../ports";
import { WingmateError, errorCode } from "../shared/errors";
import { stopRequested } from "../state/heartbeat";
import { type JournalEntry, JournalEntrySchema } from "../state/journal";
import { TickLock } from "../state/lock";
import { RecordSchema, type WRecord, readRecord, recordText } from "../state/records";
import { rolePending } from "../state/roles";

export type CleanupScope = { kind: "all" } | { kind: "project" | "issue"; key: string };
export interface CleanupOptions {
  scope: CleanupScope;
  dryRun?: boolean;
  /** Overrides elapsed grace only, never any safety predicate or retry delay. */
  force?: boolean;
  orphaned?: boolean;
}
export interface CleanupResult {
  identifier: string;
  project: string;
  worktreeId: string | null;
  outcome: "eligible" | "removed" | "deferred" | "retained";
  reason: string;
}
export interface CleanupReport {
  scope: CleanupScope;
  dryRun: boolean;
  force: boolean;
  inventory: "complete" | "incomplete" | "failed";
  cleaned: CleanupResult[];
  orphaned: { worktreeId: string; path: string; outcome: "retained"; reason: string }[];
}
interface State {
  records: WRecord[];
  archives: WRecord[];
  pending: { issue: string; kind: string }[];
  journal: JournalEntry[];
}
interface Inventory {
  state: State;
  fleet: FleetSnapshot | null;
  status: CleanupReport["inventory"];
}
interface Plan {
  result: CleanupResult;
  record: WRecord;
  absent?: boolean;
  head?: string;
  base?: string;
}

/** Read-only discovery: missing directories are empty, every other failure is unknown, never an empty inventory. */
async function jsonFiles(path: string): Promise<unknown[]> {
  const names = await readdir(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return [];
    throw e;
  });
  const out: unknown[] = [];
  for (const name of names.sort().filter((n) => n.endsWith(".json")))
    out.push(JSON.parse(await readFile(join(path, name), "utf8")));
  return out;
}
async function readState(ctx: Ctx): Promise<State> {
  const journal = (await jsonFiles(ctx.dirs.journal)).map((j) => JournalEntrySchema.parse(j));
  return {
    records: (await jsonFiles(ctx.dirs.records)).map((r) => RecordSchema.parse(r)),
    archives: (await jsonFiles(ctx.dirs.archive)).map((r) => RecordSchema.parse(r)),
    journal,
    pending: journal.filter((j) => j.state === "intent" || j.state === "acted" || j.state === "poisoned"),
  };
}
async function inventory(ctx: Ctx): Promise<Inventory> {
  const state = await readState(ctx); // damaged local evidence fails the entire command, before effects
  try {
    const fleet = await ctx.orca.worktreePs();
    return {
      state,
      fleet,
      status:
        fleet.cleanupVerified !== true || fleet.truncated || fleet.omittedHostIds.length
          ? "incomplete"
          : "complete",
    };
  } catch (e) {
    if (isTickAbort(e)) throw e;
    return { state, fleet: null, status: "failed" };
  }
}
const inScope = (r: WRecord, scope: CleanupScope): boolean =>
  scope.kind === "all" || (scope.kind === "issue" ? r.identifier : r.project) === scope.key;
const sameWorkspace = (a: NonNullable<WRecord["worktree"]>, b: NonNullable<WRecord["worktree"]>) =>
  a.id === b.id || resolve(a.path) === resolve(b.path);
async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw e;
  }
}

async function planOne(ctx: Ctx, inv: Inventory, r: WRecord, opts: CleanupOptions): Promise<Plan> {
  const result: CleanupResult = {
    identifier: r.identifier,
    project: r.project,
    worktreeId: r.worktree?.id ?? null,
    outcome: "deferred",
    reason: "unverified",
  };
  const keep = (reason: string, retained = false): Plan => ({
    result: { ...result, outcome: retained ? "retained" : "deferred", reason },
    record: r,
  });
  const wt = r.worktree;
  if (!wt) return keep("no_worktree", true);
  if (r.stage !== "done" && r.stage !== "cancelled") return keep(`stage_${r.stage}`, true);
  if (await stopRequested(ctx.dirs, r.project, r.identifier)) return keep("stop_requested");
  if (ctx.deadline && ctx.deadline.now() >= ctx.deadline.at) return keep("tick_deadline");
  const ended = r.history.at(-1);
  if (
    !ended ||
    ended.to !== r.stage ||
    !Number.isFinite(Date.parse(ended.at)) ||
    Date.parse(ended.at) > Date.parse(ctx.now())
  )
    return keep("terminal_time_unverified");
  if (
    !opts.force &&
    Date.parse(ctx.now()) - Date.parse(ended.at) < ctx.cfg.defaults.cleanup.worktreeGraceHours * 3_600_000
  )
    return keep("grace");
  const lastDefer = (await ctx.ledger.readIssue(r.identifier))
    .filter((e) => e.type === "cleanup_deferred")
    .at(-1);
  if (lastDefer && Date.parse(ctx.now()) - Date.parse(lastDefer.at) < 24 * 3_600_000)
    return keep("retry_delay");
  if (inv.status !== "complete" || !inv.fleet) return keep(`inventory_${inv.status}`);
  const repo = ctx.cfg.projects[r.project]?.repos[r.repo];
  if (!repo) return keep("repo_unconfigured");
  // A record can adopt an existing human workspace. Only a protected create receipt grants deletion ownership.
  const owned = inv.state.journal.some(
    (j) =>
      j.issue === r.identifier &&
      j.kind === "claim" &&
      j.key.startsWith(`claim:${r.identifier}:${r.cycle}:`) &&
      j.steps.some((s) => {
        const receipt = s.receipt as { id?: unknown; branch?: unknown; reused?: unknown } | null;
        return (
          s.name === "worktree" &&
          s.state === "done" &&
          receipt?.id === wt.id &&
          typeof receipt.branch === "string" &&
          receipt.branch.replace(/^refs\/heads\//, "") === wt.branch &&
          receipt.reused === false
        );
      }),
  );
  if (!owned) return keep("ownership_unverified", true);
  if (
    !isAbsolute(wt.path) ||
    !isAbsolute(wt.gitCommonDir) ||
    basename(wt.gitdirName) !== wt.gitdirName ||
    [".", ".."].includes(wt.gitdirName) ||
    !wt.gitdirName ||
    !isBranchName(wt.branch)
  )
    return keep("identity_unverified");
  if (inv.state.archives.some((a) => a.worktree && sameWorkspace(wt, a.worktree)))
    return keep("archived_reference", true);
  if (inv.state.records.some((a) => a !== r && a.worktree && sameWorkspace(wt, a.worktree)))
    return keep("shared_reference", true);
  if (inv.state.pending.some((j) => j.issue === r.identifier)) return keep("outstanding_assignment");
  if (
    r.outbox.pending ||
    r.gateDelivery ||
    r.questions.some((q) => q.status === "open") ||
    r.attempts.some((a) => a.endedAt === null)
  )
    return keep("outstanding_assignment");
  if (r.attention.some((a) => /unverifiable|uncertain/.test(a))) return keep("termination_unverified");
  if (r.roleJobs.some((j) => rolePending(j) || j.launchUncertain || !j.completedAt))
    return keep("worker_unverified");
  if (
    r.nativeUiJobs.some(
      (j) =>
        j.status === "running" ||
        j.status === "unverifiable" ||
        !j.cleanupComplete ||
        !j.deviceCleanupComplete ||
        !j.runtimeReleased ||
        j.runtimeAcquireUncertain ||
        j.createUncertain,
    )
  )
    return keep("native_unverified");
  if (r.coordinator.childRunId) {
    if (!ctx.orca.cleanupWorkers) return keep("worker_inventory_unverified");
    const workers = await ctx.orca.cleanupWorkers(r.coordinator.childRunId);
    if (!workers.complete) return keep("worker_inventory_incomplete");
    if (
      workers.workers.some(
        (w) =>
          w.runId !== r.coordinator.childRunId ||
          w.verdict !== "exited" ||
          !["completed", "failed", "abandoned"].includes(w.dispatchStatus),
      )
    )
      return keep("worker_unverified");
  }
  // Every recorded PR is refreshed, including CLOSED/MERGED: reopening must veto deletion.
  for (const pr of r.prs) {
    const github = ctx.cfg.projects[r.project]?.repos[pr.repo]?.github;
    if (!github) return keep("pr_repo_unconfigured");
    const fresh = await ctx.gh.prView(github, pr.number);
    if (fresh.state === "OPEN") return keep("open_pr");
    if (!["CLOSED", "MERGED"].includes(fresh.state)) return keep("pr_state_unverified");
  }
  if (!ctx.gh.hasOpenPr) return keep("pr_inventory_unverified");
  if (await ctx.gh.hasOpenPr(repo.github, wt.branch)) return keep("open_pr");
  const rows = inv.fleet.worktrees.filter(
    (w) => w.worktreeId === wt.id || resolve(w.path) === resolve(wt.path),
  );
  if (rows.length === 0) {
    if (!(await absent(wt.path))) return keep("fleet_absent_path_present");
    // Existing uncertainties above still block replay; absence is an observation, never a new removal authorization.
    return { result: { ...result, outcome: "eligible", reason: "already_absent" }, record: r, absent: true };
  }
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row ||
    row.worktreeId !== wt.id ||
    row.repoId !== repo.orcaRepo ||
    row.path !== wt.path ||
    row.branch !== wt.branch ||
    row.isMainWorktree ||
    ![r.identifier, r.linearId].includes(row.linkedLinearIssue ?? "")
  )
    return keep("identity_mismatch");
  if (row.childWorktreeIds.length) return keep("children_retained");
  const current = await ctx.orca.worktreeCurrent(wt.path);
  if (current.worktreeId !== wt.id || current.repoId !== repo.orcaRepo || current.path !== wt.path)
    return keep("identity_mismatch");
  const target = gitTarget(wt);
  await verifyGitLinks(target);
  if ((await realpath(wt.path)) !== wt.path || (await realpath(wt.gitCommonDir)) !== wt.gitCommonDir)
    return keep("identity_mismatch");
  if (!ctx.git.cleanupStatus) return keep("git_status_unverified");
  const status = await ctx.git.cleanupStatus(target);
  if (status.branch !== wt.branch) return keep("branch_mismatch");
  if (status.dirty) return keep("dirty");
  const head = await ctx.git.revParse(target, "HEAD");
  const base = await ctx.git.lsRemoteSha(target, githubUrl(repo), remoteBranch(repo.base));
  if (!base) return keep("base_unverified");
  if (head !== base && (await ctx.git.isAncestor(target, head, base)) !== true)
    return keep("unmerged_or_unknown");
  // Re-observe runtime state after potentially slow GitHub/git reads, immediately before admission.
  const latest = await ctx.orca.worktreePs();
  if (!latest.cleanupVerified || latest.truncated || latest.omittedHostIds.length)
    return keep("inventory_incomplete");
  const latestRows = latest.worktrees.filter(
    (w) => w.worktreeId === wt.id || resolve(w.path) === resolve(wt.path),
  );
  if (latestRows.length !== 1 || JSON.stringify(latestRows[0]) !== JSON.stringify(row))
    return keep("resource_changed");
  const terminals = await ctx.orca.terminalList(wt.id);
  if (terminals.length || row.liveTerminalCount || row.agents.length) return keep("active_terminals");
  if (!ctx.inspectCleanupProcesses) return keep("process_inventory_unverified");
  const processes = await ctx.inspectCleanupProcesses(wt.path);
  if (!processes.complete) return keep("process_inventory_incomplete");
  if (processes.pids.length) return keep("active_processes");
  return {
    result: { ...result, outcome: "eligible", reason: "eligible_for_removal" },
    record: r,
    head,
    base,
  };
}
async function safePlan(ctx: Ctx, inv: Inventory, r: WRecord, opts: CleanupOptions): Promise<Plan> {
  try {
    return await planOne(ctx, inv, r, opts);
  } catch (e) {
    if (isTickAbort(e)) throw e;
    return {
      record: r,
      result: {
        identifier: r.identifier,
        project: r.project,
        worktreeId: r.worktree?.id ?? null,
        outcome: "deferred",
        reason: `unverified:${errorCode(e)}`,
      },
    };
  }
}

/** Caller holds the tick lock, or requests a read-only plan. The CLI acquires the same lock as the dispatcher. */
export async function runCleanup(ctx: Ctx, opts: CleanupOptions): Promise<CleanupReport> {
  const inv = await inventory(ctx);
  const report: CleanupReport = {
    scope: opts.scope,
    dryRun: opts.dryRun ?? false,
    force: opts.force ?? false,
    inventory: inv.status,
    cleaned: [],
    orphaned: [],
  };
  for (const r of inv.state.records.filter((r) => inScope(r, opts.scope))) {
    const scoped = recordCtx(ctx, r.project, r.identifier);
    let plan = await safePlan(scoped, inv, r, opts);
    if (!opts.dryRun && plan.result.outcome === "eligible") {
      // A slow PR/process read may outlive an operator's change: re-plan and compare before the destructive call.
      const fresh = await inventory(scoped);
      const current = fresh.state.records.find((a) => a.identifier === r.identifier);
      if (!current || recordText(current) !== recordText(r))
        plan.result = { ...plan.result, outcome: "deferred", reason: "record_changed" };
      else {
        plan = await safePlan(scoped, fresh, current, opts);
        if (plan.result.outcome === "eligible") {
          try {
            await scoped.checkMutation?.();
            if (JSON.stringify(await readState(scoped)) !== JSON.stringify(fresh.state))
              throw new RecordAbort("record_changed", r.identifier);
            const old = current.worktree;
            if (!old) throw new WingmateError("record_changed", "workspace reference changed");
            trackRecord(current);
            // Durable identity and eligibility evidence precede removal, even when the remove reply is lost.
            await scoped.ledger.append({
              at: scoped.now(),
              issue: r.identifier,
              type: "cleanup_intent",
              data: {
                cycle: r.cycle,
                worktree: old,
                head: plan.head,
                base: plan.base,
                reason: plan.result.reason,
              },
            });
            await scoped.checkMutation?.();
            const disk = await readRecord(scoped.dirs, r.identifier);
            if (
              !disk ||
              recordText(disk) !== recordText(current) ||
              JSON.stringify(await readState(scoped)) !== JSON.stringify(fresh.state)
            )
              throw new RecordAbort("record_changed", r.identifier);
            if (!plan.absent) await scoped.orca.worktreeRm(old.id);
            const proof = await inventory(scoped);
            if (
              proof.status !== "complete" ||
              proof.fleet?.worktrees.some(
                (w) => w.worktreeId === old.id || resolve(w.path) === resolve(old.path),
              ) ||
              !(await absent(old.path))
            )
              throw new WingmateError(
                "removal_unverified",
                "removal needs complete fleet and filesystem absence",
              );
            await scoped.checkMutation?.();
            await scoped.ledger.append({
              at: scoped.now(),
              issue: r.identifier,
              type: "cleanup",
              data: {
                cycle: r.cycle,
                worktree: old.id,
                worktreeIdentity: old,
                removed: plan.absent ? "already" : "now",
                head: plan.head,
                base: plan.base,
              },
            });
            current.worktree = null;
            dropAttention(current, "cleanup_failed");
            await scoped.checkMutation?.();
            await saveRecord(scoped, current);
            plan.result = {
              ...plan.result,
              outcome: "removed",
              reason: plan.absent ? "already_absent" : "removed",
            };
          } catch (e) {
            if (isTickAbort(e)) throw e;
            plan.result = { ...plan.result, outcome: "deferred", reason: errorCode(e) };
          }
        }
      }
    }
    // Grace/retention findings do not start a failure retry window; force overrides no backoff or safety check.
    if (
      !opts.dryRun &&
      plan.result.outcome === "deferred" &&
      !["grace", "retry_delay", "record_changed", "stop_requested", "tick_deadline"].includes(
        plan.result.reason,
      )
    ) {
      const disk = await readRecord(ctx.dirs, r.identifier);
      if (disk && recordText(disk) === recordText(r)) {
        await scoped.checkMutation?.();
        trackRecord(disk);
        addAttention(disk, "cleanup_failed");
        await scoped.ledger.append({
          at: ctx.now(),
          issue: r.identifier,
          type: "cleanup_deferred",
          data: { why: plan.result.reason, worktree: r.worktree },
        });
        await scoped.checkMutation?.();
        await saveRecord(scoped, disk);
      }
    }
    report.cleaned.push(plan.result);
  }
  if (opts.orphaned && inv.fleet) {
    const scopedRecords = inv.state.records.concat(inv.state.archives).filter((r) => inScope(r, opts.scope));
    const repos = new Set(
      opts.scope.kind === "issue"
        ? scopedRecords.flatMap((r) => ctx.cfg.projects[r.project]?.repos[r.repo]?.orcaRepo ?? [])
        : Object.entries(ctx.cfg.projects)
            .filter(([key]) => opts.scope.kind === "all" || key === opts.scope.key)
            .flatMap(([, p]) => Object.values(p.repos).map((r) => r.orcaRepo)),
    );
    for (const row of inv.fleet.worktrees) {
      if (row.isMainWorktree || !repos.has(row.repoId)) continue;
      if (
        opts.scope.kind === "issue" &&
        !scopedRecords.some(
          (r) =>
            row.linkedLinearIssue === r.identifier ||
            row.linkedLinearIssue === r.linearId ||
            r.worktree?.id === row.worktreeId,
        )
      )
        continue;
      const refs = inv.state.records
        .concat(inv.state.archives)
        .filter(
          (r) =>
            r.worktree &&
            (r.worktree.id === row.worktreeId || resolve(r.worktree.path) === resolve(row.path)),
        );
      if (refs.some((r) => inv.state.records.includes(r) && inScope(r, opts.scope))) continue;
      // Names are search hints only. Every untracked row, wm-* or otherwise, stays retained/unverified.
      report.orphaned.push({
        worktreeId: row.worktreeId,
        path: row.path,
        outcome: "retained",
        reason: refs.length ? "retained_reference" : "ownership_unverified",
      });
    }
  }
  return report;
}

export async function cleanupOps(base: Ctx, opts: CleanupOptions): Promise<CleanupReport> {
  if (opts.dryRun) return runCleanup(base, opts);
  const lock = await TickLock.acquire(base.dirs, base.clock);
  if (lock.kind === "held")
    throw new WingmateError("lock_held", "a dispatcher tick or cleanup already owns the mutation lock");
  const ctx = guardedCtx(base, async () => {
    if (!(await lock.verify())) throw new TickAbort("lock_lost", "lock_lost");
    if (await stopRequested(base.dirs)) throw new TickAbort("stopped", "stop_requested");
    if (base.deadline && base.deadline.now() >= base.deadline.at)
      throw new TickAbort("error", "tick_deadline");
  });
  try {
    return await runCleanup(ctx, opts);
  } finally {
    await lock.release();
  }
}

export function renderCleanupMd(report: CleanupReport): string {
  const lines = [`Cleanup${report.dryRun ? " (dry run)" : ""}: inventory ${report.inventory}`];
  for (const r of report.cleaned) lines.push(`${r.identifier}: ${r.outcome} (${r.reason})`);
  for (const r of report.orphaned) lines.push(`${r.path}: retained (${r.reason})`);
  return lines.join("\n");
}
