// tests/unit/machine/outbox.test.ts — intent execution: quarantine, re-validation, agent-named files, the local mirror, R1
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { writeIntent } from "../../../src/kit/intents";
import { claimIssue } from "../../../src/machine/claim";
import { executeOutbox } from "../../../src/machine/outbox";
import { reconcile } from "../../../src/machine/reconcile";
import type { LinearIssue } from "../../../src/ports";
import { type WRecord, readRecord } from "../../../src/state/records";
import { addLabeledByOwner, todo } from "../../fakes/issues";
import { type World, makeWorld, stubPublish } from "../../fakes/world";

const ID = "JRF-501";
async function issueOf(w: World): Promise<LinearIssue> {
  const [i] = await w.linear.getIssues(["i1"]);
  if (!i) throw new Error("issue missing");
  return i;
}
async function claimed(): Promise<{ w: World; r: WRecord; wt: string }> {
  const w = await makeWorld();
  addLabeledByOwner(w.linear, todo("i1", ID));
  const project = w.cfg.projects.bouncr;
  if (!project) throw new Error("bouncr missing");
  const r = await claimIssue(w.ctx, {
    issue: await issueOf(w),
    project,
    provider: "claude",
    repoName: "api",
    routing: { basis: "default", candidates: [], rerouteFrom: null },
  });
  return { w, r, wt: r.worktree?.path ?? "" };
}
/** One outbox pass on a freshly read record, as the tick does it. */
async function drain(w: World, opts = { canHandoff: true, canResume: true }) {
  const r = await readRecord(w.dirs, ID);
  if (!r) throw new Error("record missing");
  const res = await executeOutbox(w.ctx, r, await issueOf(w), await reconcile(w.ctx), opts);
  return { r, res };
}
const outbox = (wt: string, sub = "") => {
  const d = join(wt, ".wingmate", "outbox", sub);
  return existsSync(d) ? readdirSync(d).filter((n) => n.endsWith(".json")) : [];
};
const file = (wt: string, rel: string, text: string) => {
  mkdirSync(join(wt, rel, ".."), { recursive: true });
  writeFileSync(join(wt, rel), text);
};
const questionComments = (w: World) =>
  w.linear.comments.filter((c) => c.body.startsWith("<!-- wingmate:question"));
const statusEdits = (w: World) => w.linear.writes.filter((x) => x.kind === "commentUpdate").length;
const ask = (wt: string, extra: Partial<{ append: string | null; reask: string | null }> = {}) =>
  writeIntent(wt, {
    issue: ID,
    kind: "ask",
    payload: {
      questionFile: ".wingmate/q.md",
      options: ["ms", "us"],
      recommend: 1,
      append: null,
      reask: null,
      ...extra,
    },
  });

