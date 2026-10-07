// src/machine/outbox.ts — executes the intents the `issue` verbs wrote into the worktree (§6.3 step 2, §8.1), each re-validated
// against the dispatcher's own record and Orca (§13.3 a), in order, with quarantine for files that can never execute.
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Intent, consumeIntent, outboxDirs, quarantineIntent, readIntentFiles } from "../kit/intents";
import { readNoFollow, worktreeFile } from "../kit/local";
import { MARK } from "../linear/markers";
import { renderQuestion } from "../linear/templates";
import { OrcaError } from "../orca/cli";
import { scanText } from "../policy/secrets";
import type { LinearIssue } from "../ports";
import { WingmateError, errorCode, errorText } from "../shared/errors";
import { PIPELINE, type WRecord } from "../state/records";
import type { Ctx } from "./context";
import { isTickAbort } from "./guard";
import { LinearWrites } from "./linearWrites";
import { syncMirror } from "./mirror";
import type { Reconciled } from "./reconcile";
import { coordinatorMarker } from "./resume";
import { saveRecord } from "./save";
import { addAttention, dropAttention, enterPipelineStage, stageOf, transition } from "./states";
import { addNote, syncStatus } from "./status";
import { WORKING } from "./step";

type Of<K extends Intent["kind"]> = Extract<Intent, { kind: K }>;
export type HandoffIntent = Of<"handoff">;
export interface OutboxResult {
  executed: number;
  failed: number;
  quarantined: number;
  parked: boolean;
  finished: boolean;
  /** §8.1 `finish`: a refused publish pointed the coordinator at its finding in this tick — one of the tick's resumes. */
  resumed: boolean;
  /** A `handoff` intent for the tick to perform (§9.4, or a reroute with `repo`). */
  handoff: Of<"handoff"> | null;
}
export interface OutboxOptions {
  /** False in reconcile-only ticks and after the tick's one handoff: a `handoff` intent then stays pending. */
  canHandoff: boolean;
  /**
   * False in reconcile-only ticks and once the tick's resumes are spent: a `finish` intent then stays pending, because a refused
   * publish delivers its pointer in the same tick as a resume (§8.1, §6.7).
   */
  canResume: boolean;
}
interface Run {
  ctx: Ctx;
  r: WRecord;
  issue: LinearIssue;
  rec: Reconciled;
  wt: string;
  res: OutboxResult;
  w: LinearWrites;
}

/** Failures that drop the intent at once (the agent re-asks or re-runs the verb); everything else is retried. */
const CONSUMED_ON_FAILURE = new Set(["secret_detected", "workers_live"]);
const MAX_FAILURES = 3;
const TEXT_MAX_BYTES = 64 * 1024;
const EVIDENCE_MAX_BYTES = 2 * 1024 * 1024;
const PASSED = new Set(["PASS", "NA"]);

/** Linear, Orca, git and GitHub trouble is not the intent's fault: it never counts towards the quarantine. */
const isInfra = (e: unknown) =>
  e instanceof OrcaError || (e instanceof WingmateError && /^(linear|git|gh)_/.test(e.code));

async function agentText(x: Run, rel: string): Promise<string> {
  const f = await worktreeFile(x.wt, rel);
  if (!f.ok) throw new WingmateError("file_invalid", f.error);
  return (await readNoFollow(f.abs, TEXT_MAX_BYTES)).toString("utf8");
}

async function assertNoLiveWorkers(ctx: Ctx, r: WRecord): Promise<void> {
  if (!r.coordinator.childRunId) return;
  const live = (await ctx.orca.workerList(r.coordinator.childRunId)).filter((w) => w.verdict === "live");
  if (live.length)
    throw new WingmateError("workers_live", `live workers: ${live.map((w) => w.dispatchId).join(",")}`);
}

