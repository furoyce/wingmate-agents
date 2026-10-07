// tests/sim/gittrust.test.ts — Ruling R28 (Task 12 phase 0) through whole ticks: the worktree's git links at claim and in the
// per-tick integrity check (C22), the repo setup only in a worktree the claim created (C27), and the allow-deps grant in the kit's
// launch.json (C28); every runTick also asserts I1–I10.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyIntegrity } from "../../src/kit/install";
import { writeIntent } from "../../src/kit/intents";
import { LaunchSchema } from "../../src/kit/local";
import { type WRecord, readRecord } from "../../src/state/records";
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
const gitDirOf = (wt: NonNullable<WRecord["worktree"]>) => join(wt.gitCommonDir, "worktrees", wt.gitdirName);
const idleNow = (w: World, r: WRecord) =>
  w.orca.setAgentState(r.worktree?.id ?? "", r.coordinator.paneKey ?? "", "done", w.ctx.now());
/** The owner moves the issue back to Todo: the record is released and its worktree kept for the next cycle. */
async function released(w: World, r: WRecord): Promise<void> {
  idleNow(w, r);
  advance(w, 5);
  w.linear.setState("i1", "Todo", OWNER, w.ctx.now());
  advance(w, 5);
  expect((await runTick(w)).released).toEqual(["JRF-501"]);
}
/** A common dir an agent could make in $TMPDIR, laid out like a linked worktree's, with a config of its own. */
function forged(name: string): string {
  const fake = realpathSync(mkdtempSync(join(tmpdir(), "wm-forged-")));
  mkdirSync(join(fake, "worktrees", name), { recursive: true });
  writeFileSync(join(fake, "config"), '[core]\n\tsshCommand = "touch /tmp/wm-pwned"\n');
  writeFileSync(join(fake, "worktrees", name, "commondir"), "../..\n");
  writeFileSync(join(fake, "worktrees", name, "HEAD"), "ref: refs/heads/furoyce/wm-jrf-501\n");
  return fake;
}
const labels = (w: World) => w.linear.issues.get("i1")?.labels.map((l) => l.name) ?? [];
const terminalCreates = (w: World) => w.orca.calls.filter((c) => c.verb === "terminalCreate").length;
const ledgerOf = async (w: World, type: string) =>
  (await w.ctx.ledger.readIssue("JRF-501")).filter((e) => e.type === type);
const launchOf = (r: WRecord) =>
  LaunchSchema.parse(JSON.parse(readFileSync(join(wtOf(r).path, ".wingmate", "launch.json"), "utf8")));

describe("C22: the worktree's git links (§13.3 d)", () => {
  test("a re-claim of a worktree whose commondir an earlier agent redirected blocks kit_tampered: nothing is recorded from it and no coordinator starts", async () => {
    const w = await world();
    const r = await claimed(w);
    const wt = wtOf(r);
    await released(w, r);
    writeFileSync(join(gitDirOf(wt), "commondir"), `${forged(wt.gitdirName)}\n`);
    advance(w, 5);
    expect((await runTick(w)).claims).toEqual(["JRF-501"]);
    const again = await rec(w);
    expect(again).toMatchObject({ cycle: 2, stage: "blocked", worktree: null });
    expect(again.history.at(-1)?.cause).toBe("kit_tampered");
    expect(terminalCreates(w)).toBe(1); // cycle 1's only
    expect(labels(w)).toContain("Blocked");
  });

  test("a re-claim of a worktree whose gitfile names a forged git dir laid out like a linked worktree blocks too: the archived record is the anchor", async () => {
    const w = await world();
    const r = await claimed(w);
    const wt = wtOf(r);
    await released(w, r);
    writeFileSync(
      join(wt.path, ".git"),
      `gitdir: ${join(forged(wt.gitdirName), "worktrees", wt.gitdirName)}\n`,
    );
    advance(w, 5);
    expect((await runTick(w)).claims).toEqual(["JRF-501"]);
    const again = await rec(w);
    expect(again).toMatchObject({ cycle: 2, stage: "blocked", worktree: null });
    expect(again.history.at(-1)?.cause).toBe("kit_tampered");
    expect(terminalCreates(w)).toBe(1);
  });

  test("the per-tick integrity check reports a redirected commondir as a kit change (.git): blocked kit_tampered", async () => {
    const w = await world();
    const wt = wtOf(await claimed(w));
    writeFileSync(join(gitDirOf(wt), "commondir"), `${forged(wt.gitdirName)}\n`);
    advance(w, 5);
    expect((await runTick(w)).blocked).toEqual(["JRF-501"]);
    expect((await rec(w)).history.at(-1)).toMatchObject({
      to: "blocked",
      cause: "kit_tampered",
      evidence: ".git",
    });
  });
});

