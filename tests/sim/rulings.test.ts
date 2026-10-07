// tests/sim/rulings.test.ts — controller rulings and Task 9 carry-overs exercised through whole ticks
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { issueCommand } from "../../src/cli/commands/issue";
import { parseArgv } from "../../src/cli/index";
import { writeIntent } from "../../src/kit/intents";
import { readLocal, writeLocal } from "../../src/kit/local";
import { scan } from "../../src/machine/scan";
import { readHeartbeat, requestStop } from "../../src/state/heartbeat";
import { withRecordLock } from "../../src/state/lock";
import { type WRecord, listRecords, readRecord, writeRecord } from "../../src/state/records";
import { AGENT_SET_TITLE } from "../fakes/fakeOrca";
import { OWNER, type World, advance, labeledByOwner, readyToFinish, runTick, todo, world } from "./harness";

async function rec(w: World, identifier = "JRF-501"): Promise<WRecord> {
  const r = await readRecord(w.dirs, identifier);
  if (!r) throw new Error(`no record ${identifier}`);
  return r;
}
async function claimed(w: World, id = "i1", identifier = "JRF-501"): Promise<WRecord> {
  labeledByOwner(w, todo(id, identifier));
  const s = await runTick(w);
  expect(s.claims).toEqual([identifier]);
  return rec(w, identifier);
}
async function parked(w: World, identifier = "JRF-501"): Promise<WRecord> {
  const r = await rec(w, identifier);
  const wt = r.worktree?.path ?? "";
  w.orca.setAgentState(r.worktree?.id ?? "", r.coordinator.paneKey ?? "", "done", w.ctx.now());
  writeFileSync(join(wt, ".wingmate", "q.md"), "Which scoring rule?");
  await writeIntent(wt, {
    issue: identifier,
    kind: "ask",
    payload: { questionFile: ".wingmate/q.md", options: ["a", "b"], recommend: 1, append: null, reask: null },
  });
  advance(w, 5);
  expect((await runTick(w)).parked).toEqual([identifier]);
  return rec(w, identifier);
}
const foreignLock = JSON.stringify({
  pid: process.pid,
  startedAt: "2026-10-06T10:20:00Z",
  token: "another-tick",
  heartbeatAt: "2026-10-06T10:20:00Z",
});
/** The agent's own `.wingmate/gates.json` as `gate` writes it: every stage up to security passed (ui NA) at `headSha`, validate after one FAIL. */
async function passLocalGates(wt: string, headSha: string): Promise<void> {
  const local = await readLocal(wt);
  for (const s of ["intake", "plan", "planVerify", "implement", "validate", "ui", "security"])
    local.gates[s] = {
      verdict: s === "ui" ? "NA" : "PASS",
      failCount: s === "validate" ? 1 : 0,
      at: null,
      evidencePath: null,
      headSha,
      note: null,
      method: null,
      dispatchId: null,
    };
  await writeLocal(wt, local);
}
/** One `wingmate issue JRF-501 <verb> …` run inside the worktree, as the coordinator runs it (no Orca: no workers to check). */
async function agentVerb(wt: string, args: string[]): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => {
    out.push(String(s));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await issueCommand(parseArgv(["issue", "JRF-501", ...args]), {
      cwd: wt,
      orca: { workerList: async () => [] },
    });
    return { code, out: out.join("") };
  } finally {
    process.stdout.write = orig;
  }
}
type Settings = { sandbox: { filesystem: { denyWrite: string[] } } };
const denyOf = (w: World, id: string) =>
  (JSON.parse(readFileSync(join(w.ctx.kitDirFor(id), "claude-settings.json"), "utf8")) as Settings).sandbox
    .filesystem.denyWrite;

describe("R16: a tick whose lock was reclaimed aborts before its next external action", () => {
  test("outcome lock_lost; the new holder's lock is untouched; nothing is launched after the loss", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-501"));
    let reclaimed = false;
    w.orca.onCall = async (verb) => {
      if (verb !== "worktreeCreate" || reclaimed) return;
      reclaimed = true;
      writeFileSync(join(w.dirs.state, "tick.lock"), foreignLock);
      await Bun.sleep(60); // the heartbeat runs and finds another token
    };
    const s = await runTick(w, { lockHeartbeatMs: 10 });
    expect(s.outcome).toBe("lock_lost");
    expect(s.reason).toBe("lock_lost");
    expect(readFileSync(join(w.dirs.state, "tick.lock"), "utf8")).toBe(foreignLock);
    expect(w.orca.calls.filter((c) => c.verb === "terminalCreate")).toEqual([]);
    expect((await readHeartbeat(w.dirs))?.outcome).toBe("lock_lost");
    expect((await readHeartbeat(w.dirs))?.exitCode).toBe(1);
  });
});