describe("executeOutbox: quarantine (Task 9 carry-over)", () => {
  test("an unparseable file moves to outbox/invalid/ with attention intent_invalid; the valid intent behind it still runs", async () => {
    const { w, wt } = await claimed();
    writeFileSync(join(wt, ".wingmate", "outbox", "0000BAD.json"), "{ not json");
    await writeIntent(wt, { issue: ID, kind: "note", payload: { text: "progress" } });
    const { r, res } = await drain(w);
    expect(res).toMatchObject({ executed: 1, quarantined: 1 });
    expect(outbox(wt, "invalid")).toEqual(["0000BAD.json"]);
    expect(r.attention).toContain("intent_invalid");
    expect(outbox(wt)).toEqual([]);
  });

  test("an intent for another issue is quarantined as invalid, never executed", async () => {
    const { w, wt } = await claimed();
    await writeIntent(wt, { issue: "JRF-999", kind: "note", payload: { text: "elsewhere" } });
    const { res } = await drain(w);
    expect(res).toMatchObject({ executed: 0, quarantined: 1 });
    expect(outbox(wt, "invalid")).toHaveLength(1);
  });

  test("an intent failing three times moves to outbox/failed/ with attention intent_failed; the next one runs afterwards", async () => {
    const { w, wt } = await claimed();
    file(wt, ".wingmate/evidence/impl.md", "done");
    await writeIntent(wt, {
      issue: ID,
      kind: "gate",
      payload: {
        stage: "implement",
        verdict: "PASS",
        evidencePath: ".wingmate/evidence/impl.md",
        note: null,
        method: null,
        headSha: null,
        dispatchId: null,
      },
    });
    await writeIntent(wt, { issue: ID, kind: "note", payload: { text: "after" } });
    for (let n = 0; n < 2; n++)
      expect((await drain(w)).res).toMatchObject({ executed: 0, failed: 1, quarantined: 0 });
    const third = await drain(w);
    expect(third.res).toMatchObject({ failed: 1, quarantined: 1 });
    expect(outbox(wt, "failed")).toHaveLength(1);
    expect(third.r.attention).toContain("intent_failed");
    expect((await drain(w)).res).toMatchObject({ executed: 1, failed: 0 });
    const codes = (await w.ctx.ledger.readIssue(ID))
      .filter((e) => e.type === "intent_failed")
      .map((e) => e.data.code);
    expect(codes).toEqual(["stage_prerequisite", "stage_prerequisite", "stage_prerequisite"]);
  });

  test("Linear trouble never counts toward the quarantine", async () => {
    const { w, wt } = await claimed();
    file(wt, ".wingmate/q.md", "Milliseconds or microseconds?");
    await ask(wt);
    for (let n = 0; n < 4; n++) {
      w.linear.failNext = "issueUpdate";
      expect((await drain(w)).res).toMatchObject({ failed: 1, quarantined: 0 });
    }
    expect(outbox(wt)).toHaveLength(1);
    const failed = (await w.ctx.ledger.readIssue(ID)).filter((e) => e.type === "intent_failed");
    expect(failed.every((e) => e.data.counted === false)).toBe(true);
  });

  test("secret_detected and workers_live drop the intent at once (outbox/done/) with attention", async () => {
    const { w, wt } = await claimed();
    file(wt, ".wingmate/q.md", `key: ${"sk-ant-api03-"}${"B".repeat(30)}`);
    await ask(wt);
    const first = await drain(w);
    expect(first.res).toMatchObject({ failed: 1 });
    expect(first.r.attention).toContain("secret_detected");
    expect(outbox(wt)).toEqual([]);
    expect(outbox(wt, "done")).toHaveLength(1);
    expect(questionComments(w)).toEqual([]);
    file(wt, ".wingmate/q.md", "plain question");
    const r = await readRecord(w.dirs, ID);
    if (!r) throw new Error("record missing");
    r.coordinator.childRunId = "run_1";
    const { writeRecord } = await import("../../../src/state/records");
    await writeRecord(w.dirs, r);
    w.orca.workers.set("run_1", [
      {
        dispatchId: "ctx_1",
        taskId: "t",
        runId: "run_1",
        workerState: "running",
        dispatchStatus: "active",
        agentTerminalHandle: null,
        verdict: "live",
      },
    ]);
    await ask(wt);
    const second = await drain(w);
    expect(second.r.attention).toContain("workers_live");
    expect(outbox(wt, "done")).toHaveLength(2);
    expect(second.r.stage).toBe("working");
  });
});

