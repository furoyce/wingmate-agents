import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { issueCommand } from "../../src/cli/commands/issue";
import { parseArgv } from "../../src/cli/index";
import { listIntents, writeIntent } from "../../src/kit/intents";
import { readLocal, writeLocal } from "../../src/kit/local";
import { readRoleJobs } from "../../src/kit/roles";
import { roleJobDir, startRole, verifyRoleGate } from "../../src/machine/roles";
import { OrcaError } from "../../src/orca/cli";
import { run } from "../../src/shared/exec";
import { readRecord, writeRecord } from "../../src/state/records";
import { OWNER, type World, advance, labeledByOwner, runTick, todo, world } from "./harness";

const ID = "JRF-501";
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("required test fixture missing");
  return value;
}
async function record(w: World) {
  const r = await readRecord(w.dirs, ID);
  if (!r?.worktree) throw new Error("record missing");
  return r;
}
async function setup() {
  const w = await world();
  labeledByOwner(w, todo("i1", ID));
  await runTick(w);
  const r = await record(w);
  w.orca.setAgentState(required(r.worktree).id, required(r.coordinator.paneKey), "done", w.ctx.now());
  writeFileSync(
    join(required(r.worktree).path, ".wingmate/plan.md"),
    "Implement the scoring rule; test ties.",
  );
  return { w, r, wt: required(r.worktree).path };
}
async function request(wt: string, role = "plan-verifier", deps: string[] = []) {
  const intent = await writeIntent(wt, {
    issue: ID,
    kind: "spawn",
    payload: {
      role: role as "plan-verifier",
      spec: "Independently review the plan and code. Final verdict first.",
      prefer: null,
      deps,
    },
  });
  if (intent.kind !== "spawn") throw new Error("spawn fixture required");
  return intent;
}
function done(w: World, r: Awaited<ReturnType<typeof record>>, id: string, verdict = "PASS") {
  const j = required(r.roleJobs.find((j) => j.id === id));
  const dir = roleJobDir(w.ctx, r, id);
  writeFileSync(
    join(dir, "stdout"),
    j.provider === "codex"
      ? [
          {
            type: "item.completed",
            item: { type: "agent_message", text: `${verdict}\nIndependent review.` },
          },
          { type: "turn.completed", usage: { input_tokens: 12, output_tokens: 4 } },
        ]
          .map((x) => JSON.stringify(x))
          .join("\n")
      : JSON.stringify({
          type: "result",
          subtype: "success",
          result: `${verdict}\nIndependent review.`,
          usage: { input_tokens: 12, output_tokens: 4 },
          total_cost_usd: 0.01,
        }),
  );
  writeFileSync(join(dir, "exit"), "0\n");
}
const creates = (w: World) => w.orca.calls.filter((c) => c.verb === "terminalCreate");