describe("TES-1: the guard holds for Linear and git writes too (Ruling R16, §13.3 i)", () => {
  test("a lock reclaimed during a claim's first Linear write: no Linear write follows it (outcome lock_lost)", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-501"));
    let at = -1;
    w.linear.onCall = async (m) => {
      if (m !== "updateIssue" || at >= 0) return;
      at = w.linear.writes.length;
      writeFileSync(join(w.dirs.state, "tick.lock"), foreignLock);
      await Bun.sleep(60); // the heartbeat runs and finds another token
    };
    const s = await runTick(w, { lockHeartbeatMs: 10 });
    w.linear.onCall = null;
    expect(s.outcome).toBe("lock_lost");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(w.linear.writes.slice(at)).toHaveLength(1); // only the write in flight when the lock was lost
    expect(w.orca.calls.filter((c) => c.verb === "worktreeCreate")).toEqual([]);
  });

  test("a stop for everything requested while a finish reads the remote: nothing is pushed, no PR (outcome stopped)", async () => {
    const w = await world();
    const r = await claimed(w);
    await readyToFinish(w, "JRF-501");
    await writeIntent(r.worktree?.path ?? "", {
      issue: "JRF-501",
      kind: "finish",
      payload: { summaryFile: ".wingmate/s.md", title: null, draft: false, repos: [] },
    });
    const read = w.git.lsRemoteSha.bind(w.git);
    let asked = false;
    w.git.lsRemoteSha = async (t, url, branch) => {
      if (branch === r.worktree?.branch && !asked) {
        asked = true;
        await requestStop(w.dirs, { scope: "all", at: w.ctx.now() });
      }
      return read(t, url, branch);
    };
    advance(w, 5);
    const s = await runTick(w);
    expect(asked).toBe(true);
    expect(s.outcome).toBe("stopped");
    expect(w.git.pushed).toEqual([]);
    expect(w.gh.prs).toEqual([]);
  });
});

describe("§13.3(i) stop requests", () => {
  test("a stop for everything, requested mid-tick, aborts the tick before its next external action (outcome stopped)", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-501"));
    w.orca.onCall = async (verb) => {
      if (verb === "worktreeCreate") await requestStop(w.dirs, { scope: "all", at: w.ctx.now() });
    };
    const s = await runTick(w);
    expect(s.outcome).toBe("stopped");
    expect(w.orca.calls.filter((c) => c.verb === "terminalCreate")).toEqual([]);
  });

  test("an issue-scoped stop skips that issue's processing and claims; other issues proceed", async () => {
    const w = await world();
    await requestStop(w.dirs, { scope: "issue", key: "JRF-501", at: w.ctx.now() });
    labeledByOwner(w, todo("i1", "JRF-501"));
    labeledByOwner(w, todo("i2", "JRF-502"));
    const s = await runTick(w);
    expect(s.claims).toEqual(["JRF-502"]);
    expect(s.skipped).toContainEqual({ identifier: "JRF-501", reason: "stop_requested" });
  });
});

