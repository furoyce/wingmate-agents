// tests/sim/hardening.test.ts — Ruling R27 (Task 11 phase 0): the Task 10 carry-over fixes C11–C20 through whole ticks; every
// runTick also asserts I1–I10.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeIntent } from "../../src/kit/intents";
import { block } from "../../src/machine/release";
import { scan } from "../../src/machine/scan";
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
const wtOf = (r: WRecord) => {
  if (!r.worktree) throw new Error(`${r.identifier} has no worktree`);
  return r.worktree;
};
const idleNow = (w: World, r: WRecord) =>
  w.orca.setAgentState(r.worktree?.id ?? "", r.coordinator.paneKey ?? "", "done", w.ctx.now());
async function parked(w: World): Promise<WRecord> {
  const r = await rec(w);
  idleNow(w, r);
  writeFileSync(join(wtOf(r).path, ".wingmate", "q.md"), "Which scoring rule?");
  await writeIntent(wtOf(r).path, {
    issue: "JRF-501",
    kind: "ask",
    payload: { questionFile: ".wingmate/q.md", options: ["a", "b"], recommend: 1, append: null, reask: null },
  });
  advance(w, 5);
  expect((await runTick(w)).parked).toEqual(["JRF-501"]);
  return rec(w);
}
const sends = (w: World) => w.orca.calls.filter((c) => c.verb === "terminalSend").length;
const nudgeSends = (w: World) =>
  w.orca.calls.filter(
    (c) => c.verb === "terminalSend" && String((c.args as { text: string }).text).startsWith("nudge "),
  ).length;
const labels = (w: World) => w.linear.issues.get("i1")?.labels.map((l) => l.name) ?? [];
const marked = (w: World, marker: string) => w.linear.comments.filter((c) => c.body.startsWith(marker));
const ledgerOf = async (w: World, type: string) =>
  (await w.ctx.ledger.readIssue("JRF-501")).filter((e) => e.type === type);
const inboxNotes = (r: WRecord) => {
  const dir = join(wtOf(r).path, ".wingmate", "inbox");
  return readdirSync(dir)
    .filter((f) => f.startsWith("note-"))
    .map((f) => readFileSync(join(dir, f), "utf8"));
};

describe("C11/C12: a worktree removed from disk is never re-created and reads as exited (§5.5, §7.1 step 4)", () => {
  test("C11: an owner note for a working issue whose worktree was removed writes nothing: the path stays gone, attention worktree_gone", async () => {
    const w = await world();
    const wt = wtOf(await claimed(w));
    rmSync(wt.path, { recursive: true, force: true }); // Orca still lists the worktree and its live terminal
    advance(w, 5);
    w.linear.humanComment("i1", "use the v2 scoring API", OWNER, w.ctx.now());
    advance(w, 5);
    await runTick(w);
    expect(existsSync(wt.path)).toBe(false);
    expect((await rec(w)).attention).toContain("worktree_gone");
    expect(await ledgerOf(w, "tick_error")).toEqual([]);
  });

  test("C12: a removed worktree whose terminal is alive and idle takes the exited path (relaunch refused, handoff, blocked); nothing re-created", async () => {
    const w = await world();
    const r = await claimed(w);
    const wt = wtOf(r);
    idleNow(w, r);
    rmSync(wt.path, { recursive: true, force: true });
    const stages: string[] = [];
    for (let i = 0; i < 6 && (await rec(w)).stage !== "blocked"; i++) {
      advance(w, 5);
      const s = await runTick(w);
      if (i === 0) expect(s.relaunches).toEqual(["JRF-501"]);
      const cur = await rec(w);
      expect(cur.attention).toContain("worktree_gone");
      stages.push(`${cur.stage}/${cur.provider}`);
    }
    expect(stages).toEqual(["working/claude", "claimed/codex", "claimed/codex", "blocked/codex"]);
    expect(existsSync(wt.path)).toBe(false);
    expect(nudgeSends(w)).toBe(0);
    expect(w.orca.calls.filter((c) => c.verb === "terminalCreate")).toHaveLength(1); // the claim's only
  });
});