/** §8.0: evidence and the plan/decisions are copied to `<state>/evidence/<id>/<cycle>/` so losing the worktree loses no history. */
async function copyEvidence(x: Run, rel: string): Promise<void> {
  const f = await worktreeFile(x.wt, rel, ".wingmate/evidence");
  if (!f.ok) throw new WingmateError("evidence_invalid", f.error);
  const files = [f];
  for (const extra of [".wingmate/plan.md", ".wingmate/decisions.md"]) {
    const e = await worktreeFile(x.wt, extra);
    if (e.ok) files.push(e);
  }
  for (const file of files) {
    const data = await readNoFollow(file.abs, EVIDENCE_MAX_BYTES + 1);
    if (data.length > EVIDENCE_MAX_BYTES) continue; // the evidence stays in the worktree; the copy is bounded
    const dest = join(
      x.ctx.dirs.evidence,
      x.r.identifier,
      String(x.r.cycle),
      file.rel.replace(/^\.wingmate\//, ""),
    );
    await mkdir(dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 }); // bytes as they are: screenshots are evidence too
    await rename(tmp, dest);
  }
}

async function gate(x: Run, i: Of<"gate">): Promise<void> {
  const { ctx, r } = x;
  const { stage, verdict } = i.payload;
  const idx = PIPELINE.indexOf(stage);
  const missing = PIPELINE.slice(0, idx).filter((s) => !PASSED.has(r.gates[s].verdict ?? ""));
  if (missing.length)
    throw new WingmateError("stage_prerequisite", `${stage} gated before ${missing.join(",")} passed`);
  const g = r.gates[stage];
  if (verdict === "FAIL" && g.failCount >= 2)
    throw new WingmateError("gate_retry_exhausted", `${stage} failed twice already`);
  if (verdict === "NA" && stage !== "ui")
    throw new WingmateError("verdict_not_allowed", "NA applies only to ui");
  if (verdict !== "NA" && !i.payload.evidencePath)
    throw new WingmateError("evidence_required", `${stage} ${verdict} names no evidence file`);
  if (i.payload.evidencePath) await copyEvidence(x, i.payload.evidencePath);
  g.verdict = verdict;
  g.at = i.createdAt;
  g.evidencePath = i.payload.evidencePath;
  g.note = i.payload.note;
  g.headSha = i.payload.headSha;
  g.dispatchId = i.payload.dispatchId;
  if (verdict === "FAIL") g.failCount += 1;
  if (i.payload.method) r.method = i.payload.method;
  // §13.3(a) wants planVerify read from `worker-show` of the named Dispatch; that verification lands in slice 2
  if (stage === "planVerify") addAttention(r, "plan_verify_unverified");
  if (verdict !== "FAIL")
    enterPipelineStage(ctx, r, PIPELINE[Math.min(idx + 1, PIPELINE.length - 1)] ?? "pr");
  addNote(r, `gate ${stage} ${verdict}`);
}