describe("C27: the repo setup runs only in a worktree this claim created (§5.4 step 4, amended)", () => {
  test("a fresh claim runs it once; a re-claim that reuses the worktree never runs it again (the setup runs outside the sandbox)", async () => {
    const w = await world();
    const runs = join(w.root, "setup-runs.txt");
    const api = w.cfg.projects.bouncr?.repos.api;
    if (!api) throw new Error("api repo missing");
    api.setup = ["sh", "-c", `echo ran >> ${runs}`];
    const r = await claimed(w);
    expect(readFileSync(runs, "utf8")).toBe("ran\n");
    await released(w, r);
    advance(w, 5);
    expect((await runTick(w)).claims).toEqual(["JRF-501"]);
    const again = await rec(w);
    expect(again).toMatchObject({ cycle: 2, stage: "working" });
    expect(again.worktree?.id).toBe(wtOf(r).id);
    expect(readFileSync(runs, "utf8")).toBe("ran\n");
    expect(await ledgerOf(w, "setup")).toHaveLength(1);
    expect((await ledgerOf(w, "setup_skipped")).map((e) => e.data.reason)).toEqual(["reused"]);
  });

  test("a reroute never runs the other repo's setup", async () => {
    const w = await world();
    const runs = join(w.root, "setup-runs.txt");
    const web = w.cfg.projects.bouncr?.repos.web;
    if (!web) throw new Error("web repo missing");
    web.setup = ["sh", "-c", `echo ran >> ${runs}`];
    const r = await claimed(w);
    await writeIntent(wtOf(r).path, {
      issue: "JRF-501",
      kind: "handoff",
      payload: { reason: "wrong repo", repo: "web" },
    });
    advance(w, 5);
    expect((await runTick(w)).resumes).toEqual(["JRF-501"]);
    expect(await rec(w)).toMatchObject({ repo: "web", stage: "working" });
    expect(() => readFileSync(runs, "utf8")).toThrow();
    expect((await ledgerOf(w, "setup_skipped")).map((e) => e.data.reason)).toEqual(["reroute"]);
  });
});

describe("C28: launch.json allowDeps follows the allow-deps grant (§13.3 e)", () => {
  const ALLOW_DEPS = { id: "lb-allow-deps", name: "allow-deps", parentId: null, parentName: null };
  const AGENT_READY = {
    id: "lb-agent-ready",
    name: "agent-ready",
    parentId: "grp-agent",
    parentName: "Agent",
  };

  test("an approver's grant before the claim is in launch.json from the start", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-501", { labels: [AGENT_READY, ALLOW_DEPS] }));
    expect((await runTick(w)).claims).toEqual(["JRF-501"]);
    expect(launchOf(await rec(w)).allowDeps).toBe(true);
  });

  test("a grant made while parked reaches launch.json before the answer resumes the agent, with the pinned hashes following (no kit_tampered); withdrawn, it turns off", async () => {
    const w = await world();
    const r = await claimed(w);
    expect(launchOf(r).allowDeps).toBe(false);
    idleNow(w, r);
    const wt = wtOf(r);
    writeFileSync(join(wt.path, ".wingmate", "q.md"), "May I add the zod dependency?");
    await writeIntent(wt.path, {
      issue: "JRF-501",
      kind: "ask",
      payload: {
        questionFile: ".wingmate/q.md",
        options: ["yes", "no"],
        recommend: 1,
        append: null,
        reask: null,
      },
    });
    advance(w, 5);
    expect((await runTick(w)).parked).toEqual(["JRF-501"]);
    const parked = await rec(w);
    advance(w, 5);
    w.linear.setLabels("i1", [...labels(w), "allow-deps"], OWNER, w.ctx.now());
    w.linear.humanComment("i1", "1", OWNER, w.ctx.now(), parked.questions[0]?.commentId ?? null);
    advance(w, 5);
    expect((await runTick(w)).resumes).toEqual(["JRF-501"]);
    expect(launchOf(await rec(w)).allowDeps).toBe(true);
    const rehashed = await ledgerOf(w, "kit_rehashed");
    expect(rehashed.map((e) => e.data.allowDeps)).toEqual([true]);
    // spawn's own copy of the hashes follows too, so it does not refuse kit_tampered
    const local = JSON.parse(readFileSync(join(wt.path, ".wingmate", "integrity.json"), "utf8"));
    expect(await verifyIntegrity(wt.path, local.commonDir, local.hashes)).toEqual([]);
    advance(w, 5);
    await runTick(w);
    expect((await rec(w)).stage).toBe("working");
    w.linear.setLabels(
      "i1",
      labels(w).filter((l) => l !== "allow-deps"),
      OWNER,
      w.ctx.now(),
    );
    advance(w, 5);
    await runTick(w);
    expect(launchOf(await rec(w)).allowDeps).toBe(false);
    advance(w, 5);
    await runTick(w);
    expect((await rec(w)).stage).toBe("working");
    expect((await ledgerOf(w, "kit_rehashed")).map((e) => e.data.allowDeps)).toEqual([true, false]);
  });

  test("an agent that sets allowDeps itself is blocked kit_tampered: the tick never rewrites a kit that no longer hashes as pinned", async () => {
    const w = await world();
    const r = await claimed(w);
    const file = join(wtOf(r).path, ".wingmate", "launch.json");
    writeFileSync(file, readFileSync(file, "utf8").replace('"allowDeps": false', '"allowDeps": true'));
    advance(w, 5);
    expect((await runTick(w)).blocked).toEqual(["JRF-501"]);
    expect((await rec(w)).history.at(-1)?.cause).toBe("kit_tampered");
    expect(await ledgerOf(w, "kit_rehashed")).toEqual([]);
  });
});