describe("executeOutbox: F7 — an agent-planted symlink never redirects an outbox move", () => {
  test("outbox/invalid → the kit dir: nothing is quarantined into it, the kit settings stay the dispatcher's, attention outbox_unsafe", async () => {
    const { w, wt } = await claimed();
    const kit = w.ctx.kitDirFor(ID);
    const before = readFileSync(join(kit, "claude-settings.json"), "utf8");
    symlinkSync(kit, join(wt, ".wingmate", "outbox", "invalid"));
    writeFileSync(
      join(wt, ".wingmate", "outbox", "claude-settings.json"),
      JSON.stringify({ sandbox: { enabled: false, filesystem: { denyWrite: [] } } }),
    );
    const { r, res } = await drain(w);
    expect(res).toMatchObject({ executed: 0, quarantined: 0 });
    expect(readFileSync(join(kit, "claude-settings.json"), "utf8")).toBe(before);
    expect(r.attention).toContain("outbox_unsafe");
    expect(existsSync(join(wt, ".wingmate", "outbox", "claude-settings.json"))).toBe(true);
  });

  test("outbox/done → the kit dir: no intent executes (it could never be consumed), the kit stays untouched", async () => {
    const { w, wt } = await claimed();
    const kit = w.ctx.kitDirFor(ID);
    const listing = readdirSync(kit).sort();
    symlinkSync(kit, join(wt, ".wingmate", "outbox", "done"));
    await writeIntent(wt, { issue: ID, kind: "note", payload: { text: "progress" } });
    const { r, res } = await drain(w);
    expect(res).toMatchObject({ executed: 0, failed: 0 });
    expect(readdirSync(kit).sort()).toEqual(listing);
    expect(r.attention).toContain("outbox_unsafe");
    expect(outbox(wt)).toHaveLength(1);
  });

  test("F10: a worktree removed from disk is skipped — nothing thrown, executed or re-created, the record left as it was", async () => {
    const { w, wt } = await claimed();
    rmSync(wt, { recursive: true, force: true });
    const { r, res } = await drain(w);
    expect(res).toEqual({
      executed: 0,
      failed: 0,
      quarantined: 0,
      parked: false,
      finished: false,
      resumed: false,
      handoff: null,
    });
    expect(existsSync(wt)).toBe(false);
    expect(r.attention).not.toContain("outbox_unsafe");
    expect(await readRecord(w.dirs, ID)).toEqual(r); // no write: liveness owns what happens next
    expect(w.linear.writes.filter((x) => x.kind === "commentUpdate")).toEqual([]);
  });
});

describe("executeOutbox: F8 — a `run` intent adopts only a Run this coordinator owns (§8.1, §13.3 a)", () => {
  const runIntent = (wt: string, runId: string) =>
    writeIntent(wt, { issue: ID, kind: "run", payload: { runId } });
  const lastFailure = async (w: World) =>
    (await w.ctx.ledger.readIssue(ID)).filter((e) => e.type === "intent_failed").at(-1)?.data;

  test("a Run orca run-list does not know is refused (a counted failure); nothing is adopted", async () => {
    const { w, wt } = await claimed();
    await runIntent(wt, "run_ghost");
    const { r, res } = await drain(w);
    expect(res).toMatchObject({ executed: 0, failed: 1 });
    expect(r.coordinator.childRunId).toBeNull();
    expect(await lastFailure(w)).toMatchObject({ code: "run_unknown", counted: true });
  });

  test("another issue's Run (coordinated by another terminal) is refused; the coordinator's own Run is adopted", async () => {
    const { w, wt, r: claimedRec } = await claimed();
    w.orca.runs = [
      { id: "run_foreign", coordinatorHandle: "term_99" },
      { id: "run_mine", coordinatorHandle: claimedRec.coordinator.terminalHandle },
    ];
    await runIntent(wt, "run_foreign");
    const foreign = await drain(w);
    expect(foreign.r.coordinator.childRunId).toBeNull();
    expect(await lastFailure(w)).toMatchObject({ code: "run_not_owned", counted: true });
    const { w: w2, wt: wt2, r: r2 } = await claimed();
    w2.orca.runs = [{ id: "run_mine", coordinatorHandle: r2.coordinator.terminalHandle }];
    await runIntent(wt2, "run_mine");
    const mine = await drain(w2);
    expect(mine.res).toMatchObject({ executed: 1, failed: 0 });
    expect(mine.r.coordinator.childRunId).toBe("run_mine");
  });
});