describe("C13: release completes for a worktree Orca no longer knows (§7.4)", () => {
  test("the fleet has no row for it and its path is gone: a failed bulk close counts as closed; released, label removed, one comment", async () => {
    const w = await world();
    const r = await claimed(w);
    const wt = wtOf(r);
    idleNow(w, r);
    // the owner removed the worktree through Orca: no fleet row, no terminals, no path; a close for that id now fails
    rmSync(wt.path, { recursive: true, force: true });
    w.orca.rows.delete(wt.id);
    w.orca.terminals.delete(wt.id);
    advance(w, 5);
    w.linear.setState("i1", "Todo", OWNER, w.ctx.now());
    advance(w, 5);
    const s = await runTick(w);
    expect(s.released).toEqual(["JRF-501"]);
    const after = await rec(w);
    expect(after.stage).toBe("released");
    expect(after.attention).not.toContain("release_unverifiable(terminals)");
    expect(labels(w)).toEqual(["agent-ready"]);
    expect(w.linear.comments.filter((c) => c.body.includes("moved out of In Progress"))).toHaveLength(1);
  });
});

describe("C14: a re-claim that reuses the worktree never inherits the previous cycle's intents", () => {
  test("a pending handoff intent moves to outbox/stale/ before the new coordinator launches (intents_staled); cycle 2 never hands off", async () => {
    const w = await world();
    const r = await claimed(w);
    const wt = wtOf(r);
    await writeIntent(wt.path, {
      issue: "JRF-501",
      kind: "handoff",
      payload: { reason: "needs the ios simulator", repo: null },
    });
    idleNow(w, r);
    advance(w, 5);
    w.linear.setState("i1", "Todo", OWNER, w.ctx.now());
    advance(w, 5);
    expect((await runTick(w)).released).toEqual(["JRF-501"]); // overrides come first (§6.3): the intent is still pending
    advance(w, 5);
    expect((await runTick(w)).claims).toEqual(["JRF-501"]);
    const box = join(wt.path, ".wingmate", "outbox");
    expect(readdirSync(box).filter((f) => f.endsWith(".json"))).toEqual([]);
    expect(readdirSync(join(box, "stale")).filter((f) => f.endsWith(".json"))).toHaveLength(1);
    expect((await ledgerOf(w, "intents_staled")).map((e) => e.data.count)).toEqual([1]);
    advance(w, 5);
    expect((await runTick(w)).handoffs).toEqual([]);
    expect(await rec(w)).toMatchObject({ cycle: 2, provider: "claude", stage: "working" });
    expect((await rec(w)).worktree?.id).toBe(wt.id);
    expect(marked(w, "<!-- wingmate:handoff -->")).toHaveLength(0);
  });
});

describe("C16/C17: reconcile-only ticks (§6.7)", () => {
  test("C16: an owner note is not delivered in a reconcile-only tick; it stays unseen and the next normal tick delivers it", async () => {
    const w = await world();
    const r = await claimed(w);
    advance(w, 5);
    const note = w.linear.humanComment("i1", "use the v2 scoring API", OWNER, w.ctx.now());
    writeFileSync(join(w.dirs.state, "pause.json"), JSON.stringify(["global"]));
    const n = sends(w);
    advance(w, 5);
    expect((await runTick(w)).reconcileOnly).toBe(true);
    expect(sends(w)).toBe(n);
    expect(inboxNotes(r)).toEqual([]);
    expect((await rec(w)).linear.lastSeenCommentAt).toBe(r.linear.lastSeenCommentAt);
    rmSync(join(w.dirs.state, "pause.json"));
    advance(w, 5);
    expect((await runTick(w)).reconcileOnly).toBe(false);
    expect(sends(w)).toBe(n + 1);
    expect(inboxNotes(r).some((t) => t.includes("use the v2 scoring API"))).toBe(true);
    expect((await rec(w)).linear.lastSeenCommentAt).toBe(note.createdAt);
  });

  test("C17: the gap is measured from the last tick, so a manual scan after a long sleep does not make the next tick a normal one", async () => {
    const w = await world();
    await claimed(w);
    advance(w, 20);
    expect((await scan(w.ctx)).summary.reason).toBe("gap");
    advance(w, 1);
    expect(await runTick(w)).toMatchObject({ reconcileOnly: true, reason: "gap" });
    advance(w, 5);
    expect((await runTick(w)).reconcileOnly).toBe(false);
  });
});