/** §7.1 step 2: post (or, for `--append`/`--reask`, edit) the question, `Needs-Human`, park, and sweep all but the session. */
async function ask(x: Run, i: Of<"ask">): Promise<void> {
  const { ctx, r, issue, w } = x;
  if (r.stage !== "working") throw new WingmateError("stage_mismatch", `ask while ${r.stage}`);
  await assertNoLiveWorkers(ctx, r);
  const text = await agentText(x, i.payload.questionFile);
  if (scanText(text).length)
    throw new WingmateError("secret_detected", "the question text holds a secret-like token");
  const target = i.payload.append ?? i.payload.reask;
  const q = target ? r.questions.find((y) => y.id === target) : undefined;
  const body = renderQuestion({
    identifier: r.identifier,
    questionId: q?.id ?? i.id,
    stage: r.pipelineStage,
    context: text,
    options: i.payload.options,
    recommend: i.payload.recommend,
    mention: `@[owner](${ctx.cfg.workspace.owner})`,
  });
  if (q?.commentId) {
    await w.editComment(r, q.commentId, body);
    // F6: a re-opened question starts its answers afresh (§7.1 step 4: at most two attempts per answer, not per question)
    Object.assign(q, {
      askedAt: ctx.now(),
      status: "open",
      answerCommentId: null,
      answeredAt: null,
      resumeAttempts: 0,
    });
  } else {
    const commentId = await w.postComment(r, issue, body, { key: `ask:${i.id}` });
    const known = r.questions.find((y) => y.id === i.id);
    if (known) Object.assign(known, { commentId, status: "open" });
    else
      r.questions.push({
        id: i.id,
        commentId,
        askedAt: ctx.now(),
        status: "open",
        answerCommentId: null,
        answeredAt: null,
        resumeAttempts: 0,
        nonAnswerCommentIds: [],
      });
  }
  await w.setLifecycle(r, issue, "Needs-Human");
  await transition(ctx, r, "awaiting-human", "ask");
  const spare = coordinatorMarker(r);
  const swept = await ctx.sweep([x.wt], spare ? { spare } : {});
  await ctx.ledger.append({
    at: ctx.now(),
    issue: r.identifier,
    type: "process_sweep",
    data: { killed: swept.killed, commands: swept.commands ?? [], why: "park" },
  });
  x.res.parked = true;
  if (r.worktree)
    await ctx.orca
      .worktreeSet(r.worktree.id, { comment: "waiting: question for owner" })
      .catch((e: unknown) => {
        if (isTickAbort(e)) throw e;
        ctx.log.warn({ issue: r.identifier, err: errorText(e) }, "worktree set failed");
      });
}

async function finish(x: Run, i: Of<"finish">): Promise<void> {
  const { ctx, r } = x;
  if (r.stage !== "working") throw new WingmateError("stage_mismatch", `finish while ${r.stage}`);
  await assertNoLiveWorkers(ctx, r);
  const sf = await worktreeFile(x.wt, i.payload.summaryFile);
  if (!sf.ok) throw new WingmateError("file_invalid", sf.error);
  enterPipelineStage(ctx, r, "pr");
  const { publish } = await ctx.publishImpl();
  x.res.finished = await publish(ctx, r, x.issue, i, x.rec);
  // publish is false only when the guards refused: a first refusal leaves the record working with its pointer delivered (a resume),
  // the second of the cycle blocks it
  x.res.resumed = !x.res.finished && WORKING.has(stageOf(r));
}

/**
 * F8 (§8.1, §13.3 a): a `run` intent names the child Run by an agent-written id, so it is adopted only when Orca lists that Run
 * with this record's coordinator terminal as its `coordinator_handle`; anything else is a counted failure (the id is not echoed).
 */
async function adoptRun(x: Run, i: Of<"run">): Promise<void> {
  const handle = x.r.coordinator.terminalHandle;
  const run = (await x.ctx.orca.runList()).find((y) => y.id === i.payload.runId);
  if (!run) throw new WingmateError("run_unknown", "the named run is not in orca run-list");
  if (!handle || run.coordinatorHandle !== handle)
    throw new WingmateError("run_not_owned", "the named run is not coordinated by this issue's terminal");
  x.r.coordinator.childRunId = run.id;
}

function handoff(x: Run, i: Of<"handoff">): void {
  const repo = i.payload.repo;
  if (repo && !x.ctx.cfg.projects[x.r.project]?.repos[repo])
    throw new WingmateError("unknown_repo", `repo ${repo} is not in project ${x.r.project}`);
  const reason = scanText(i.payload.reason).length
    ? "(reason withheld: secret-like text)"
    : i.payload.reason.slice(0, 120);
  x.res.handoff = i;
  addNote(x.r, `handoff requested: ${reason}${repo ? ` → ${repo}` : ""}`);
}