describe("executeOutbox: agent-named files go through worktreeFile()", () => {
  test("a question file that is a symlink is refused (file_invalid) and never read or posted", async () => {
    const { w, wt } = await claimed();
    const outside = join(w.root, "outside.txt");
    writeFileSync(outside, "owner secrets");
    symlinkSync(outside, join(wt, ".wingmate", "q.md"));
    await ask(wt);
    const { res } = await drain(w);
    expect(res.failed).toBe(1);
    expect(questionComments(w)).toEqual([]);
    expect((await w.ctx.ledger.readIssue(ID)).find((e) => e.type === "intent_failed")?.data.code).toBe(
      "file_invalid",
    );
  });

  test("finish validates the summary file before publishing", async () => {
    const { w, wt } = await claimed();
    w.ctx.publishImpl = async () => ({ publish: stubPublish }); // the summary-file check, not publishing itself
    await writeIntent(wt, {
      issue: ID,
      kind: "finish",
      payload: { summaryFile: ".wingmate/s.md", title: null, draft: false, repos: [] },
    });
    expect((await drain(w)).res).toMatchObject({ failed: 1, finished: false });
    file(wt, ".wingmate/s.md", "Implemented the leaderboard.");
    const { r, res } = await drain(w);
    expect(res).toMatchObject({ executed: 1, finished: true });
    expect(r.stage).toBe("review");
  });
});

describe("executeOutbox: the local mirror", () => {
  test("record.json follows the record; gates.json and run.json are never rewritten; a pending ask's question survives the merge", async () => {
    const { w, wt } = await claimed();
    const gates = JSON.stringify({
      intake: {
        verdict: "PASS",
        failCount: 0,
        at: null,
        evidencePath: null,
        headSha: null,
        note: null,
        method: "loop",
        dispatchId: null,
      },
    });
    writeFileSync(join(wt, ".wingmate", "gates.json"), gates);
    writeFileSync(join(wt, ".wingmate", "run.json"), '{"childRunId":"run_9"}');
    await writeIntent(wt, {
      issue: ID,
      kind: "handoff",
      payload: { reason: "wrong_repo_guess", repo: null },
    });
    file(wt, ".wingmate/q.md", "later question");
    const pending = await ask(wt);
    writeFileSync(
      join(wt, ".wingmate", "questions.json"),
      JSON.stringify([
        { id: pending.id, status: "open", askedAt: pending.createdAt },
        { id: "01STALEQUESTION", status: "open", askedAt: pending.createdAt },
      ]),
    );
    const edits = statusEdits(w);
    const { res } = await drain(w, { canHandoff: false, canResume: true });
    expect(res).toMatchObject({ executed: 0, failed: 0, handoff: null });
    expect(statusEdits(w)).toBe(edits); // Ruling R1: nothing ran, no status edit
    expect(readFileSync(join(wt, ".wingmate", "gates.json"), "utf8")).toBe(gates);
    expect(readFileSync(join(wt, ".wingmate", "run.json"), "utf8")).toBe('{"childRunId":"run_9"}');
    const qs = JSON.parse(readFileSync(join(wt, ".wingmate", "questions.json"), "utf8")) as { id: string }[];
    expect(qs.map((q) => q.id)).toEqual([pending.id]);
    const rec = JSON.parse(readFileSync(join(wt, ".wingmate", "record.json"), "utf8"));
    expect(rec).toMatchObject({ identifier: ID, stage: "working", pipelineStage: "intake" });
    const handed = await drain(w, { canHandoff: true, canResume: true });
    expect(handed.res.handoff?.payload.reason).toBe("wrong_repo_guess");
    expect(statusEdits(w)).toBe(edits + 1); // R1: an executed intent refreshes the status once
  });
});

