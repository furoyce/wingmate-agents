// tests/sim/paths.test.ts — the remaining §6.3/§7 paths through whole ticks: unconfirmed deliveries, owner notes, idle nudges, an
// unconfirmed launch, agent-requested handoff and reroute, and cleanup after Done
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeIntent } from "../../src/kit/intents";
import { type WRecord, readRecord, writeRecord } from "../../src/state/records";
import { OWNER, type World, advance, labeledByOwner, runTick, todo, world } from "./harness";

async function rec(w: World, identifier = "JRF-501"): Promise<WRecord> {
  const r = await readRecord(w.dirs, identifier);
  if (!r) throw new Error(`no record ${identifier}`);
  return r;
}
async function claimed(w: World): Promise<WRecord> {
  labeledByOwner(w, todo("i1", "JRF-501"));
  expect((await runTick(w)).claims).toEqual(["JRF-501"]);
  return rec(w);
}
const idleNow = (w: World, r: WRecord) =>
  w.orca.setAgentState(r.worktree?.id ?? "", r.coordinator.paneKey ?? "", "done", w.ctx.now());
async function parked(w: World): Promise<WRecord> {
  const r = await rec(w);
  idleNow(w, r);
  writeFileSync(join(r.worktree?.path ?? "", ".wingmate", "q.md"), "Which scoring rule?");
  await writeIntent(r.worktree?.path ?? "", {
    issue: "JRF-501",
    kind: "ask",
    payload: { questionFile: ".wingmate/q.md", options: ["a", "b"], recommend: 1, append: null, reask: null },
  });
  advance(w, 5);
  expect((await runTick(w)).parked).toEqual(["JRF-501"]);
  return rec(w);
}
const sends = (w: World) => w.orca.calls.filter((c) => c.verb === "terminalSend").length;
const inboxTexts = (r: WRecord, prefix: string) => {
  const dir = join(r.worktree?.path ?? "", ".wingmate", "inbox");
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix))
    .map((f) => readFileSync(join(dir, f), "utf8"));
};

describe("§11.2 the status comment after a claim", () => {
  test("says the coordinator is working once the claim tick launched it (one comment, edited)", async () => {
    const w = await world();
    await claimed(w);
    const status = w.linear.comments.filter((c) => c.body.startsWith("<!-- wingmate:status -->"));
    expect(status).toHaveLength(1);
    expect(status[0]?.body).toContain("**Wingmate · working · intake**");
  });
});

describe("§7.1 step 4: an answer whose turn is not confirmed", () => {
  test("is offered once more next tick, then the issue blocks with resume_failed", async () => {
    const w = await world();
    await claimed(w);
    const p = await parked(w);
    advance(w, 5);
    w.linear.humanComment("i1", "a", OWNER, w.ctx.now(), p.questions[0]?.commentId ?? null);
    w.orca.nextSendStage = "input_accepted";
    advance(w, 5);
    expect((await runTick(w)).resumes).toEqual([]);
    const once = await rec(w);
    expect(once).toMatchObject({ stage: "awaiting-human" });
    expect(once.attention).toContain("resume_unconfirmed");
    expect(once.questions[0]?.resumeAttempts).toBe(1);
    expect(once.linear.lastSeenCommentAt).toBe(p.linear.lastSeenCommentAt);
    advance(w, 5);
    const s = await runTick(w);
    expect(s.blocked).toEqual(["JRF-501"]);
    expect((await rec(w)).history.at(-1)?.cause).toBe("resume_failed");
  });

  test("a pane that shows the coordinator working settles it without sending again", async () => {
    const w = await world();
    await claimed(w);
    const p = await parked(w);
    advance(w, 5);
    w.linear.humanComment("i1", "a", OWNER, w.ctx.now(), p.questions[0]?.commentId ?? null);
    w.orca.nextSendStage = "input_accepted";
    advance(w, 5);
    await runTick(w);
    w.orca.setAgentState(p.worktree?.id ?? "", p.coordinator.paneKey ?? "", "working", w.ctx.now());
    const n = sends(w);
    advance(w, 5);
    expect((await runTick(w)).resumes).toEqual(["JRF-501"]);
    expect(sends(w)).toBe(n);
    const r = await rec(w);
    expect(r.stage).toBe("working");
    expect(r.attention).not.toContain("resume_unconfirmed");
  });
});