describe("F1: the record lock is held only for a read or a write; another writer's change is never overwritten", () => {
  const SMART = "a0d17ec1-b237-4481-9efb-1eff9fe69efe";

  test("a stop that blocks the record during a relaunch's Orca wait survives the tick (record_changed); nothing relaunches after", async () => {
    const w = await world();
    const r = await claimed(w);
    w.orca.killTerminal(r.worktree?.id ?? "", r.coordinator.terminalHandle ?? "");
    const seen: { lockHeld: boolean | null } = { lockHeld: null };
    w.orca.onCall = async (verb) => {
      if (verb !== "terminalWait" || seen.lockHeld !== null) return;
      seen.lockHeld = existsSync(join(w.dirs.records, "JRF-501.lock"));
      // `wingmate stop` step (4): under the record lock, the record is marked blocked (owner_stop) and its handle dropped
      const stop = async () => {
        const cur = await rec(w);
        cur.history.push({
          at: w.ctx.now(),
          from: cur.stage,
          to: "blocked",
          cause: "owner_stop",
          evidence: null,
        });
        Object.assign(cur, { stage: "blocked" });
        Object.assign(cur.coordinator, { terminalHandle: null, paneKey: null });
        await writeRecord(w.dirs, cur);
      };
      if (seen.lockHeld)
        await stop(); // as P7: the tick's lock went stale (> 60 s) and the stop broke it
      else await withRecordLock(w.dirs, "JRF-501", stop);
    };
    advance(w, 5);
    const s = await runTick(w);
    w.orca.onCall = null;
    expect(seen.lockHeld).toBe(false);
    const after = await rec(w);
    expect(after.stage).toBe("blocked");
    expect(after.history.at(-1)?.cause).toBe("owner_stop");
    expect(after.coordinator.terminalHandle).toBeNull();
    expect(s.skipped).toContainEqual({ identifier: "JRF-501", reason: "record_changed" });
    expect((await w.ctx.ledger.readIssue("JRF-501")).some((e) => e.type === "record_changed")).toBe(true);
    const creates = w.orca.calls.filter((c) => c.verb === "terminalCreate").length;
    advance(w, 5);
    const next = await runTick(w);
    expect(w.orca.calls.filter((c) => c.verb === "terminalCreate").length).toBe(creates);
    expect([...next.relaunches, ...next.handoffs]).toEqual([]);
  });

  test("a stop scoped to the issue, requested while its relaunch is in flight, aborts that record before its next external action; the tick goes on", async () => {
    const w = await world();
    const smart = w.cfg.projects["smart-dispatcher"]?.repos.main;
    if (!smart) throw new Error("smart-dispatcher repo missing");
    smart.setup = "none";
    const r = await claimed(w);
    w.orca.killTerminal(r.worktree?.id ?? "", r.coordinator.terminalHandle ?? "");
    labeledByOwner(w, todo("i2", "JRF-601", { projectId: SMART }));
    let mark = -1;
    w.orca.onCall = async (verb, args) => {
      if (verb !== "terminalCreate" || mark >= 0 || (args as { wt: string }).wt !== r.worktree?.id) return;
      mark = w.orca.calls.length;
      await requestStop(w.dirs, { scope: "issue", key: "JRF-501", at: w.ctx.now() });
    };
    advance(w, 5);
    const s = await runTick(w);
    w.orca.onCall = null;
    const sentAfterStop = w.orca.calls
      .slice(mark)
      .filter((c) => ["terminalSend", "terminalKeys", "orchestrationSend"].includes(c.verb))
      .filter((c) => !JSON.stringify(c.args).includes("JRF-601"));
    expect(sentAfterStop).toEqual([]);
    expect(s.outcome).not.toBe("stopped");
    expect(s.skipped).toContainEqual({ identifier: "JRF-501", reason: "stop_requested" });
    expect(s.claims).toEqual(["JRF-601"]);
  });
});

describe("INT-2 + N3 (§4.4): the coordinator's handle is runtime-scoped and re-resolved each tick", () => {
  const creates = (w: World) => w.orca.calls.filter((c) => c.verb === "terminalCreate").length;
  /** Orca restarted: every terminal of the worktree re-attached under a new handle and pane (`moves`: old handle → new id), agent-titled. */
  function restart(w: World, wt: string, moves: Record<string, string>): void {
    const panes = new Map<string, string>();
    w.orca.terminals.set(
      wt,
      (w.orca.terminals.get(wt) ?? []).map((t) => {
        const to = moves[t.handle];
        if (!to) return { ...t, title: AGENT_SET_TITLE };
        panes.set(`${t.tabId}:${t.leafId}`, `tab${to}:leaf${to}`);
        return { ...t, handle: `term_${to}`, tabId: `tab${to}`, leafId: `leaf${to}`, title: AGENT_SET_TITLE };
      }),
    );
    for (const a of w.orca.rows.get(wt)?.agents ?? []) a.paneKey = panes.get(a.paneKey) ?? a.paneKey;
  }

  test("an Orca restart that re-issued the coordinator's handle and pane key is followed whatever its title, never relaunched (handle_rebound, one coordinator)", async () => {
    const w = await world();
    const r = await claimed(w);
    const wt = r.worktree?.id ?? "";
    restart(w, wt, { [r.coordinator.terminalHandle ?? ""]: "R" });
    const n = creates(w);
    advance(w, 5);
    const s = await runTick(w);
    expect([...s.relaunches, ...s.handoffs, ...s.blocked]).toEqual([]);
    expect(creates(w)).toBe(n);
    const after = await rec(w);
    expect(after.coordinator).toMatchObject({
      terminalHandle: "term_R",
      paneKey: "tabR:leafR",
      relaunches: 0,
    });
    const rebound = (await w.ctx.ledger.readIssue("JRF-501")).filter((e) => e.type === "handle_rebound");
    expect(rebound.map((e) => e.data)).toEqual([{ from: r.coordinator.terminalHandle, to: "term_R" }]);
  });

  test("N3: …with a role agent of the child Run live beside it (re-issued too): the coordinator is still the one followed; the role is never taken for it", async () => {
    const w = await world();
    const r = await claimed(w);
    const wt = r.worktree?.id ?? "";
    const role = await w.orca.terminalCreate(wt, "wingmate JRF-501 code-reviewer", "claude");
    const cur = await rec(w);
    cur.coordinator.childRunId = "run_child";
    await writeRecord(w.dirs, cur);
    restart(w, wt, { [r.coordinator.terminalHandle ?? ""]: "R", [role.handle]: "W" });
    w.orca.workers.set("run_child", [
      {
        dispatchId: "ctx_1",
        taskId: "task_1",
        runId: "run_child",
        workerState: "running",
        dispatchStatus: "active",
        agentTerminalHandle: "term_W", // worker-list reports the role's handle as Orca now knows it
        verdict: "live",
      },
    ]);
    const n = creates(w);
    advance(w, 5);
    const s = await runTick(w);
    expect([...s.relaunches, ...s.handoffs, ...s.blocked]).toEqual([]);
    expect(creates(w)).toBe(n);
    expect((await rec(w)).coordinator).toMatchObject({ terminalHandle: "term_R", relaunches: 0 });
  });

  test("N3: two live agent terminals neither of which the record holds (the owner's own Claude session beside the re-issued coordinator) are never guessed between: liveness unverifiable, attention coordinator_ambiguous, no relaunch, no new terminal", async () => {
    const w = await world();
    const r = await claimed(w);
    const wt = r.worktree?.id ?? "";
    w.orca.foreignAgents.add((await w.orca.terminalCreate(wt, "owner", "claude")).handle);
    restart(w, wt, { [r.coordinator.terminalHandle ?? ""]: "R" });
    const n = creates(w);
    advance(w, 5);
    const s = await runTick(w);
    expect([...s.relaunches, ...s.handoffs, ...s.blocked]).toEqual([]);
    expect(creates(w)).toBe(n);
    expect(s.attention).toContainEqual({ identifier: "JRF-501", code: "coordinator_ambiguous" });
    const after = await rec(w);
    expect(after.attention).toEqual(
      expect.arrayContaining(["liveness_unverifiable", "coordinator_ambiguous"]),
    );
    expect(after.coordinator).toMatchObject({ terminalHandle: r.coordinator.terminalHandle, relaunches: 0 });
  });
});