async function followup(x: Run, i: Of<"followup">): Promise<void> {
  const body = await agentText(x, i.payload.bodyFile);
  if (scanText(`${i.payload.title}\n${body}`).length)
    throw new WingmateError("secret_detected", "the follow-up title or body holds a secret-like token");
  const description = `${MARK.followup(x.r.identifier)}\n${body}`;
  const created = await x.w.createFollowup(
    x.r,
    x.issue,
    i.payload.title.slice(0, 200),
    description,
    `followup:${i.id}`,
  );
  // §8.1: the completion comment lists the follow-ups created (a replay may ledger one twice; the listing takes each once)
  await x.ctx.ledger.append({
    at: x.ctx.now(),
    issue: x.r.identifier,
    type: "followup_created",
    data: { identifier: created.identifier },
  });
  addNote(x.r, `follow-up ${created.identifier}`);
}

async function execute(x: Run, i: Intent): Promise<void> {
  switch (i.kind) {
    case "note":
      if (scanText(i.payload.text).length) {
        addAttention(x.r, "secret_detected");
        await x.ctx.ledger.append({
          at: x.ctx.now(),
          issue: x.r.identifier,
          type: "secret_detected",
          data: { where: "note" },
        });
      } else addNote(x.r, i.payload.text);
      return;
    case "run":
      return adoptRun(x, i);
    case "gate":
      return gate(x, i);
    case "ask":
      return ask(x, i);
    case "finish":
      return finish(x, i);
    case "handoff":
      return handoff(x, i);
    case "followup":
      return followup(x, i);
  }
}

async function quarantine(x: Run, file: string, where: "invalid" | "failed", data: Record<string, unknown>) {
  await quarantineIntent(x.wt, file, where);
  addAttention(x.r, where === "invalid" ? "intent_invalid" : "intent_failed");
  x.res.quarantined += 1;
  const type = where === "invalid" ? "intent_invalid" : "intent_quarantined";
  await x.ctx.ledger.append({ at: x.ctx.now(), issue: x.r.identifier, type, data: { file, ...data } });
}

async function priorFailures(ctx: Ctx, r: WRecord, id: string): Promise<number> {
  return (await ctx.ledger.readIssue(r.identifier)).filter(
    (e) => e.type === "intent_failed" && e.data.id === id && e.data.counted === true,
  ).length;
}

async function failed(x: Run, i: Intent, err: unknown): Promise<void> {
  const { ctx, r } = x;
  x.res.failed += 1;
  const code = errorCode(err);
  const consumed = CONSUMED_ON_FAILURE.has(code);
  const counted = !consumed && !isInfra(err);
  const failures = counted ? (await priorFailures(ctx, r, i.id)) + 1 : 0;
  await ctx.ledger.append({
    at: ctx.now(),
    issue: r.identifier,
    type: "intent_failed",
    data: { kind: i.kind, id: i.id, code, counted },
  });
  ctx.log.warn(
    { issue: r.identifier, intent: i.id, kind: i.kind, code, err: errorText(err) },
    "intent failed",
  );
  if (consumed) {
    await consumeIntent(x.wt, i.id);
    addAttention(r, code);
  } else if (failures >= MAX_FAILURES) await quarantine(x, `${i.id}.json`, "failed", { kind: i.kind, code });
}

/** One intent: executed and consumed (its effects written first), or failed — the caller then stops, keeping the order. */
async function runIntent(x: Run, i: Intent): Promise<boolean> {
  try {
    await execute(x, i);
  } catch (err) {
    if (isTickAbort(err)) throw err;
    await failed(x, i, err);
    return false;
  }
  x.r.timers.lastActivityAt = x.ctx.now(); // §9.6: an executed intent is activity
  await saveRecord(x.ctx, x.r); // effects on disk before the intent leaves the outbox
  x.res.executed += 1;
  if (i.kind === "handoff") return true; // F2: consumed by the tick once the handoff is on disk (`consumeHandoff`)
  await consumeIntent(x.wt, i.id);
  await x.ctx.ledger.append({
    at: x.ctx.now(),
    issue: x.r.identifier,
    type: "intent_executed",
    data: { kind: i.kind, id: i.id },
  });
  return true;
}