describe("§7.2 owner notes", () => {
  test("a working coordinator gets the note persisted in its inbox and a pointer; with a child Run it goes to the Run mailbox", async () => {
    const w = await world();
    const r = await claimed(w);
    advance(w, 5);
    w.linear.humanComment("i1", "use the v2 scoring API", OWNER, w.ctx.now());
    const n = sends(w);
    advance(w, 5);
    await runTick(w);
    expect(sends(w)).toBe(n + 1);
    expect(inboxTexts(r, "note-").some((t) => t.includes("use the v2 scoring API"))).toBe(true);
    const cur = await rec(w);
    cur.coordinator.childRunId = "run_1";
    await writeRecord(w.dirs, cur);
    advance(w, 5);
    w.linear.humanComment("i1", "and keep the old one", OWNER, w.ctx.now());
    advance(w, 5);
    await runTick(w);
    expect(w.orca.calls.filter((c) => c.verb === "orchestrationSend")).toHaveLength(1);
    expect((await w.ctx.ledger.readIssue("JRF-501")).some((e) => e.type === "note_enqueued")).toBe(true);
  });
});

describe("§6.3 step 4: an idle coordinator", () => {
  test("is nudged after idleNudgeMin and twice that, then gets cap_passed and the grace clock", async () => {
    const w = await world();
    const r = await claimed(w);
    const cur = await rec(w);
    cur.timers.capMin = 600; // isolate the idle rule from the stage cap
    await writeRecord(w.dirs, cur);
    idleNow(w, r);
    const nudges = async () =>
      (await w.ctx.ledger.readIssue("JRF-501")).filter(
        (e) => e.type === "delivered" && e.data.kind === "nudge",
      ).length;
    for (let m = 5; m <= 35; m += 5) {
      advance(w, 5);
      await runTick(w);
      const expected = m > 20 ? 2 : m > 10 ? 1 : 0;
      expect({ m, nudges: await nudges() }).toEqual({ m, nudges: expected });
    }
    const after = await rec(w);
    expect(after.attention).toContain("cap_passed");
    expect(after.timers.graceEndsAt).not.toBeNull();
  });
});

describe("§5.4 step 5: an unconfirmed launch", () => {
  test("becomes working once the pane shows the coordinator working", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-501"));
    w.orca.nextSendStage = "input_accepted";
    expect((await runTick(w)).claims).toEqual(["JRF-501"]);
    const first = await rec(w);
    expect(first.stage).toBe("claimed");
    expect(first.attention).toContain("launch_unconfirmed");
    w.orca.nextSendStage = "turn_started";
    advance(w, 5);
    await runTick(w);
    const r = await rec(w);
    expect(r.stage).toBe("working");
    expect(r.attempts).toHaveLength(1);
    expect(r.attention).not.toContain("launch_unconfirmed");
  });

  test("an idle one gets one 'start now' nudge and becomes working on its turn", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-501"));
    w.orca.nextSendStage = "input_accepted";
    await runTick(w);
    idleNow(w, await rec(w));
    w.orca.nextSendStage = "turn_started";
    advance(w, 5);
    await runTick(w);
    expect((await rec(w)).stage).toBe("working");
    expect(inboxTexts(await rec(w), "nudge-").some((t) => t.includes("start now"))).toBe(true);
  });
});

