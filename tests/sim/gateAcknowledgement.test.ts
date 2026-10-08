import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { issueCommand } from "../../src/cli/commands/issue";
import { parseArgv } from "../../src/cli/index";
import { listIntents, writeIntent } from "../../src/kit/intents";
import { readLocal } from "../../src/kit/local";
import { executeOutbox } from "../../src/machine/outbox";
import { reconcile } from "../../src/machine/reconcile";
import { roleJobDir } from "../../src/machine/roles";
import { run } from "../../src/shared/exec";
import { readRecord, writeRecord } from "../../src/state/records";
import { OWNER, type World, advance, labeledByOwner, runTick, todo, world } from "./harness";

const ID = "JRF-501";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function record(w: World) {
  const r = await readRecord(w.dirs, ID);
  if (!r?.worktree) throw new Error("fixture record/worktree missing");
  return r;
}
async function command(wt: string, args: string[]) {
  const output: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((x: string) => {
    output.push(String(x));
    return true;
  }) as typeof original;
  try {
    const code = await issueCommand(parseArgv(["issue", ID, ...args]), { cwd: wt });
    return { code, json: JSON.parse(output.join("")) };
  } finally {
    process.stdout.write = original;
  }
}
async function idle(w: World) {
  const r = await record(w);
  if (!r.worktree || !r.coordinator.paneKey) throw new Error("fixture coordinator missing");
  w.orca.setAgentState(r.worktree.id, r.coordinator.paneKey, "done", w.ctx.now());
}
async function tick(w: World) {
  advance(w, 1);
  return runTick(w);
}
const sends = (w: World) => w.orca.calls.filter((c) => c.verb === "terminalSend");
async function git(wt: string, args: string[]) {
  const result = await run(["git", "-C", wt, ...args], {
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (result.code !== 0) throw new Error(`fixture Git failed: ${result.stderr}`);
  return result.stdout.trim();
}
async function implementation(w: World, wt: string) {
  writeFileSync(join(wt, "source.ts"), "export const value = 1;\n");
  await git(wt, ["add", "source.ts"]);
  await git(wt, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "scoped implementation",
  ]);
  const head = await git(wt, ["rev-parse", "HEAD"]);
  w.git.heads.set(wt, head);
  return head;
}
async function review(w: World, wt: string) {
  await idle(w);
  const request = await writeIntent(wt, {
    issue: ID,
    kind: "spawn",
    payload: { role: "plan-verifier", spec: "Independently review the exact plan.", prefer: null, deps: [] },
  });
  await tick(w);
  const r = await record(w);
  const job = r.roleJobs.find((j) => j.id === request.id);
  if (!job) throw new Error("fixture role was not launched");
  const dir = roleJobDir(w.ctx, r, request.id);
  writeFileSync(
    join(dir, "stdout"),
    job.provider === "codex"
      ? [
          {
            type: "item.completed",
            item: { type: "agent_message", text: "PASS\nIndependent exact-plan review." },
          },
          { type: "turn.completed", usage: { input_tokens: 12, output_tokens: 4 } },
        ]
          .map((event) => JSON.stringify(event))
          .join("\n")
      : JSON.stringify({
          type: "result",
          subtype: "success",
          result: "PASS\nIndependent exact-plan review.",
        }),
  );
  writeFileSync(join(dir, "exit"), "0\n");
  await idle(w);
  await tick(w);
  expect((await record(w)).roleJobs.find((j) => j.id === request.id)).toMatchObject({
    status: "succeeded",
    verdict: "PASS",
    notified: true,
  });
  await idle(w);
  return request.id;
}
async function reviewedPlan(unconfirmed = false) {
  const w = await world();
  roots.push(w.root);
  if (unconfirmed) w.orca.nextSendStage = "input_accepted";
  labeledByOwner(w, todo("i1", ID));
  await runTick(w);
  const r = await record(w);
  if (unconfirmed) expect(r.stage).toBe("claimed");
  const wt = r.worktree?.path;
  if (!wt) throw new Error("fixture worktree missing");
  w.git.heads.set(wt, await git(wt, ["rev-parse", "HEAD"]));
  writeFileSync(join(wt, ".wingmate/plan.md"), "Implement one scoring rule and cover ties.");
  writeFileSync(join(wt, ".wingmate/evidence/plan.md"), "Scoped plan and acceptance checks.");
  for (const stage of ["intake", "plan"]) {
    await idle(w);
    const before = await readLocal(wt);
    const result = await command(wt, [
      "gate",
      stage,
      "--verdict",
      "PASS",
      "--evidence",
      ".wingmate/evidence/plan.md",
      ...(stage === "intake" ? ["--method", "loop"] : []),
    ]);
    expect(result).toMatchObject({ code: 0, json: { pending: true, stage, verdict: "PASS" } });
    expect(result.json.next).toContain("END YOUR TURN");
    expect(result.json.next).toContain("HEAD");
    expect(await readLocal(wt)).toEqual(before);
    expect((await tick(w)).resumes).toEqual([ID]);
    expect((await readLocal(wt)).gates[stage]?.verdict).toBe("PASS");
    expect((await record(w)).stage).toBe("working");
  }
  w.orca.nextSendStage = "turn_started";
  const requestId = await review(w, wt);
  return { w, wt, requestId };
}
async function queue(wt: string, requestId: string) {
  const result = await command(wt, ["gate", "planVerify", "--request", requestId]);
  expect(result).toMatchObject({ code: 0, json: { pending: true, verdict: "PASS" } });
  return result.json.intentId as string;
}
const acknowledgement = (wt: string, id: string) =>
  readFileSync(join(wt, `.wingmate/inbox/gate-${id}.md`), "utf8");

describe("canonical dispatcher gate acknowledgements", () => {
  test("an initially unconfirmed fast coordinator proves activity through queued gates and can launch its verifier", async () => {
    const { w, wt, requestId } = await reviewedPlan(true);
    expect((await record(w)).stage).toBe("working");
    const id = await queue(wt, requestId);
    await tick(w);
    expect(acknowledgement(wt, id)).toContain("ACCEPTED");
    expect((await record(w)).pipelineStage).toBe("implement");
  });
  test("plan PASS stays pending locally; canonical save precedes ACK and implementation can commit afterward", async () => {
    const { w, wt, requestId } = await reviewedPlan();
    const before = await readLocal(wt);
    const id = await queue(wt, requestId);
    expect(await readLocal(wt)).toEqual(before);
    expect(
      (
        await command(wt, [
          "gate",
          "implement",
          "--verdict",
          "PASS",
          "--evidence",
          ".wingmate/evidence/plan.md",
        ])
      ).json.code,
    ).toBe("gate_pending");
    expect(await listIntents(wt)).toHaveLength(1);
    const send = w.orca.terminalSend.bind(w.orca);
    w.orca.terminalSend = async (...args) => {
      const protectedRecord = await record(w);
      expect(protectedRecord.gateDelivery).toMatchObject({ id, accepted: true });
      expect(protectedRecord.gates.planVerify).toMatchObject({ verdict: "PASS", dispatchId: requestId });
      expect((await readLocal(wt)).gates.planVerify?.verdict).toBe("PASS");
      return send(...args);
    };
    expect((await tick(w)).resumes).toEqual([ID]);
    w.orca.terminalSend = send;
    expect((await record(w)).gateDelivery).toBeNull();
    expect((await readLocal(wt)).record.pipelineStage).toBe("implement");
    expect(acknowledgement(wt, id)).toContain(`Gate intent ${id}: ACCEPTED`);
    expect(existsSync(join(wt, `.wingmate/outbox/done/${id}.json`))).toBe(true);
    const head = await implementation(w, wt);
    await idle(w);
    const implement = await command(wt, [
      "gate",
      "implement",
      "--verdict",
      "PASS",
      "--evidence",
      ".wingmate/evidence/plan.md",
    ]);
    expect(implement.json).toMatchObject({ pending: true, stage: "implement" });
    expect((await readLocal(wt)).record.pipelineStage).toBe("implement");
    await tick(w);
    expect((await record(w)).gates.implement).toMatchObject({ verdict: "PASS", headSha: head });
    expect(w.git.pushed).toEqual([]);
    expect(w.gh.prs).toEqual([]);
  });

  test("committing before plan-gate drain refuses the stale review once and a fresh independent review can recover", async () => {
    const { w, wt, requestId } = await reviewedPlan();
    const before = structuredClone((await record(w)).gates.planVerify);
    const id = await queue(wt, requestId);
    await implementation(w, wt);
    const sent = sends(w).length;
    expect((await tick(w)).resumes).toEqual([ID]);
    expect((await record(w)).gates.planVerify).toEqual(before);
    expect((await record(w)).pipelineStage).toBe("planVerify");
    expect((await readLocal(wt)).gates.planVerify?.verdict).not.toBe("PASS");
    expect(acknowledgement(wt, id)).toContain("REFUSED");
    expect(acknowledgement(wt, id)).toContain("review_stale");
    expect(acknowledgement(wt, id)).toContain("fresh plan-verifier");
    expect(existsSync(join(wt, `.wingmate/outbox/failed/${id}.json`))).toBe(true);
    await tick(w);
    expect(sends(w)).toHaveLength(sent + 1);
    expect(
      (await w.ctx.ledger.readIssue(ID)).filter((e) => e.type === "intent_failed" && e.data.id === id),
    ).toHaveLength(1);
    const fresh = await review(w, wt);
    expect(fresh).not.toBe(requestId);
    await queue(wt, fresh);
    await tick(w);
    expect((await record(w)).gates.planVerify).toMatchObject({ verdict: "PASS", dispatchId: fresh });
  });

  test("deferred ACK is durable, budgeted and replays the recorded acceptance without regranting at a new HEAD", async () => {
    const { w, wt, requestId } = await reviewedPlan();
    const id = await queue(wt, requestId);
    const sent = sends(w).length;
    w.orca.nextWaitSatisfied = false;
    expect((await tick(w)).resumes).toEqual([]);
    const accepted = await record(w);
    expect(accepted.gateDelivery).toMatchObject({ id, accepted: true });
    expect(await listIntents(wt)).toHaveLength(1);
    expect(sends(w)).toHaveLength(sent);
    const newHead = await implementation(w, wt);
    expect(newHead).not.toBe(accepted.gates.planVerify.headSha);
    const [issue] = await w.linear.getIssues(["i1"]);
    if (!issue) throw new Error("fixture issue missing");
    const deferred = await executeOutbox(w.ctx, await record(w), issue, await reconcile(w.ctx), {
      canHandoff: true,
      canResume: false,
    });
    expect(deferred.resumed).toBe(false);
    expect((await record(w)).gateDelivery).toEqual(accepted.gateDelivery);
    w.orca.nextWaitSatisfied = true;
    w.orca.nextSendStage = "input_accepted";
    expect((await tick(w)).resumes).toEqual([ID]);
    expect((await record(w)).gates.planVerify).toEqual(accepted.gates.planVerify);
    expect((await record(w)).gateDelivery).toBeNull();
    expect(sends(w)).toHaveLength(sent + 1);
    expect(readdirSync(join(wt, ".wingmate/inbox")).filter((n) => n === `gate-${id}.md`)).toHaveLength(1);
    expect(acknowledgement(wt, id)).toContain(accepted.gates.planVerify.headSha ?? "missing original HEAD");
  });

  test("an accepted decision cannot restore a canonical gate reset before notification", async () => {
    const { w, wt, requestId } = await reviewedPlan();
    const id = await queue(wt, requestId);
    w.orca.nextWaitSatisfied = false;
    await tick(w);
    const r = await record(w);
    r.gates.planVerify.verdict = null;
    r.pipelineStage = "planVerify";
    await writeRecord(w.dirs, r);
    w.orca.nextWaitSatisfied = true;
    await tick(w);
    expect((await record(w)).gates.planVerify.verdict).toBeNull();
    expect(acknowledgement(wt, id)).toContain("gate_ack_changed");
    expect(acknowledgement(wt, id)).toContain("REFUSED");
    expect(existsSync(join(wt, `.wingmate/outbox/failed/${id}.json`))).toBe(true);
  });

  test("a refused decision is delivered once even if HEAD becomes eligible again before notification", async () => {
    const { w, wt, requestId } = await reviewedPlan();
    const originalHead = await git(wt, ["rev-parse", "HEAD"]);
    const id = await queue(wt, requestId);
    await implementation(w, wt);
    w.orca.nextWaitSatisfied = false;
    await tick(w);
    const refused = (await record(w)).gateDelivery;
    expect(refused).toMatchObject({ id, accepted: false, code: "review_stale" });
    w.git.heads.set(wt, originalHead); // the dispatcher model would now accept the original review if it reran the gate
    w.orca.nextWaitSatisfied = true;
    await tick(w);
    expect((await record(w)).gates.planVerify.verdict).toBeNull();
    expect(acknowledgement(wt, id)).toContain("REFUSED");
    expect((await record(w)).gateDelivery).toBeNull();
    expect(existsSync(join(wt, `.wingmate/outbox/failed/${id}.json`))).toBe(true);
  });

  test("editing a pending intent cannot repurpose an accepted receipt to grant another gate", async () => {
    const { w, wt, requestId } = await reviewedPlan();
    const id = await queue(wt, requestId);
    w.orca.nextWaitSatisfied = false;
    await tick(w);
    const accepted = structuredClone((await record(w)).gates);
    const path = join(wt, `.wingmate/outbox/${id}.json`);
    const forged = JSON.parse(readFileSync(path, "utf8"));
    forged.payload.stage = "implement";
    writeFileSync(path, JSON.stringify(forged));
    w.orca.nextWaitSatisfied = true;
    await tick(w);
    expect((await record(w)).gates).toEqual(accepted);
    expect((await record(w)).gates.implement.verdict).toBeNull();
    expect(acknowledgement(wt, id)).toContain("gate_ack_changed");
    expect(acknowledgement(wt, id)).toContain("REFUSED");
    expect(existsSync(join(wt, `.wingmate/outbox/failed/${id}.json`))).toBe(true);
  });

  test("accepted FAIL increments once across deferred delivery and reports the second-failure owner requirement", async () => {
    const { w, wt, requestId } = await reviewedPlan();
    await queue(wt, requestId);
    await tick(w);
    for (const failCount of [1, 2]) {
      await idle(w);
      const result = await command(wt, [
        "gate",
        "implement",
        "--verdict",
        "FAIL",
        "--evidence",
        ".wingmate/evidence/plan.md",
      ]);
      expect(result.json.next).toContain("END YOUR TURN");
      w.orca.nextWaitSatisfied = false;
      await tick(w);
      expect((await record(w)).gates.implement).toMatchObject({ verdict: "FAIL", failCount });
      for (let n = 0; n < 3; n++) await tick(w);
      expect((await record(w)).gates.implement.failCount).toBe(failCount);
      w.orca.nextWaitSatisfied = true;
      await tick(w);
      expect((await record(w)).gates.implement.failCount).toBe(failCount);
      expect(acknowledgement(wt, result.json.intentId)).toContain("ACCEPTED");
      if (failCount === 2) expect(acknowledgement(wt, result.json.intentId)).toContain("ask the owner");
    }
  });

  test("a deferred refusal suppresses notes, idle nudges and timer handoffs across depleted-budget ticks", async () => {
    const { w, wt, requestId } = await reviewedPlan();
    const id = await queue(wt, requestId);
    await implementation(w, wt);
    w.orca.nextWaitSatisfied = false;
    await tick(w);
    const waiting = await record(w);
    expect(waiting.gateDelivery).toMatchObject({ id, accepted: false, code: "review_stale" });
    const sent = sends(w).length;
    const creates = w.orca.calls.filter((c) => c.verb === "terminalCreate").length;
    w.cfg.defaults.dispatcher.resumesPerTick = 0;
    advance(w, 1);
    w.linear.humanComment("i1", "Keep the same scope while the gate is pending.", OWNER, w.ctx.now());
    for (let n = 0; n < 12; n++) {
      advance(w, 10);
      const summary = await runTick(w);
      expect(summary.resumes).toEqual([]);
      expect(summary.relaunches).toEqual([]);
      expect(summary.handoffs).toEqual([]);
    }
    const stillWaiting = await record(w);
    expect(stillWaiting.stage).toBe("working");
    expect(stillWaiting.gateDelivery).toEqual(waiting.gateDelivery);
    expect(stillWaiting.timers.nudges).toBe(0);
    expect(stillWaiting.timers.graceEndsAt).toBeNull();
    expect(stillWaiting.linear.lastSeenCommentAt).toBe(waiting.linear.lastSeenCommentAt);
    expect(sends(w)).toHaveLength(sent);
    expect(w.orca.calls.filter((c) => c.verb === "terminalCreate")).toHaveLength(creates);
    w.cfg.defaults.dispatcher.resumesPerTick = 1;
    w.orca.nextWaitSatisfied = true;
    expect((await tick(w)).resumes).toEqual([ID]);
    expect(sends(w)).toHaveLength(sent + 1); // ACK only; the owner note stays durable for a later turn
    expect((await record(w)).linear.lastSeenCommentAt).toBe(waiting.linear.lastSeenCommentAt);
    await idle(w);
    expect((await tick(w)).resumes).toEqual([ID]);
    expect(sends(w)).toHaveLength(sent + 2);
  });

  test("partial and unverifiable snapshots leave pending delivery untouched", async () => {
    const { w, wt, requestId } = await reviewedPlan();
    await queue(wt, requestId);
    w.orca.nextWaitSatisfied = false;
    await tick(w);
    w.orca.nextWaitSatisfied = true;
    const receipt = (await record(w)).gateDelivery;
    const sent = sends(w).length;
    const [issue] = await w.linear.getIssues(["i1"]);
    if (!issue) throw new Error("fixture issue missing");
    for (const partial of [true, false]) {
      const rec = await reconcile(w.ctx);
      rec.partial = partial;
      rec.liveness.set(ID, partial ? "idle" : "unverifiable");
      const result = await executeOutbox(w.ctx, await record(w), issue, rec);
      expect(result.resumed).toBe(false);
      expect((await record(w)).gateDelivery).toEqual(receipt);
    }
    expect(sends(w)).toHaveLength(sent);
    await tick(w);
    expect(sends(w)).toHaveLength(sent + 1);
  });

  test("a missing original intent cannot redirect its durable ACK to a replacement ID", async () => {
    const { w, wt, requestId } = await reviewedPlan();
    const id = await queue(wt, requestId);
    w.orca.nextWaitSatisfied = false;
    await tick(w);
    const oldPath = join(wt, `.wingmate/outbox/${id}.json`);
    const changed = JSON.parse(readFileSync(oldPath, "utf8"));
    changed.id = "Replacement1";
    writeFileSync(oldPath, JSON.stringify(changed));
    renameSync(oldPath, join(wt, ".wingmate/outbox/Replacement1.json"));
    w.orca.nextWaitSatisfied = true;
    await tick(w);
    expect(acknowledgement(wt, id)).toContain(`Gate intent ${id}: ACCEPTED`);
    expect(await listIntents(wt)).toMatchObject([{ id: "Replacement1" }]);
    expect((await record(w)).gateDelivery).toBeNull();
    expect(existsSync(join(wt, ".wingmate/inbox/gate-Replacement1.md"))).toBe(false);
  });

  for (const stage of ["input_accepted", "turn_started"] as const) {
    test(`crash after durable ${stage} proof settles without sending the ACK again`, async () => {
      const { w, wt, requestId } = await reviewedPlan();
      const id = await queue(wt, requestId);
      const sent = sends(w).length;
      w.orca.nextSendStage = stage;
      const append = w.ctx.ledger.append.bind(w.ctx.ledger);
      let crash = true;
      w.ctx.ledger.append = async (event) => {
        await append(event);
        if (crash && event.type === "delivered" && event.data.inboxId === id) {
          crash = false;
          throw new Error("synthetic crash after durable gate delivery proof");
        }
      };
      advance(w, 1);
      await runTick(w, { allowErrors: true });
      const accepted = await record(w);
      expect(accepted.gateDelivery).toMatchObject({ id, accepted: true });
      expect(sends(w)).toHaveLength(sent + 1);
      w.ctx.ledger.append = append;
      expect((await tick(w)).resumes).toEqual([]);
      expect(sends(w)).toHaveLength(sent + 1);
      expect((await record(w)).gateDelivery).toBeNull();
      expect((await record(w)).gates.planVerify).toEqual(accepted.gates.planVerify);
      expect(existsSync(join(wt, `.wingmate/outbox/done/${id}.json`))).toBe(true);
      expect(
        (await w.ctx.ledger.readIssue(ID)).filter(
          (event) => event.type === "delivered" && event.data.inboxId === id,
        ),
      ).toHaveLength(1);
    });
  }

  test("known-send recovery quarantines a changed same-ID request rather than falsely archiving it as accepted", async () => {
    const { w, wt, requestId } = await reviewedPlan();
    const id = await queue(wt, requestId);
    const append = w.ctx.ledger.append.bind(w.ctx.ledger);
    w.ctx.ledger.append = async (event) => {
      await append(event);
      if (event.type === "delivered" && event.data.inboxId === id)
        throw new Error("synthetic post-delivery crash");
    };
    advance(w, 1);
    await runTick(w, { allowErrors: true });
    w.ctx.ledger.append = append;
    const path = join(wt, `.wingmate/outbox/${id}.json`);
    const changed = JSON.parse(readFileSync(path, "utf8"));
    changed.payload.stage = "implement";
    writeFileSync(path, JSON.stringify(changed));
    const sent = sends(w).length;
    await tick(w);
    expect(sends(w)).toHaveLength(sent);
    expect((await record(w)).gates.implement.verdict).toBeNull();
    expect(existsSync(join(wt, `.wingmate/outbox/failed/${id}.json`))).toBe(true);
    expect(existsSync(join(wt, `.wingmate/outbox/done/${id}.json`))).toBe(false);
    expect(
      (await w.ctx.ledger.readIssue(ID)).find(
        (event) => event.type === "intent_failed" && event.data.id === id,
      )?.data.code,
    ).toBe("gate_intent_changed");
  });

  test("hard-budget blocking while ACK waits still permits an authenticated owner continue", async () => {
    const { w, wt, requestId } = await reviewedPlan();
    await queue(wt, requestId);
    w.orca.nextWaitSatisfied = false;
    await tick(w);
    const r = await record(w);
    r.budget.hardTokens = 1;
    await writeRecord(w.dirs, r);
    expect((await tick(w)).blocked).toEqual([ID]);
    expect((await record(w)).gateDelivery).toBeTruthy();
    advance(w, 1);
    w.linear.humanComment("i1", "continue", OWNER, w.ctx.now());
    w.orca.nextWaitSatisfied = true;
    expect((await tick(w)).resumes).toEqual([ID]);
    expect(await record(w)).toMatchObject({ stage: "working", budget: { capLifted: true } });
  });

  test("unsafe inbox, failed send and exited coordinator retain the same protected decision without direct relaunch", async () => {
    const { w, wt, requestId } = await reviewedPlan();
    const id = await queue(wt, requestId);
    const inbox = join(wt, ".wingmate/inbox");
    const outside = join(w.root, "outside-inbox");
    mkdirSync(outside);
    rmSync(inbox, { recursive: true });
    symlinkSync(outside, inbox);
    await tick(w);
    const accepted = (await record(w)).gateDelivery;
    expect(accepted).toMatchObject({ id, accepted: true });
    expect(readdirSync(outside)).toEqual([]);
    rmSync(inbox);
    mkdirSync(inbox);
    const send = w.orca.terminalSend.bind(w.orca);
    w.orca.terminalSend = async () => {
      throw new Error("synthetic ACK send unavailable");
    };
    advance(w, 1);
    await runTick(w, { allowErrors: true });
    expect((await record(w)).gateDelivery).toEqual(accepted);
    expect(await listIntents(wt)).toHaveLength(1);
    w.orca.terminalSend = send;
    const r = await record(w);
    r.coordinator.terminalHandle = null;
    r.coordinator.relaunches = 1;
    await writeRecord(w.dirs, r);
    const rec = await reconcile(w.ctx);
    rec.liveness.set(ID, "exited");
    const [issue] = await w.linear.getIssues(["i1"]);
    if (!issue) throw new Error("fixture issue missing");
    const calls = w.orca.calls.length;
    const result = await executeOutbox(w.ctx, r, issue, rec);
    expect(result.resumed).toBe(false);
    expect(r.gateDelivery).toEqual(accepted);
    expect(r.coordinator.relaunches).toBe(1);
    expect(
      w.orca.calls.slice(calls).filter((c) => c.verb === "terminalSend" || c.verb === "terminalCreate"),
    ).toEqual([]);
  });
});
