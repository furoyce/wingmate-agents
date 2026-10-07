// src/ops/stop.ts — §13.3(i) the kill switch: a direct action that needs neither the automation nor a tick and never waits on
// tick.lock. (1) stop-requested.json first, so a running tick aborts before its next external action; (2) without any lock, each
// record's agents are stopped (worker-stop, then worker-abandon when not proven exited; terminal close for the issue and child
// worktrees) and (3) its processes swept; with `--all` also every `wm-` worktree with a working agent no record covers; (4) each record
// is blocked `owner_stop` with one blocked comment, every write under the record lock (compare-and-write, retried when a tick wrote
// in between); then this stop's flag entry is cleared and the stop is ledgered. Linear being unreachable never keeps a record from
// being blocked on disk: its label and comment then follow on the next tick (`finishBlock`).
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Ctx } from "../machine/context";
import { isRecordAbort } from "../machine/guard";
import { block, markBlocked, stopAgents } from "../machine/release";
import { readTracked } from "../machine/save";
import { scanText } from "../policy/secrets";
import type { FleetSnapshot, LinearIssue } from "../ports";
import { errorCode, errorText } from "../shared/errors";
import { readText } from "../state/fs";
import { releaseStop, requestStop } from "../state/heartbeat";
import { RecordSchema, type WRecord, readRecord } from "../state/records";

export type StopScope = { kind: "all" } | { kind: "project"; key: string } | { kind: "issue"; key: string };
export interface StopReport {
  scope: StopScope;
  /** Records now `blocked` (`owner_stop`). */
  stopped: string[];
  /** Of `stopped`: blocked on disk, the Linear label and comment still to come (posted by the next tick). */
  deferred: string[];
  /** Records that could not be blocked, as `<identifier>:<code>`; while any is listed this stop's flag stays set. */
  failed: string[];
  /** What could not be verified stopped: dispatch ids, `run:<id>`, `terminals:<worktreeId>`. */
  unverifiable: string[];
  sweptWorktrees: string[];
  /** False when a record could not be blocked: the flag stays, so no tick resumes that work; re-run the stop. */
  flagCleared: boolean;
}

const ACTIVE = new Set(["claimed", "working", "awaiting-human", "review"]);
const NEXT_ACTION = "move the issue back to Todo when you want Wingmate to work on it again";
const ATTEMPTS = 3;

/** The owner's `--reason`: one line, bounded, never a secret-looking token (it is posted in the blocked comment). */
export function stopReason(reason: string | null | undefined): string {
  const printable = [...(reason ?? "")].map((ch) => (ch < " " || ch === "\x7f" ? " " : ch)).join("");
  const r = printable.replace(/\s+/g, " ").trim().slice(0, 200);
  if (!r) return "no reason given";
  return scanText(r).length ? "(reason withheld: it looked like a secret)" : r;
}

const inScope = (s: StopScope, r: { project: string; identifier: string }) =>
  s.kind === "all" || (s.kind === "project" ? r.project === s.key : r.identifier === s.key);
const scopeFlag = (s: StopScope) => (s.kind === "all" ? "--all" : `--${s.kind} ${s.key}`);

/** Every record that parses; a record file that does not is a failure entry, never a reason to stop nothing (§13.3 i). */
async function readRecords(ctx: Ctx, failed: string[]): Promise<WRecord[]> {
  const names = (await readdir(ctx.dirs.records).catch(() => [] as string[])).filter((n) =>
    n.endsWith(".json"),
  );
  const out: WRecord[] = [];
  for (const n of names.sort()) {
    const id = n.replace(/\.json$/, "");
    try {
      const text = await readText(join(ctx.dirs.records, n));
      const parsed = text === null ? null : RecordSchema.safeParse(JSON.parse(text));
      if (parsed?.success) out.push(parsed.data);
      else if (parsed) failed.push(`${id}:record_invalid`);
    } catch {
      failed.push(`${id}:record_invalid`);
    }
  }
  return out;
}

/** Close and sweep one worktree that no record's `stopAgents` covered (a child worktree, or an unrecorded `wm-` one). */
async function closeAndSweep(ctx: Ctx, id: string, path: string, report: StopReport): Promise<void> {
  const c = await ctx.orca.terminalClose(id);
  if (!c.ok) report.unverifiable.push(`terminals:${id}`);
  const swept = await ctx.sweep([path]);
  await ctx.ledger.append({
    at: ctx.now(),
    issue: null,
    type: "process_sweep",
    data: { worktree: id, killed: swept.killed, commands: swept.commands ?? [], why: "stop" },
  });
  report.sweptWorktrees.push(path);
}