describe("R20: attention is a set; the change windows advance", () => {
  test("a persistent unauthorized `human` label never grows attention and releases nothing", async () => {
    const w = await world();
    await claimed(w);
    advance(w, 5);
    w.linear.setLabels("i1", ["agent-ready", "In-Agent", "human"], "guest-user", w.ctx.now());
    for (let n = 0; n < 3; n++) {
      advance(w, 5);
      await runTick(w);
    }
    const r = await rec(w);
    expect(r.stage).toBe("working");
    expect(r.attention.filter((a) => a === "unauthorized_label_change")).toHaveLength(1);
  });

  test("lastSeenUpdatedAt follows the issue once its overrides are consumed; lastSeenCommentAt follows each processed comment", async () => {
    const w = await world();
    await claimed(w);
    advance(w, 5);
    w.linear.humanComment("i1", "keep the API stable", OWNER, w.ctx.now());
    advance(w, 5);
    await runTick(w);
    const r = await rec(w);
    expect(r.linear.lastSeenCommentAt).toBe(
      w.linear.comments.find((c) => c.body === "keep the API stable")?.createdAt ?? "",
    );
    expect(r.linear.lastSeenUpdatedAt).toBe(w.linear.issues.get("i1")?.updatedAt ?? "");
    // the agent's turn ended before the owner paused it (§7.4: a change made while an agent works is not applied)
    w.orca.setAgentState(r.worktree?.id ?? "", r.coordinator.paneKey ?? "", "done", w.ctx.now());
    advance(w, 5);
    w.linear.setLabels("i1", ["agent-ready", "Blocked"], OWNER, w.ctx.now());
    advance(w, 5);
    await runTick(w);
    const paused = await rec(w);
    expect(paused.paused).toBe(true);
    expect(paused.linear.lastSeenUpdatedAt).toBe(w.linear.issues.get("i1")?.updatedAt ?? "");
  });
});

describe("I5: an owner change made between the tick's read and its write is never overwritten", () => {
  test("the pre-write re-read drops the label write; the next tick applies the owner's pause", async () => {
    const w = await world();
    const r = await claimed(w);
    const wt = r.worktree?.path ?? "";
    w.orca.setAgentState(r.worktree?.id ?? "", r.coordinator.paneKey ?? "", "done", w.ctx.now());
    writeFileSync(join(wt, ".wingmate", "q.md"), "Which scoring rule?");
    await writeIntent(wt, {
      issue: "JRF-501",
      kind: "ask",
      payload: {
        questionFile: ".wingmate/q.md",
        options: ["a", "b"],
        recommend: 1,
        append: null,
        reask: null,
      },
    });
    let reads = 0;
    advance(w, 5);
    const at = w.ctx.now();
    w.linear.onCall = (m) => {
      if (m === "getIssues" && ++reads === 2) w.linear.setLabels("i1", ["agent-ready", "Blocked"], OWNER, at);
    };
    await runTick(w);
    w.linear.onCall = null;
    expect(w.linear.issues.get("i1")?.labels.map((l) => l.name)).toEqual(["agent-ready", "Blocked"]);
    expect((await rec(w)).stage).toBe("working");
    advance(w, 5);
    await runTick(w);
    const after = await rec(w);
    expect(after.paused).toBe(true);
    expect(w.linear.comments.filter((c) => c.body.startsWith("<!-- wingmate:question"))).toHaveLength(1);
  });
});