/**
 * F2: a `handoff` intent leaves the outbox (of the worktree it was written in) only once the tick's handoff, reroute or block it led
 * to is on disk; a failure before that leaves it pending, so the agent's request is retried, never lost.
 */
export async function consumeHandoff(
  ctx: Ctx,
  r: WRecord,
  wt: string,
  i: Of<"handoff"> | null,
): Promise<void> {
  if (!i) return;
  await consumeIntent(wt, i.id);
  await ctx.ledger.append({
    at: ctx.now(),
    issue: r.identifier,
    type: "intent_executed",
    data: { kind: i.kind, id: i.id },
  });
}

async function drain(x: Run, opts: OutboxOptions): Promise<void> {
  // F7: every directory a move lands in is checked first, so an intent that could not be consumed never executes
  for (const sub of ["done", "invalid", "failed"] as const) await outboxDirs(x.wt, sub);
  dropAttention(x.r, "outbox_unsafe");
  const { intents, invalid } = await readIntentFiles(x.wt);
  for (const bad of invalid) await quarantine(x, bad.file, "invalid", { error: bad.error.slice(0, 200) });
  for (const i of intents) {
    if (i.issue !== x.r.identifier) {
      await quarantine(x, `${i.id}.json`, "invalid", { error: `an intent for ${i.issue}` });
      continue;
    }
    if (i.kind === "handoff" && !opts.canHandoff) break; // stays pending for a later tick
    if (i.kind === "finish" && !opts.canResume) break; // so does a finish: its refusal would be a resume (§8.1)
    if (!(await runIntent(x, i))) break;
    // parked, handed off, published — or no longer working at all (a second refused publish blocks): the rest waits
    if (x.res.parked || x.res.handoff || x.res.finished || !WORKING.has(stageOf(x.r))) break;
  }
}

/** F7: an outbox (or one of its subdirectories) that is a symlink or not a directory is never read or moved into: surfaced only. */
async function unsafeOutbox(x: Run, e: unknown): Promise<void> {
  addAttention(x.r, "outbox_unsafe");
  await x.ctx.ledger.append({
    at: x.ctx.now(),
    issue: x.r.identifier,
    type: "outbox_unsafe",
    data: { error: errorText(e).slice(0, 200) },
  });
  x.ctx.log.warn({ issue: x.r.identifier, code: "outbox_unsafe" }, "outbox refused");
}

async function pendingCount(x: Run): Promise<number> {
  try {
    return (await readIntentFiles(x.wt)).intents.length;
  } catch (e) {
    if (errorCode(e) !== "outbox_unsafe") throw e;
    return x.r.outbox.pending;
  }
}

export async function executeOutbox(
  ctx: Ctx,
  r: WRecord,
  issue: LinearIssue,
  rec: Reconciled,
  opts: OutboxOptions = { canHandoff: true, canResume: true },
): Promise<OutboxResult> {
  const res: OutboxResult = {
    executed: 0,
    failed: 0,
    quarantined: 0,
    parked: false,
    finished: false,
    resumed: false,
    handoff: null,
  };
  if (!r.worktree) return res;
  // F10: a worktree removed from disk has no outbox; skipping it lets liveness take the exited path (relaunch → worktree_gone)
  if (!existsSync(r.worktree.path)) return res;
  const x: Run = { ctx, r, issue, rec, wt: r.worktree.path, res, w: new LinearWrites(ctx) };
  try {
    await drain(x, opts);
  } catch (e) {
    if (errorCode(e) !== "outbox_unsafe") throw e;
    await unsafeOutbox(x, e);
  }
  r.outbox = { pending: await pendingCount(x), lastDrainedAt: ctx.now() };
  await saveRecord(ctx, r);
  await syncMirror(r);
  if (res.executed + res.failed > 0) await syncStatus(ctx, r, issue); // Ruling R1: only when an intent ran
  return res;
}