/** (4) One record to `blocked` (`owner_stop`): a fresh tracked read, every write a compare-and-write under its lock. */
async function blockOne(ctx: Ctx, identifier: string, detail: string, report: StopReport): Promise<void> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const r = await readTracked(ctx, identifier);
    if (!r || !ACTIVE.has(r.stage)) return; // archived, released or blocked meanwhile: nothing left to stop
    let issue: LinearIssue | null = null;
    try {
      issue = (await ctx.linear.getIssues([r.linearId]))[0] ?? null;
    } catch (e) {
      ctx.log.warn(
        { issue: identifier, code: errorCode(e) },
        "stop: Linear unreachable; blocking on disk only",
      );
    }
    try {
      if (issue) await block(ctx, r, issue, "owner_stop", detail, NEXT_ACTION);
      else {
        await markBlocked(ctx, r, "owner_stop", detail, NEXT_ACTION);
        report.deferred.push(identifier);
      }
      report.stopped.push(identifier);
      return;
    } catch (e) {
      if (isRecordAbort(e) && attempt < ATTEMPTS) continue; // a tick wrote the record in between: read it again
      const now = await readRecord(ctx.dirs, identifier).catch(() => null);
      if (now?.stage === "blocked") {
        // blocked on disk; only the Linear label or comment failed — the next tick posts them (F2, finishBlock)
        report.stopped.push(identifier);
        report.deferred.push(identifier);
      } else report.failed.push(`${identifier}:${errorCode(e)}`);
      ctx.log.warn({ issue: identifier, code: errorCode(e), err: errorText(e) }, "stop: block incomplete");
      return;
    }
  }
}

/** (2) + (3) for each record: its workers, its worktree's terminals and processes, and its child worktrees'. */
async function stopAgentsOf(
  ctx: Ctx,
  targets: WRecord[],
  fleet: FleetSnapshot | null,
  handled: Set<string>,
  report: StopReport,
): Promise<void> {
  for (const r of targets) {
    try {
      const { unverifiable } = await stopAgents(ctx, r);
      report.unverifiable.push(...unverifiable);
      if (!r.worktree) continue;
      handled.add(r.worktree.id);
      report.sweptWorktrees.push(r.worktree.path);
      const row = fleet?.worktrees.find((w) => w.worktreeId === r.worktree?.id);
      for (const childId of row?.childWorktreeIds ?? []) {
        const child = fleet?.worktrees.find((w) => w.worktreeId === childId);
        if (!child || handled.has(childId)) continue;
        handled.add(childId);
        await closeAndSweep(ctx, childId, child.path, report);
      }
    } catch (e) {
      // the record is still blocked below, which stops its agents again
      ctx.log.warn({ issue: r.identifier, code: errorCode(e), err: errorText(e) }, "stop: agent stop failed");
    }
  }
}

/** `--all`: every `wm-` worktree in the fleet with a working agent that no record covered (§13.3 i step 2). */
async function sweepUnrecorded(
  ctx: Ctx,
  fleet: FleetSnapshot | null,
  handled: Set<string>,
  report: StopReport,
): Promise<void> {
  for (const row of fleet?.worktrees ?? []) {
    const wm = row.displayName.startsWith("wm-") || basename(row.path).startsWith("wm-");
    if (!wm || handled.has(row.worktreeId) || !row.agents.some((a) => a.state === "working")) continue;
    handled.add(row.worktreeId);
    await closeAndSweep(ctx, row.worktreeId, row.path, report).catch((e: unknown) =>
      ctx.log.warn({ code: errorCode(e), err: errorText(e) }, "stop: worktree sweep failed"),
    );
  }
}

export async function stop(ctx: Ctx, scope: StopScope, reason: string): Promise<StopReport> {
  const why = stopReason(reason);
  const entry = { scope: scope.kind, ...(scope.kind === "all" ? {} : { key: scope.key }), at: ctx.now() };
  await requestStop(ctx.dirs, { ...entry, reason: why }); // (1) before anything else
  const report: StopReport = {
    scope,
    stopped: [],
    deferred: [],
    failed: [],
    unverifiable: [],
    sweptWorktrees: [],
    flagCleared: false,
  };
  const fleet: FleetSnapshot | null = await ctx.orca.worktreePs().catch((e: unknown) => {
    ctx.log.warn({ code: errorCode(e) }, "stop: fleet unreadable; child and unrecorded worktrees not swept");
    return null;
  });
  const detail = `stopped by the owner (wingmate stop ${scopeFlag(scope)}): ${why}`;
  const handled = new Set<string>();
  const seen = new Set<string>();
  // a second pass catches a record a running tick created after the first listing (its claim aborts at its next external action)
  for (let pass = 0; pass < 2; pass++) {
    const targets = (await readRecords(ctx, pass === 0 ? report.failed : [])).filter(
      (r) => ACTIVE.has(r.stage) && inScope(scope, r) && !seen.has(r.identifier),
    );
    for (const r of targets) seen.add(r.identifier);
    await stopAgentsOf(ctx, targets, fleet, handled, report); // (2) + (3), no lock held
    if (pass === 0 && scope.kind === "all") await sweepUnrecorded(ctx, fleet, handled, report);
    for (const t of targets) await blockOne(ctx, t.identifier, detail, report); // (4)
  }
  const stuck = report.failed.filter((f) => !f.endsWith(":record_invalid"));
  if (stuck.length === 0) {
    await releaseStop(ctx.dirs, entry);
    report.flagCleared = true;
  }
  await ctx.ledger.append({
    at: ctx.now(),
    issue: null,
    type: "stop",
    data: {
      scope: scope.kind,
      key: scope.kind === "all" ? null : scope.key,
      reason: why,
      stopped: report.stopped,
      deferred: report.deferred,
      failed: report.failed,
      unverifiable: report.unverifiable,
      flagCleared: report.flagCleared,
    },
  });
  return report;
}