describe("R22/R24: sibling denies are refreshed after a claim and before every relaunch", () => {
  test("claiming a second issue in the repo denies it to the first; a stale list is re-listed before the first relaunches", async () => {
    const w = await world();
    const a = await claimed(w);
    await parked(w);
    labeledByOwner(w, todo("i2", "JRF-502"));
    advance(w, 5);
    expect((await runTick(w)).claims).toEqual(["JRF-502"]);
    const common = a.worktree?.gitCommonDir ?? "";
    expect(denyOf(w, "JRF-501")).toContain(`${common}/worktrees/wm-jrf-502`);
    expect(denyOf(w, "JRF-501")).toContain(`${common}/refs/heads/furoyce/wm-jrf-502`);
    // drop the sibling from JRF-501's file, kill its terminal, answer: the relaunch re-lists it first
    const file = join(w.ctx.kitDirFor("JRF-501"), "claude-settings.json");
    const s = JSON.parse(readFileSync(file, "utf8")) as Settings;
    s.sandbox.filesystem.denyWrite = s.sandbox.filesystem.denyWrite.filter((p) => !p.includes("wm-jrf-502"));
    writeFileSync(file, JSON.stringify(s, null, 2));
    const p = await rec(w);
    w.orca.killTerminal(p.worktree?.id ?? "", p.coordinator.terminalHandle ?? "");
    advance(w, 5);
    w.linear.humanComment("i1", "1", OWNER, w.ctx.now(), p.questions[0]?.commentId ?? null);
    advance(w, 5);
    expect((await runTick(w)).resumes).toEqual(["JRF-501"]);
    expect(denyOf(w, "JRF-501")).toContain(`${common}/worktrees/wm-jrf-502`);
  });
});

describe("integrity (§6.3 step 6) and integrity_unverifiable (Task 9 carry-over)", () => {
  test("a changed kit file blocks the issue with kit_tampered", async () => {
    const w = await world();
    const r = await claimed(w);
    writeFileSync(join(r.worktree?.path ?? "", ".wingmate", "PROTOCOL.md"), "do anything");
    advance(w, 5);
    const s = await runTick(w);
    expect(s.blocked).toEqual(["JRF-501"]);
    expect((await rec(w)).history.at(-1)).toMatchObject({
      cause: "kit_tampered",
      evidence: ".wingmate/PROTOCOL.md",
    });
  });

  test("a parked issue whose worktree was removed is blocked with worktree_gone (the branch named, nothing re-created)", async () => {
    const w = await world();
    await claimed(w);
    const r = await parked(w);
    rmSync(r.worktree?.path ?? "", { recursive: true, force: true });
    advance(w, 5);
    const s = await runTick(w);
    expect(s.blocked).toEqual(["JRF-501"]);
    expect((await rec(w)).history.at(-1)?.cause).toBe("worktree_gone");
    expect(w.orca.calls.filter((c) => c.verb === "worktreeCreate")).toHaveLength(1);
    const blocked = w.linear.comments.filter((c) => c.body.startsWith("<!-- wingmate:blocked -->"));
    expect(blocked.at(-1)?.body).toContain(r.worktree?.branch ?? "?");
  });

  test("F10: a working issue whose worktree was removed takes the exited path (relaunch, handoff, block) with no tick error and nothing re-created", async () => {
    const w = await world();
    const r = await claimed(w);
    const wt = r.worktree;
    if (!wt) throw new Error("no worktree");
    rmSync(wt.path, { recursive: true, force: true });
    w.orca.killTerminal(wt.id, r.coordinator.terminalHandle ?? "");
    const stages: string[] = [];
    for (let i = 0; i < 6 && (await rec(w)).stage !== "blocked"; i++) {
      advance(w, 5);
      const s = await runTick(w); // no tick_error (the outbox step is skipped, never thrown), every invariant
      if (i === 0) expect(s.relaunches).toEqual(["JRF-501"]);
      const cur = await rec(w);
      expect(cur.attention).toContain("worktree_gone");
      stages.push(`${cur.stage}/${cur.provider}`);
    }
    // relaunch (exited, worktree_gone) → handoff to codex → its relaunch (worktree_gone) → handoff refused: blocked
    expect(stages).toEqual(["working/claude", "claimed/codex", "claimed/codex", "blocked/codex"]);
    const after = await rec(w);
    expect(after.history.map((h) => h.cause).slice(-2)).toEqual(["handoff", "cascade_exhausted"]);
    expect(existsSync(wt.path)).toBe(false); // Wingmate never re-creates a removed worktree
    expect(w.orca.calls.filter((c) => c.verb === "terminalCreate")).toHaveLength(1); // the claim's only
    expect(w.orca.calls.filter((c) => c.verb === "worktreeCreate")).toHaveLength(1);
    expect(
      (await w.ctx.ledger.readIssue("JRF-501")).filter(
        (e) => e.type === "tick_error" || e.type === "outbox_unsafe",
      ),
    ).toEqual([]);
    expect(w.linear.comments.filter((c) => c.body.startsWith("<!-- wingmate:blocked -->"))).toHaveLength(1);
  });

  test("a working worktree whose git status fails gets attention integrity_unverifiable and is not blocked", async () => {
    const w = await world();
    const r = await claimed(w);
    // a corrupt index, with the gitfile and commondir intact (a gitfile naming another gitdir is kit_tampered since C22, §13.3 d)
    const wt = r.worktree;
    if (!wt) throw new Error("no worktree");
    writeFileSync(join(wt.gitCommonDir, "worktrees", wt.gitdirName, "index"), "not an index");
    advance(w, 5);
    const s = await runTick(w);
    expect(s.blocked).toEqual([]);
    const after = await rec(w);
    expect(after.stage).toBe("working");
    expect(after.attention).toContain("integrity_unverifiable");
  });
});