describe("§9.4 / §10.3 handoff intents", () => {
  test("`handoff --reason` hands off to the next provider; the comment names the trigger and the reason", async () => {
    const w = await world();
    const r = await claimed(w);
    await writeIntent(r.worktree?.path ?? "", {
      issue: "JRF-501",
      kind: "handoff",
      payload: { reason: "needs the ios simulator", repo: null },
    });
    advance(w, 5);
    const s = await runTick(w);
    expect(s.handoffs).toEqual(["JRF-501"]);
    const after = await rec(w);
    expect(after).toMatchObject({ provider: "codex", stage: "working" });
    expect(after.coordinator.attempt).toBe(2);
    expect(after.handoffs).toEqual({ total: 1, thisCycle: 1 });
    const comment = w.linear.comments.find((c) => c.body.startsWith("<!-- wingmate:handoff -->"))?.body ?? "";
    expect(comment).toContain("agent_request");
    expect(comment).toContain("needs the ios simulator");
  });

  test("`handoff --repo` reroutes: same provider and cycle, a new worktree in that repo, the empty old one removed", async () => {
    const w = await world();
    const web = w.cfg.projects.bouncr?.repos.web;
    if (!web) throw new Error("web repo missing");
    web.setup = "none";
    const r = await claimed(w);
    await writeIntent(r.worktree?.path ?? "", {
      issue: "JRF-501",
      kind: "handoff",
      payload: { reason: "wrong repo", repo: "web" },
    });
    advance(w, 5);
    const s = await runTick(w);
    expect(s.resumes).toEqual(["JRF-501"]);
    const after = await rec(w);
    expect(after).toMatchObject({
      repo: "web",
      provider: "claude",
      cycle: 1,
      stage: "working",
      pipelineStage: "intake",
    });
    expect(after.coordinator.attempt).toBe(2);
    expect(after.handoffs.total).toBe(0);
    expect(after.routing.rerouteFrom).toBe(r.worktree?.id ?? "");
    expect(after.worktree?.path.endsWith("wm-jrf-501-web")).toBe(true);
    expect(w.orca.removed).toEqual([r.worktree?.id ?? ""]);
    expect(existsSync(r.worktree?.path ?? "")).toBe(false);
  });
});