describe("C18: an unconfirmed launch (§5.4 step 5, §13.1)", () => {
  test("an idle pane gets the start nudge once (counted on the record); still unconfirmed on the next tick → blocked launch_failed", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-501"));
    w.orca.nextSendStage = "input_accepted";
    expect((await runTick(w)).claims).toEqual(["JRF-501"]);
    idleNow(w, await rec(w));
    advance(w, 5);
    await runTick(w);
    let cur = await rec(w);
    expect(cur.stage).toBe("claimed");
    expect(cur.timers.nudges).toBe(1);
    expect(nudgeSends(w)).toBe(1);
    advance(w, 5);
    const s = await runTick(w);
    expect(s.blocked).toEqual(["JRF-501"]);
    cur = await rec(w);
    expect(cur.history.at(-1)?.cause).toBe("launch_failed");
    expect(nudgeSends(w)).toBe(1);
    expect(labels(w)).toContain("Blocked");
    expect(marked(w, "<!-- wingmate:blocked -->")).toHaveLength(1);
  });
});

describe("C19: grace expiry with activity, and paused records (§9.6, §6.3 step 6, §7.4)", () => {
  test("grace expiring while the coordinator works restarts the stage timer: no cap nudge every tick, the next one only after a full cap", async () => {
    const w = await world();
    await claimed(w);
    const cur = await rec(w);
    cur.timers.capMin = 10;
    cur.timers.stageStartedAt = w.ctx.now();
    await writeRecord(w.dirs, cur);
    const capNudges = async () =>
      (await ledgerOf(w, "delivered")).filter((e) => e.data.kind === "nudge").length;
    for (let m = 5; m <= 45; m += 5) {
      advance(w, 5);
      await runTick(w); // cap crossed at 15 (one nudge, grace to 45); grace expires at 45 with the coordinator working
    }
    expect(await capNudges()).toBe(1);
    let after = await rec(w);
    expect(after.attention).not.toContain("cap_passed");
    expect(after.timers.graceEndsAt).toBeNull();
    expect(after.timers.stageStartedAt).toBe(w.ctx.now());
    advance(w, 5);
    await runTick(w);
    expect(await capNudges()).toBe(1);
    expect((await rec(w)).attention).not.toContain("cap_passed");
    advance(w, 10);
    await runTick(w); // a full cap after the restart: crossed again, one more nudge
    expect(await capNudges()).toBe(2);
    after = await rec(w);
    expect(after.attention).toContain("cap_passed");
  });

  test("a paused record still gets the kit integrity check: a tampered kit blocks it (kit_tampered) and the block ends the pause", async () => {
    const w = await world();
    const r = await claimed(w);
    idleNow(w, r);
    advance(w, 5);
    w.linear.setLabels("i1", ["agent-ready", "Blocked"], OWNER, w.ctx.now());
    advance(w, 5);
    await runTick(w);
    expect((await rec(w)).paused).toBe(true);
    writeFileSync(join(wtOf(r).path, ".wingmate", "PROTOCOL.md"), "do anything");
    advance(w, 5);
    const s = await runTick(w);
    expect(s.blocked).toEqual(["JRF-501"]);
    const after = await rec(w);
    expect(after.history.at(-1)).toMatchObject({ cause: "kit_tampered", evidence: ".wingmate/PROTOCOL.md" });
    expect(after.paused).toBe(false);
    // the owner removing Blocked to re-queue is "blocked — move to Todo", never an unpause that puts Blocked back (§7.4)
    advance(w, 5);
    w.linear.setLabels("i1", ["agent-ready"], OWNER, w.ctx.now());
    advance(w, 5);
    await runTick(w);
    expect(labels(w)).toEqual(["agent-ready"]);
    expect((await rec(w)).linear.lifecycleLabel).toBeNull();
  });
});