describe("owner overrides (§7.4)", () => {
  test("Done while the coordinator is working is a possible self-close: agents stopped once, record kept, never relaunched", async () => {
    const w = await world();
    const r = await claimed(w);
    advance(w, 1);
    w.linear.setState("i1", "Done", OWNER, w.ctx.now());
    advance(w, 4);
    await runTick(w);
    let cur = await rec(w);
    expect(cur.stage).toBe("working");
    expect(cur.attention).toContain("possible_self_close");
    expect(w.orca.closed).toEqual([r.worktree?.id ?? ""]);
    const launches = w.orca.calls.filter((c) => c.verb === "terminalCreate").length;
    for (let n = 0; n < 2; n++) {
      advance(w, 5);
      await runTick(w);
    }
    cur = await rec(w);
    expect(w.orca.calls.filter((c) => c.verb === "terminalCreate").length).toBe(launches);
    expect(w.orca.closed).toHaveLength(1);
  });

  test("In Review → In Progress resumes at implement with every approver comment made during the review", async () => {
    const w = await world();
    const r = await claimed(w);
    await readyToFinish(w, "JRF-501"); // gates at HEAD, validate evidence, a commit and a summary: the real publish accepts it
    await writeIntent(r.worktree?.path ?? "", {
      issue: "JRF-501",
      kind: "finish",
      payload: { summaryFile: ".wingmate/s.md", title: null, draft: false, repos: [] },
    });
    advance(w, 5);
    expect((await runTick(w)).finished).toEqual(["JRF-501"]);
    w.orca.setAgentState(r.worktree?.id ?? "", r.coordinator.paneKey ?? "", "done", w.ctx.now());
    advance(w, 5);
    w.linear.humanComment("i1", "please rename the endpoint", OWNER, w.ctx.now());
    advance(w, 5);
    await runTick(w); // collected while in review
    advance(w, 5);
    w.linear.setState("i1", "In Progress", OWNER, w.ctx.now());
    advance(w, 5);
    const s = await runTick(w);
    expect(s.resumes).toEqual(["JRF-501"]);
    const back = await rec(w);
    expect(back).toMatchObject({ stage: "working", pipelineStage: "implement" });
    expect(back.gates.validate.verdict).toBeNull();
    expect(back.gates.plan.verdict).toBe("PASS");
    expect(w.linear.issues.get("i1")?.labels.map((l) => l.name)).toContain("In-Agent");
    const inbox = join(r.worktree?.path ?? "", ".wingmate", "inbox");
    const notes = readdirSync(inbox)
      .filter((f) => f.startsWith("note-"))
      .map((f) => readFileSync(join(inbox, f), "utf8"));
    expect(notes.some((n) => n.includes("please rename the endpoint"))).toBe(true);
  });

  test("INT-1: review → feedback → re-gate → finish — the agent's gates.json is reset with the record, one PR updated, no intent_failed", async () => {
    const w = await world();
    const r = await claimed(w);
    const wt = r.worktree?.path ?? "";
    await readyToFinish(w, "JRF-501");
    await passLocalGates(wt, "headsha"); // what `gate` wrote into the agent's own gates.json for the first finish
    await writeIntent(wt, {
      issue: "JRF-501",
      kind: "finish",
      payload: { summaryFile: ".wingmate/s.md", title: null, draft: false, repos: [] },
    });
    advance(w, 5);
    expect((await runTick(w)).finished).toEqual(["JRF-501"]);
    w.orca.setAgentState(r.worktree?.id ?? "", r.coordinator.paneKey ?? "", "done", w.ctx.now());
    advance(w, 5);
    w.linear.humanComment("i1", "please rename the endpoint", OWNER, w.ctx.now());
    advance(w, 5);
    w.linear.setState("i1", "In Progress", OWNER, w.ctx.now());
    advance(w, 5);
    expect((await runTick(w)).resumes).toEqual(["JRF-501"]);
    // the mirror: implement…security reset as on the record, fail counts and the earlier stages kept
    const local = (await readLocal(wt)).gates;
    for (const s of ["implement", "validate", "ui", "security"]) expect(local[s]?.verdict ?? null).toBeNull();
    expect(local.planVerify?.verdict).toBe("PASS");
    expect(local.validate?.failCount).toBe(1);
    const inbox = join(wt, ".wingmate", "inbox");
    const feedback = readdirSync(inbox)
      .filter((f) => f.startsWith("note-"))
      .map((f) => readFileSync(join(inbox, f), "utf8"))
      .find((n) => n.includes("please rename the endpoint"));
    expect(feedback).toContain("gate implement");
    // the agent's own order check now agrees with the dispatcher's: validate is refused locally and points at implement
    const refused = await agentVerb(wt, ["gate", "validate"]);
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.out)).toMatchObject({ code: "stage_prerequisite" });
    expect(JSON.parse(refused.out).nextStep).toContain("gate implement");
    // the agent re-gates from implement at its new commit, then validate, ui and security, and finishes again
    w.git.heads.set(wt, "headsha2");
    writeFileSync(join(wt, ".wingmate", "evidence", "impl.md"), "renamed the endpoint");
    expect(
      (
        await agentVerb(wt, [
          "gate",
          "implement",
          "--verdict",
          "PASS",
          "--evidence",
          ".wingmate/evidence/impl.md",
        ])
      ).code,
    ).toBe(0);
    mkdirSync(join(wt, ".wingmate", "evidence", "security"), { recursive: true });
    writeFileSync(join(wt, ".wingmate", "evidence", "security", "report.txt"), "secrets: 0\n");
    const gate = (
      stage: "validate" | "ui" | "security",
      verdict: "PASS" | "NA",
      evidencePath: string | null,
    ) =>
      writeIntent(wt, {
        issue: "JRF-501",
        kind: "gate",
        payload: {
          stage,
          verdict,
          evidencePath,
          note: null,
          method: null,
          headSha: "headsha2",
          dispatchId: null,
        },
      });
    await gate("validate", "PASS", ".wingmate/evidence/validate/report.txt");
    await gate("ui", "NA", null);
    await gate("security", "PASS", ".wingmate/evidence/security/report.txt");
    writeFileSync(join(wt, ".wingmate", "s.md"), "Renamed the endpoint after review.");
    await writeIntent(wt, {
      issue: "JRF-501",
      kind: "finish",
      payload: { summaryFile: ".wingmate/s.md", title: null, draft: false, repos: [] },
    });
    advance(w, 5);
    expect((await runTick(w)).finished).toEqual(["JRF-501"]);
    expect(w.gh.prs).toHaveLength(1); // the same PR, updated by the second push
    expect(w.git.pushed).toHaveLength(2);
    expect(w.linear.comments.filter((c) => c.body.startsWith("<!-- wingmate:completion"))).toHaveLength(1);
    const after = await rec(w);
    expect(after).toMatchObject({ stage: "review" });
    expect(after.gates.implement.verdict).toBe("PASS");
    const events = await w.ctx.ledger.readIssue("JRF-501");
    expect(events.filter((e) => e.type === "intent_failed" || e.type === "publish_refused")).toEqual([]);
  });
});