async function fixtureGit(wt: string, args: string[]) {
  const result = await run(["git", "-C", wt, ...args], {
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (result.code !== 0) throw new Error(`fixture git failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function committedSource(w: World, wt: string) {
  writeFileSync(join(wt, "source.ts"), "export const value = 1;\n");
  await fixtureGit(wt, ["add", "source.ts"]);
  await fixtureGit(wt, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "source fixture",
  ]);
  w.git.heads.set(wt, await fixtureGit(wt, ["rev-parse", "HEAD"]));
}

describe("slice 2 dispatcher role relay", () => {
  for (const stage of ["input_accepted", "turn_started"] as const) {
    test(`a ${stage} role-result resume defers an owner note without losing notification`, async () => {
      const { w, wt } = await setup();
      const intent = await request(wt);
      advance(w, 5);
      await runTick(w);
      let r = await record(w);
      done(w, r, intent.id);
      const cursor = r.linear.lastSeenCommentAt;
      advance(w, 5);
      const note = w.linear.humanComment("i1", "Keep the test scope bounded.", OWNER, w.ctx.now());
      const callsBefore = w.orca.calls.length;
      w.orca.nextSendStage = stage;
      let resumed = false;
      w.orca.onCall = (verb) => {
        if (verb === "terminalSend") resumed = true;
        if (verb === "terminalWait" && resumed)
          throw new OrcaError("timeout", "a second wait used stale idle liveness after the resume");
      };

      expect((await runTick(w)).resumes).toEqual([ID]);
      r = await record(w);
      expect(r.roleJobs[0]).toMatchObject({
        id: intent.id,
        status: "succeeded",
        verdict: "PASS",
        notified: true,
      });
      expect(r.linear.lastSeenCommentAt).toBe(cursor);
      expect(w.orca.calls.slice(callsBefore).filter((c) => c.verb === "terminalWait")).toHaveLength(1);
      expect(w.orca.calls.slice(callsBefore).filter((c) => c.verb === "terminalSend")).toHaveLength(1);

      // The next tick reads the now-idle coordinator again and delivers the still-unseen note once.
      w.orca.onCall = null;
      w.orca.setAgentState(required(r.worktree).id, required(r.coordinator.paneKey), "done", w.ctx.now());
      advance(w, 5);
      await runTick(w);
      r = await record(w);
      expect(r.linear.lastSeenCommentAt).toBe(note.createdAt);
      expect(r.roleJobs[0]?.notified).toBe(true);
      expect(w.orca.calls.slice(callsBefore).filter((c) => c.verb === "terminalSend")).toHaveLength(2);
      advance(w, 5);
      await runTick(w);
      expect(w.orca.calls.slice(callsBefore).filter((c) => c.verb === "terminalSend")).toHaveLength(2);
      expect(creates(w)).toHaveLength(2); // coordinator + original reviewer, no relaunch or duplicate role
    });
  }

  for (const unavailable of ["deferred", "unsafe"] as const) {
    test(`a ${unavailable} role-result notification stays pending until an accepted send`, async () => {
      const { w, wt } = await setup();
      const intent = await request(wt);
      advance(w, 5);
      await runTick(w);
      let r = await record(w);
      done(w, r, intent.id);
      const before = w.orca.calls.length;
      const inbox = join(wt, ".wingmate/inbox");
      const outside = join(w.root, "unrelated-inbox");
      if (unavailable === "deferred") w.orca.nextWaitSatisfied = false;
      else {
        mkdirSync(outside);
        rmSync(inbox, { recursive: true, force: true });
        symlinkSync(outside, inbox);
      }
      advance(w, 1);
      expect((await runTick(w)).resumes).toEqual([]);
      r = await record(w);
      expect(r.roleJobs[0]).toMatchObject({ id: intent.id, status: "succeeded", notified: false });
      expect(w.orca.calls.slice(before).filter((c) => c.verb === "terminalSend")).toHaveLength(0);
      expect(
        (await w.ctx.ledger.readIssue(ID)).filter((e) => e.type === "delivered" && e.data.kind === "note"),
      ).toHaveLength(0);
      if (unavailable === "deferred") w.orca.nextWaitSatisfied = true;
      else rmSync(inbox);
      w.orca.nextSendStage = "input_accepted";
      advance(w, 1);
      expect((await runTick(w)).resumes).toEqual([ID]);
      expect((await record(w)).roleJobs[0]?.notified).toBe(true);
      expect(w.orca.calls.slice(before).filter((c) => c.verb === "terminalSend")).toHaveLength(1);
      advance(w, 1);
      expect((await runTick(w)).resumes).toEqual([]);
      expect(w.orca.calls.slice(before).filter((c) => c.verb === "terminalSend")).toHaveLength(1);
      rmSync(w.root, { recursive: true, force: true });
    });
  }

  for (const role of ["code-reviewer", "security-reviewer"]) {
    test(`${role} refuses uncommitted tracked source before creating a terminal`, async () => {
      const { w, r, wt } = await setup();
      await committedSource(w, wt);
      writeFileSync(join(wt, "source.ts"), "export const value = 2;\n");
      const intent = await request(wt, role);
      await expect(startRole(w.ctx, r, intent)).rejects.toMatchObject({ code: "review_source_dirty" });
      expect(r.roleJobs).toEqual([]);
      expect(creates(w)).toHaveLength(1);
    });

    test(`${role} cannot accept a PASS captured while tracked source/index is dirty`, async () => {
      const { w, wt } = await setup();
      await committedSource(w, wt);
      const intent = await request(wt, role);
      advance(w, 5);
      await runTick(w);
      let r = await record(w);
      expect(r.roleJobs[0]?.status).toBe("running");
      writeFileSync(join(wt, "source.ts"), "export const value = 2;\n");
      await fixtureGit(wt, ["add", "source.ts"]);
      writeFileSync(join(wt, "source.ts"), "export const value = 1;\n"); // index only differs from the pinned commit
      done(w, r, intent.id);
      advance(w, 5);
      await runTick(w);
      r = await record(w);
      expect(r.roleJobs[0]).toMatchObject({ status: "failed", verdict: "FAIL", launchUncertain: false });
      expect(readFileSync(join(wt, required(r.roleJobs[0]?.reportPath)), "utf8")).toContain(
        "Tracked source or index changed",
      );
      await fixtureGit(wt, ["reset", "-q", "HEAD", "--", "source.ts"]);
      await expect(
        verifyRoleGate(
          w.ctx,
          r,
          role === "code-reviewer" ? "validate" : "security",
          intent.id,
          r.roleJobs[0]?.headSha ?? null,
        ),
      ).rejects.toMatchObject({ code: "review_required" }); // restoring clean source cannot resurrect the rejected result
    });

    test(`${role} requires clean tracked source/index again at gate and pinned publish verification`, async () => {
      const { w, wt } = await setup();
      await committedSource(w, wt);
      const intent = await request(wt, role);
      advance(w, 5);
      await runTick(w);
      let r = await record(w);
      done(w, r, intent.id);
      advance(w, 5);
      await runTick(w);
      r = await record(w);
      const head = required(r.roleJobs[0]).headSha;
      const stage = role === "code-reviewer" ? "validate" : "security";
      await verifyRoleGate(w.ctx, r, stage, intent.id, head);
      writeFileSync(join(wt, "source.ts"), "export const value = 2;\n");
      await expect(verifyRoleGate(w.ctx, r, stage, intent.id, head)).rejects.toMatchObject({
        code: "review_source_dirty",
      });
      await fixtureGit(wt, ["add", "source.ts"]);
      writeFileSync(join(wt, "source.ts"), "export const value = 1;\n");
      await expect(verifyRoleGate(w.ctx, r, stage, intent.id, head, head)).rejects.toMatchObject({
        code: "review_source_dirty",
      });
    });
  }

  test("spawn enqueues without Orca; dispatcher launches once, captures the final result, and resumes once", async () => {
    const { w, wt } = await setup();
    writeFileSync(join(wt, ".wingmate/spec.md"), "Verify the plan.");
    const old = process.stdout.write;
    const output: string[] = [];
    process.stdout.write = ((x: string) => {
      output.push(String(x));
      return true;
    }) as typeof old;
    try {
      expect(
        await issueCommand(
          parseArgv(["issue", ID, "spawn", "--role", "plan-verifier", "--spec", ".wingmate/spec.md"]),
          {
            cwd: wt,
            env: { WINGMATE_ROLE: "coordinator" },
            orca: {
              workerList: async () => {
                throw new Error("no sandbox runtime access");
              },
            },
          },
        ),
      ).toBe(0);
    } finally {
      process.stdout.write = old;
    }
    const receipt = JSON.parse(output.join(""));
    expect(receipt).toMatchObject({ mode: "terminal-job", status: "pending" });
    advance(w, 5);
    await runTick(w);
    let r = await record(w);
    expect(r.roleJobs).toHaveLength(1);
    const job = required(r.roleJobs[0]);
    expect(job).toMatchObject({
      id: receipt.requestId,
      role: "plan-verifier",
      provider: "codex",
      status: "running",
    });
    expect(creates(w)).toHaveLength(2); // coordinator + one role
    // Execute the actual trusted runner with a stub provider to verify shell quoting, stdin and exit capture.
    const bin = join(w.root, "fake-bin");
    mkdirSync(bin);
    const stdout = [
      { type: "item.completed", item: { type: "agent_message", text: "PASS\nIndependent review." } },
      { type: "turn.completed", usage: { input_tokens: 12, output_tokens: 4 } },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n");
    writeFileSync(join(bin, "codex"), `#!/bin/sh\ncat >/dev/null\ncat <<'RESULT'\n${stdout}\nRESULT\n`, {
      mode: 0o700,
    });
    const runner = join(roleJobDir(w.ctx, r, job.id), "runner.sh");
    const startedAt = Date.now();
    const result = await run(["sh", runner], {
      cwd: wt,
      inheritEnv: false,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: w.root },
      timeoutMs: 5000,
    });
    const finishedAt = Date.now();
    expect(result).toMatchObject({ code: 0, stderr: "", timedOut: false });
    const completed = readFileSync(join(roleJobDir(w.ctx, r, job.id), "completed-at"), "utf8").trim();
    expect(completed).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const completedAt = Date.parse(completed);
    expect(completedAt).toBeGreaterThanOrEqual(Math.floor(startedAt / 1000) * 1000);
    expect(completedAt).toBeLessThanOrEqual(finishedAt);
    advance(w, 5);
    expect((await runTick(w)).resumes).toEqual([ID]);
    r = await record(w);
    expect(r.roleJobs[0]).toMatchObject({ status: "succeeded", verdict: "PASS", notified: true });
    expect(await readRoleJobs(wt)).toMatchObject([{ id: job.id, verdict: "PASS" }]);
    expect(r.usage.bySession.find((s) => s.sessionRef === job.id)).toMatchObject({
      tokens: 16,
      costUsd: null,
      provenance: "measured-transcript",
    });
    expect(r.usage.costUsd).toBeNull(); // missing coordinator dollars are never zero dollars
    await verifyRoleGate(w.ctx, r, "planVerify", job.id, job.headSha);
    await expect(verifyRoleGate(w.ctx, r, "planVerify", "forged", job.headSha)).rejects.toMatchObject({
      code: "review_required",
    });
    writeFileSync(join(wt, ".wingmate/plan.md"), "Changed after review.");
    await expect(verifyRoleGate(w.ctx, r, "planVerify", job.id, job.headSha)).rejects.toMatchObject({
      code: "review_stale",
    });
    advance(w, 5);
    expect((await runTick(w)).resumes).toEqual([]);
    expect(creates(w)).toHaveLength(2);
  });

  test("the CLI derives the verifier verdict and the dispatcher rejects a forged gate", async () => {
    const { w, wt } = await setup();
    const actualHead = (await run(["git", "rev-parse", "HEAD"], { cwd: wt })).stdout.trim();
    w.git.heads.set(wt, actualHead);
    const intent = await request(wt);
    advance(w, 5);
    await runTick(w);
    let r = await record(w);
    done(w, r, intent.id);
    advance(w, 5);
    await runTick(w);
    r = await record(w);
    for (const stage of ["intake", "plan"] as const) r.gates[stage].verdict = "PASS";
    await writeRecord(w.dirs, r);
    const local = await readLocal(wt);
    for (const stage of ["intake", "plan"] as const)
      local.gates[stage] = { ...r.gates[stage], method: "loop" };
    await writeLocal(wt, local);
    const old = process.stdout.write;
    const output: string[] = [];
    process.stdout.write = ((x: string) => {
      output.push(String(x));
      return true;
    }) as typeof old;
    try {
      expect(
        await issueCommand(parseArgv(["issue", ID, "gate", "planVerify", "--request", intent.id]), {
          cwd: wt,
          orca: {
            workerList: async () => {
              throw new Error("Orca unavailable");
            },
          },
        }),
      ).toBe(0);
    } finally {
      process.stdout.write = old;
    }
    expect(JSON.parse(output.join(""))).toMatchObject({ stage: "planVerify", verdict: "PASS" });
    advance(w, 5);
    await runTick(w);
    r = await record(w);
    expect(r.gates.planVerify).toMatchObject({ verdict: "PASS", dispatchId: intent.id, headSha: actualHead });
    expect(r.attention).not.toContain("plan_verify_unverified");
    await writeIntent(wt, {
      issue: ID,
      kind: "gate",
      payload: {
        stage: "planVerify",
        verdict: "PASS",
        evidencePath: required(r.roleJobs[0]).reportPath,
        dispatchId: "invented",
        headSha: actualHead,
        note: null,
        method: null,
      },
    });
    advance(w, 5);
    await runTick(w);
    expect((await record(w)).gates.planVerify.dispatchId).toBe(intent.id);
    expect(
      (await w.ctx.ledger.readIssue(ID)).filter((e) => e.type === "intent_failed").at(-1)?.data.code,
    ).toBe("review_required");
  });

  test("dependencies wait for PASS; quota backpressure does not quarantine; reconcile-only never starts a role", async () => {
    const { w, wt } = await setup();
    const first = await request(wt);
    const second = await request(wt, "security-reviewer", [first.id]);
    advance(w, 5);
    await runTick(w, { dryRun: true });
    expect(creates(w)).toHaveLength(1);
    required(required(w.orca.rateLimits.codex).windows.weekly).usedPercent = 100;
    required(required(w.orca.rateLimits.claude).windows.weekly).usedPercent = 100;
    for (let n = 0; n < 4; n++) {
      advance(w, 5);
      await runTick(w);
    }
    expect(await listIntents(wt)).toHaveLength(2);
    expect((await w.ctx.ledger.readIssue(ID)).filter((e) => e.type === "intent_quarantined")).toEqual([]);
    required(required(w.orca.rateLimits.codex).windows.weekly).usedPercent = 0;
    required(required(w.orca.rateLimits.claude).windows.weekly).usedPercent = 0;
    advance(w, 5);
    await runTick(w);
    let r = await record(w);
    expect(r.roleJobs.map((j) => j.id)).toEqual([first.id]);
    done(w, r, first.id);
    advance(w, 5);
    expect((await runTick(w)).resumes).toEqual([]); // second starts; no early coordinator turn
    r = await record(w);
    expect(r.roleJobs.map((j) => j.id)).toEqual([first.id, second.id]);
    done(w, r, second.id, "FAIL");
    advance(w, 5);
    expect((await runTick(w)).resumes).toEqual([ID]);
    r = await record(w);
    await expect(
      verifyRoleGate(w.ctx, r, "security", second.id, required(r.roleJobs[1]).headSha),
    ).rejects.toMatchObject({ code: "review_required" });
  });

  test("an uncertain create is never retried or adopted as the coordinator; stop settles pending jobs", async () => {
    const { w, wt } = await setup();
    const intent = await request(wt);
    w.orca.failAfter = "terminalCreate";
    advance(w, 5);
    await runTick(w);
    let r = await record(w);
    expect(r.roleJobs[0]).toMatchObject({ id: intent.id, status: "starting", terminalHandle: null });
    const oldHandle = r.coordinator.terminalHandle;
    const wid = required(r.worktree).id;
    w.orca.terminals.set(
      wid,
      required(w.orca.terminals.get(wid)).filter((t) => t.handle !== oldHandle),
    );
    required(w.orca.rows.get(wid)).agents = required(w.orca.rows.get(wid)).agents.filter(
      (a) => a.paneKey !== r.coordinator.paneKey,
    );
    for (let n = 0; n < 3; n++) {
      advance(w, 5);
      await runTick(w);
    }
    r = await record(w);
    expect(r.coordinator.terminalHandle).toBe(oldHandle);
    expect(required(r.roleJobs[0]).status).toBe("unverifiable");
    expect(creates(w)).toHaveLength(2);
    const { stopAgents } = await import("../../src/machine/release");
    await stopAgents(w.ctx, r);
    expect(required(r.roleJobs[0]).status).toBe("failed");
  });

  test("a failed legacy worker-list read cannot cause fallback adoption (R33)", async () => {
    const { w } = await setup();
    const r = await record(w);
    r.roleMode = "legacy";
    r.coordinator.childRunId = "unreadable";
    w.orca.failRuns.add("unreadable");
    const old = r.coordinator.terminalHandle;
    const wid = required(r.worktree).id;
    w.orca.terminals.set(wid, []);
    required(w.orca.rows.get(wid)).agents = [];
    const role = await w.orca.terminalCreate(wid, "role", "codex");
    w.orca.setAgentState(wid, `${role.tabId}:${role.leafId}`, "working", w.ctx.now());
    await writeRecord(w.dirs, r);
    advance(w, 5);
    await runTick(w);
    expect((await record(w)).coordinator.terminalHandle).toBe(old);
    expect((await w.ctx.ledger.readIssue(ID)).filter((e) => e.type === "handle_rebound")).toEqual([]);
  });

  test("a trusted exit settles an uncertain create and permits later coordinator recovery", async () => {
    const { w, wt } = await setup();
    const intent = await request(wt);
    w.orca.failAfter = "terminalCreate";
    advance(w, 5);
    await runTick(w);
    let r = await record(w);
    expect(r.roleJobs[0]).toMatchObject({ launchUncertain: true, terminalHandle: null });
    done(w, r, intent.id);
    advance(w, 5);
    await runTick(w);
    r = await record(w);
    expect(r.roleJobs[0]).toMatchObject({ status: "succeeded", launchUncertain: false });
    const wid = required(r.worktree).id;
    // The headless role exited and the old coordinator vanished. Only the replacement is a live agent.
    w.orca.terminals.set(
      wid,
      required(w.orca.terminals.get(wid)).filter((t) => t.handle !== r.coordinator.terminalHandle),
    );
    required(w.orca.rows.get(wid)).agents = [];
    const replacement = await w.orca.terminalCreate(wid, "replacement coordinator", "claude");
    w.orca.setAgentState(wid, `${replacement.tabId}:${replacement.leafId}`, "working", w.ctx.now());
    advance(w, 5);
    await runTick(w);
    expect((await record(w)).coordinator.terminalHandle).toBe(replacement.handle);
    expect(creates(w)).toHaveLength(3); // original, uncertain role, replacement; no duplicate recovery launch
  });

  test("measured review tokens enforce the hard cap even when coordinator usage is unknown", async () => {
    const { w, wt } = await setup();
    const intent = await request(wt);
    advance(w, 5);
    await runTick(w);
    let r = await record(w);
    r.budget.hardTokens = 8;
    await writeRecord(w.dirs, r);
    done(w, r, intent.id); // measured 16 tokens, plus an unknown coordinator total
    advance(w, 5);
    expect((await runTick(w)).blocked).toEqual([ID]);
    r = await record(w);
    expect(r.stage).toBe("blocked");
    expect(r.history.at(-1)?.cause).toBe("budget");
    expect(r.usage.tokens).toBeNull(); // presentation remains honest about the complete total
    expect(r.usage.bySession.find((s) => s.sessionRef === intent.id)?.tokens).toBe(16);
    expect(r.usage.bySession.some((s) => s.role === "coordinator" && s.tokens === null)).toBe(true);
  });

  test("missing final output fails closed, and replacing a captured report cannot pass a gate", async () => {
    const { w, wt } = await setup();
    const a = await request(wt);
    const b = await request(wt, "code-reviewer");
    advance(w, 5);
    await runTick(w);
    let r = await record(w);
    done(w, r, a.id);
    done(w, r, b.id);
    writeFileSync(join(roleJobDir(w.ctx, r, b.id), "stdout"), '{"type":"turn.completed","usage":{}}');
    advance(w, 5);
    await runTick(w);
    r = await record(w);
    expect(r.roleJobs[1]).toMatchObject({ status: "failed", verdict: "FAIL" });
    const report = required(required(r.roleJobs[0]).reportPath);
    expect(readFileSync(join(wt, report), "utf8")).toStartWith("PASS");
    writeFileSync(join(wt, report), "PASS\nForged evidence.");
    await expect(
      verifyRoleGate(w.ctx, r, "planVerify", a.id, required(r.roleJobs[0]).headSha),
    ).rejects.toMatchObject({
      code: "review_evidence_tampered",
    });
  });
});