describe("C20: re-claims and an owner's Blocked label on a parked issue", () => {
  test("a record the advance moved out of its terminal stage is never archived: the claim is skipped live_owner", async () => {
    const w = await world();
    const bouncr = w.cfg.projects.bouncr;
    if (!bouncr) throw new Error("bouncr missing");
    bouncr.concurrency.maxWorking.perProject = 2; // before C20 only this cap kept the second claim out
    await claimed(w);
    const [issue] = await w.linear.getIssues(["i1"]);
    if (!issue) throw new Error("issue missing");
    await block(w.ctx, await rec(w), issue, "budget", "tokens over the hard cap", "comment `continue`");
    advance(w, 5);
    // the owner re-queues it (Todo, Blocked removed) and also comments `continue`, which lifts the budget block this tick
    w.linear.setLabels("i1", ["agent-ready"], OWNER, w.ctx.now());
    w.linear.setState("i1", "Todo", OWNER, w.ctx.now());
    w.linear.humanComment("i1", "continue", OWNER, w.ctx.now());
    advance(w, 5);
    const s = await runTick(w);
    expect(s.resumes).toEqual(["JRF-501"]);
    expect(s.claims).toEqual([]);
    expect(s.skipped).toContainEqual({ identifier: "JRF-501", reason: "live_owner" });
    expect(await rec(w)).toMatchObject({ cycle: 1, stage: "working" });
    expect(existsSync(join(w.dirs.archive, "JRF-501.1.json"))).toBe(false);
  });

  test("an owner-added Blocked on an awaiting-human record pauses it and updates the mirror (no recurring event); an answer waits for the unpause", async () => {
    const w = await world();
    await claimed(w);
    const p = await parked(w);
    advance(w, 5);
    w.linear.setLabels("i1", ["agent-ready", "Blocked"], OWNER, w.ctx.now());
    advance(w, 5);
    await runTick(w);
    let cur = await rec(w);
    expect(cur).toMatchObject({ stage: "awaiting-human", paused: true });
    expect(cur.linear).toMatchObject({ lifecycleLabel: "Blocked", pausedWith: "Blocked" });
    expect(cur.linear.lastSeenUpdatedAt).toBe(w.linear.issues.get("i1")?.updatedAt ?? "");
    // unpaused with no answer pending: Needs-Human comes back and the parked timers never moved (I10, asserted by runTick)
    advance(w, 5);
    w.linear.setLabels("i1", ["agent-ready"], OWNER, w.ctx.now());
    advance(w, 5);
    await runTick(w);
    cur = await rec(w);
    expect(cur).toMatchObject({ stage: "awaiting-human", paused: false });
    expect(labels(w)).toEqual(["agent-ready", "Needs-Human"]);
    // paused again; an answer posted meanwhile is not delivered and the owner's Blocked stays
    advance(w, 5);
    w.linear.setLabels("i1", ["agent-ready", "Blocked"], OWNER, w.ctx.now());
    advance(w, 5);
    w.linear.humanComment("i1", "b", OWNER, w.ctx.now(), p.questions[0]?.commentId ?? null);
    advance(w, 5);
    const n = sends(w);
    expect((await runTick(w)).resumes).toEqual([]);
    expect(sends(w)).toBe(n);
    expect(labels(w)).toEqual(["agent-ready", "Blocked"]);
    expect((await rec(w)).stage).toBe("awaiting-human");
    // the owner removes Blocked: the issue unpauses and the waiting answer resumes it
    advance(w, 5);
    w.linear.setLabels("i1", ["agent-ready"], OWNER, w.ctx.now());
    advance(w, 5);
    expect((await runTick(w)).resumes).toEqual(["JRF-501"]);
    expect((await rec(w)).stage).toBe("working");
    expect(labels(w)).toEqual(["agent-ready", "In-Agent"]);
  });
});