describe("§6.7 reconcile-only ticks defer resumes without losing them", () => {
  test("an answer seen while paused is delivered on the next normal tick", async () => {
    const w = await world();
    await claimed(w);
    const p = await parked(w);
    advance(w, 5);
    w.linear.humanComment("i1", "b", OWNER, w.ctx.now(), p.questions[0]?.commentId ?? null);
    writeFileSync(join(w.dirs.state, "pause.json"), JSON.stringify(["global"]));
    advance(w, 5);
    const s = await runTick(w);
    expect(s).toMatchObject({ reconcileOnly: true, resumes: [], outcome: "paused" });
    rmSync(join(w.dirs.state, "pause.json"));
    advance(w, 5);
    expect((await runTick(w)).resumes).toEqual(["JRF-501"]);
  });

  test("F3: a project pause makes that project's records reconcile-only — an answer, grace expiry and an exited coordinator wait; overrides still run", async () => {
    const w = await world();
    await claimed(w);
    const p = await parked(w);
    const pause = () => writeFileSync(join(w.dirs.state, "pause.json"), JSON.stringify(["bouncr"]));
    const count = (verb: string) => w.orca.calls.filter((c) => c.verb === verb).length;
    pause();
    advance(w, 5);
    w.linear.humanComment("i1", "b", OWNER, w.ctx.now(), p.questions[0]?.commentId ?? null);
    advance(w, 5);
    const sent = count("terminalSend");
    let s = await runTick(w);
    expect(s).toMatchObject({ reconcileOnly: false, resumes: [] });
    expect(s.outcome).not.toBe("paused");
    expect(count("terminalSend")).toBe(sent);
    expect((await rec(w)).stage).toBe("awaiting-human");
    rmSync(join(w.dirs.state, "pause.json"));
    advance(w, 5);
    expect((await runTick(w)).resumes).toEqual(["JRF-501"]);
    pause();
    const idle = await rec(w);
    idle.timers.nudges = 2;
    idle.timers.graceEndsAt = new Date(Date.parse(w.ctx.now()) - 60_000).toISOString();
    idle.timers.lastActivityAt = new Date(Date.parse(w.ctx.now()) - 120 * 60_000).toISOString();
    await writeRecord(w.dirs, idle);
    advance(w, 5);
    s = await runTick(w);
    expect([...s.handoffs, ...s.blocked, ...s.relaunches]).toEqual([]); // grace expired, but the project is paused
    const cur = await rec(w);
    w.orca.killTerminal(cur.worktree?.id ?? "", cur.coordinator.terminalHandle ?? "");
    const created = count("terminalCreate");
    advance(w, 5);
    s = await runTick(w);
    expect([...s.handoffs, ...s.blocked, ...s.relaunches]).toEqual([]); // exited, but not relaunched while paused
    expect(count("terminalCreate")).toBe(created);
    advance(w, 5);
    w.linear.setLabels("i1", ["agent-ready", "In-Agent", "human"], OWNER, w.ctx.now());
    advance(w, 5);
    expect((await runTick(w)).released).toEqual(["JRF-501"]);
  });
});