describe("executeOutbox: gate and ask re-validated against the record", () => {
  test("gates advance the stage with its own cap and copy evidence; planVerify is accepted unverified; a third FAIL is refused", async () => {
    const { w, wt } = await claimed();
    const gate = (
      stage: "intake" | "plan" | "planVerify" | "implement",
      verdict: "PASS" | "FAIL",
      ev: string,
      method: "loop" | null = null,
    ) =>
      writeIntent(wt, {
        issue: ID,
        kind: "gate",
        payload: {
          stage,
          verdict,
          evidencePath: ev,
          note: null,
          method,
          headSha: "h",
          dispatchId: stage === "planVerify" ? "ctx_v" : null,
        },
      });
    file(wt, ".wingmate/evidence/assumptions.md", "none");
    file(wt, ".wingmate/plan.md", "the plan");
    await gate("intake", "PASS", ".wingmate/evidence/assumptions.md", "loop");
    let { r } = await drain(w);
    expect(r.pipelineStage).toBe("plan");
    expect(r.timers.capMin).toBe(45);
    expect(r.method).toBe("loop");
    const ev = join(w.dirs.evidence, ID, "1");
    expect(readFileSync(join(ev, "evidence", "assumptions.md"), "utf8")).toBe("none");
    expect(readFileSync(join(ev, "plan.md"), "utf8")).toBe("the plan");
    await gate("plan", "PASS", ".wingmate/evidence/assumptions.md");
    await gate("planVerify", "PASS", ".wingmate/evidence/assumptions.md");
    for (let n = 0; n < 2; n++) ({ r } = await drain(w));
    expect(r.attention).toContain("plan_verify_unverified");
    expect(r.pipelineStage).toBe("implement");
    for (let n = 0; n < 3; n++) await gate("implement", "FAIL", ".wingmate/evidence/assumptions.md");
    for (let n = 0; n < 3; n++) ({ r } = await drain(w));
    expect(r.gates.implement.failCount).toBe(2);
    expect(outbox(wt, "failed")).toHaveLength(1); // the refused third FAIL, after three tries
    const last = (await w.ctx.ledger.readIssue(ID)).filter((e) => e.type === "intent_failed").at(-1);
    expect(last?.data.code).toBe("gate_retry_exhausted");
  });

  test("ask: posted once (a retry after a failed label write reuses the question), Needs-Human, parked, the sweep spares the session", async () => {
    const { w, wt } = await claimed();
    file(wt, ".wingmate/q.md", "Milliseconds or microseconds?");
    await ask(wt);
    w.linear.failNext = "issueUpdate";
    expect((await drain(w)).res.failed).toBe(1);
    expect(questionComments(w)).toHaveLength(1);
    const { r, res } = await drain(w);
    expect(res).toMatchObject({ executed: 1, parked: true });
    expect(questionComments(w)).toHaveLength(1);
    expect(r.stage).toBe("awaiting-human");
    expect(r.questions).toHaveLength(1);
    expect(w.linear.issues.get("i1")?.labels.map((l) => l.name)).toContain("Needs-Human");
    expect(w.sweeps.at(-1)).toEqual({
      paths: [wt],
      spare: join(w.ctx.kitDirFor(ID), "claude-settings.json"),
    });
    const qs = JSON.parse(readFileSync(join(wt, ".wingmate", "questions.json"), "utf8"));
    expect(qs).toEqual([{ id: r.questions[0]?.id, status: "open", askedAt: r.questions[0]?.askedAt }]);
  });

  test("followup: created once under its intent's key, with the follow-up marker", async () => {
    const { w, wt } = await claimed();
    file(wt, ".wingmate/f.md", "Extract the scoring helper.");
    await writeIntent(wt, {
      issue: ID,
      kind: "followup",
      payload: { title: "Refactor scoring", bodyFile: ".wingmate/f.md" },
    });
    await drain(w);
    const created = w.linear.writes.filter((x) => x.kind === "issueCreate");
    expect(created).toHaveLength(1);
    expect((created[0]?.args as { description: string }).description).toStartWith(
      `<!-- wingmate:followup of=${ID} -->`,
    );
    // ledgered as followup_created, so the completion comment lists it (§8.1 followup)
    const receipt = (await w.ctx.journal.all()).find((e) => e.kind === "issueCreate")?.receipt as
      | { identifier?: string }
      | undefined;
    const ledgered = (await w.ctx.ledger.readIssue(ID)).filter((e) => e.type === "followup_created");
    expect(ledgered.map((e) => e.data.identifier)).toEqual([receipt?.identifier]);
    expect(receipt?.identifier).toMatch(/^JRF-\d+$/);
  });
});