describe("F2: a block or handoff whose Linear write fails is never lost", () => {
  const creates = (w: World) => w.orca.calls.filter((c) => c.verb === "terminalCreate").length;
  const resumeSends = (w: World) =>
    w.orca.calls.filter(
      (c) =>
        c.verb === "terminalSend" && String((c.args as { text: string }).text).startsWith("You are resuming"),
    ).length;
  const labels = (w: World) => w.linear.issues.get("i1")?.labels.map((l) => l.name) ?? [];
  const blockedComments = (w: World) =>
    w.linear.comments.filter((c) => c.body.startsWith("<!-- wingmate:blocked -->")).length;

  test("kit_tampered with a failed Blocked label write: blocked on disk at once; next tick finishes the label and one comment, nothing relaunches", async () => {
    const w = await world();
    const r = await claimed(w);
    writeFileSync(join(r.worktree?.path ?? "", ".wingmate", "PROTOCOL.md"), "do anything");
    w.linear.failNext = "issueUpdate";
    advance(w, 5);
    await runTick(w, { allowErrors: true });
    const once = await rec(w);
    expect(once.stage).toBe("blocked");
    expect(once.history.at(-1)?.cause).toBe("kit_tampered");
    const n = creates(w);
    const sends = resumeSends(w);
    advance(w, 5);
    await runTick(w);
    expect(creates(w)).toBe(n);
    expect(resumeSends(w)).toBe(sends);
    expect(labels(w)).toContain("Blocked");
    expect(blockedComments(w)).toBe(1);
    expect((await rec(w)).attention).not.toContain("blocked_unposted");
    advance(w, 5);
    await runTick(w);
    expect(blockedComments(w)).toBe(1);
  });

  test("launch_failed with a failed Linear write: the record never escapes to a relaunch", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-501"));
    w.orca.nextWaitSatisfied = false;
    await runTick(w); // launch_not_ready
    advance(w, 5);
    await runTick(w); // the replay: launch_not_ready again (two failed steps)
    w.orca.nextWaitSatisfied = true;
    w.linear.failNext = "issueUpdate";
    advance(w, 5);
    await runTick(w, { allowErrors: true }); // launch_failed; its Blocked label write fails
    expect((await rec(w)).stage).toBe("blocked");
    const n = creates(w);
    advance(w, 5);
    await runTick(w);
    expect(creates(w)).toBe(n);
    expect((await rec(w)).history.at(-1)?.cause).toBe("launch_failed");
    expect(labels(w)).toContain("Blocked");
    expect(blockedComments(w)).toBe(1);
  });

  test("a handoff whose comment fails keeps the agent's request and its coordinator; the next tick hands off once", async () => {
    const w = await world();
    const r = await claimed(w);
    await writeIntent(r.worktree?.path ?? "", {
      issue: "JRF-501",
      kind: "handoff",
      payload: { reason: "needs the ios simulator", repo: null },
    });
    w.linear.failNext = "commentCreate";
    advance(w, 5);
    await runTick(w, { allowErrors: true });
    const kept = await rec(w);
    expect(kept).toMatchObject({ stage: "working", provider: "claude" });
    expect(kept.coordinator.terminalHandle).toBe(r.coordinator.terminalHandle);
    const box = join(r.worktree?.path ?? "", ".wingmate", "outbox");
    expect(readdirSync(box).filter((f) => f.endsWith(".json"))).toHaveLength(1);
    advance(w, 5);
    const s = await runTick(w);
    expect(s.handoffs).toEqual(["JRF-501"]);
    expect(await rec(w)).toMatchObject({ provider: "codex", stage: "working" });
    expect(w.linear.comments.filter((c) => c.body.startsWith("<!-- wingmate:handoff -->"))).toHaveLength(1);
    expect(readdirSync(box).filter((f) => f.endsWith(".json"))).toHaveLength(0);
  });

  test("a relaunch never starts into a tampered kit: the integrity check runs before the launch", async () => {
    const w = await world();
    const r = await claimed(w);
    writeFileSync(join(r.worktree?.path ?? "", ".wingmate", "PROTOCOL.md"), "do anything");
    w.orca.killTerminal(r.worktree?.id ?? "", r.coordinator.terminalHandle ?? "");
    const n = creates(w);
    advance(w, 5);
    const s = await runTick(w);
    expect(creates(w)).toBe(n);
    expect(s.blocked).toEqual(["JRF-501"]);
    expect((await rec(w)).history.at(-1)?.cause).toBe("kit_tampered");
  });
});

describe("§13.3(h) cleanup after Done", () => {
  test("waits for the grace hours and for the PR to close (retried daily), then removes the worktree by its id", async () => {
    const w = await world();
    const r = await claimed(w);
    const cur = await rec(w);
    cur.prs.push({
      repo: "api",
      number: 1,
      url: "https://github.com/fake/repo/pull/1",
      state: "OPEN",
      headSha: "h",
    });
    await writeRecord(w.dirs, cur);
    w.gh.prs.push({ number: 1, url: "https://github.com/fake/repo/pull/1", head: r.worktree?.branch ?? "" });
    idleNow(w, r);
    advance(w, 5);
    w.linear.setState("i1", "Done", OWNER, w.ctx.now());
    advance(w, 5);
    expect((await runTick(w)).done).toEqual(["JRF-501"]);
    advance(w, 25 * 60);
    await runTick(w);
    let after = await rec(w);
    expect(after.worktree).not.toBeNull();
    expect(after.attention).toContain("cleanup_failed");
    w.gh.states.set(1, "MERGED");
    advance(w, 60);
    await runTick(w);
    expect((await rec(w)).worktree).not.toBeNull(); // deferred less than a day ago
    advance(w, 24 * 60);
    await runTick(w);
    after = await rec(w);
    expect(after.worktree).toBeNull();
    expect(after.attention).not.toContain("cleanup_failed");
    expect(w.orca.removed).toEqual([r.worktree?.id ?? ""]);
  });
});