describe("scan (plan only)", () => {
  test("plans the claim without any record, Orca write or Linear write; exit 0 would act", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-501"));
    const { exitCode, summary } = await scan(w.ctx);
    expect(exitCode).toBe(0);
    expect(summary.claims).toEqual(["JRF-501"]);
    expect(await listRecords(w.dirs)).toEqual([]);
    expect(w.linear.writes).toEqual([]);
    expect(
      w.orca.calls
        .map((c) => c.verb)
        .filter((v) => !["worktreePs", "accountList", "terminalList", "workerList"].includes(v)),
    ).toEqual([]);
    expect(existsSync(join(w.dirs.state, "queue.dryrun.json"))).toBe(true);
    expect((await readHeartbeat(w.dirs))?.kind).toBe("scan");
  });

  test("exit 1 when nothing would happen", async () => {
    const w = await world();
    expect((await scan(w.ctx)).exitCode).toBe(1);
  });
});

describe("R31: the Claude CLI's own default model", () => {
  test("a claim replay launches with the recorded CLI default (model null, effort max), never re-resolving it: a settings.json broken since the claim does not make it model_unresolved", async () => {
    const w = await world();
    const settings = join(w.root, ".claude", "settings.json");
    writeFileSync(
      settings,
      JSON.stringify({ modelSettings: { "claude-fable-5-1": {} }, effortLevel: "high" }),
    );
    labeledByOwner(w, todo("i1", "JRF-501"));
    w.orca.nextWaitSatisfied = false;
    expect((await runTick(w)).claims).toEqual(["JRF-501"]); // launch_not_ready: replayed next tick
    expect((await rec(w)).coordinator.launch).toEqual({ model: null, effort: "max" });
    writeFileSync(settings, "{ not json");
    w.orca.nextWaitSatisfied = true;
    advance(w, 5);
    const s = await runTick(w);
    expect(s.resumes).toEqual(["JRF-501"]);
    const r = await rec(w);
    expect(r.stage).toBe("working");
    expect(r.attention).not.toContain("model_unresolved");
  });
});
