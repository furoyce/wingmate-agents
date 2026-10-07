// tests/unit/machine/claim.test.ts — §5.4 claim and its replay, relaunch, delivery, release and block against the fakes (real files)
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { LaunchSchema } from "../../../src/kit/local";
import { claimIssue, provisionAndLaunch } from "../../../src/machine/claim";
import { refreshRepoSiblings } from "../../../src/machine/launch";
import { block, release } from "../../../src/machine/release";
import { deliver, relaunch } from "../../../src/machine/resume";
import type { LinearIssue } from "../../../src/ports";
import { WingmateError } from "../../../src/shared/errors";
import { type WRecord, readRecord } from "../../../src/state/records";
import { OWNER, addLabeledByOwner, todo } from "../../fakes/issues";
import { type World, makeWorld } from "../../fakes/world";

const ROUTING = { basis: "default" as const, candidates: [], rerouteFrom: null };
async function issueOf(w: World, id: string): Promise<LinearIssue> {
  const [i] = await w.linear.getIssues([id]);
  if (!i) throw new Error(`issue ${id} missing`);
  return i;
}
function bouncr(w: World) {
  const p = w.cfg.projects.bouncr;
  if (!p) throw new Error("bouncr missing");
  return p;
}
async function claim(w: World, id = "i1", identifier = "JRF-501"): Promise<WRecord> {
  addLabeledByOwner(w.linear, todo(id, identifier));
  return claimIssue(w.ctx, {
    issue: await issueOf(w, id),
    project: bouncr(w),
    provider: "claude",
    repoName: "api",
    routing: ROUTING,
  });
}
const verbs = (w: World) => w.orca.calls.map((c) => c.verb);
const commands = (w: World) =>
  w.orca.calls.filter((c) => c.verb === "terminalCreate").map((c) => (c.args as { command: string }).command);
type Settings = { sandbox: { filesystem: { denyWrite: string[] } } };
const settingsOf = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Settings;

describe("claimIssue (§5.4)", () => {
  test("Linear, one worktree, the kit with review tiers, the coordinator under the kit argv and env, then the pointer brief", async () => {
    const w = await makeWorld();
    const r = await claim(w);
    expect(r.stage).toBe("working");
    expect(r.attempts).toHaveLength(1);
    const live = w.linear.issues.get("i1");
    expect(live?.state.name).toBe("In Progress");
    expect(live?.labels.map((l) => l.name).sort()).toEqual(["In-Agent", "agent-ready"]);
    expect(live?.subscriberIds).toContain(OWNER);
    expect(w.linear.comments.filter((c) => c.body.startsWith("<!-- wingmate:status -->"))).toHaveLength(1);
    const wt = r.worktree;
    if (!wt) throw new Error("no worktree");
    expect(existsSync(join(wt.path, ".wingmate", "BRIEF.md"))).toBe(true);
    expect(wt.gitdirName).toBe(basename(await w.git.gitDir(wt.path)));
    expect(wt.gitCommonDir).toBe(join(w.root, "orca", "repos", bouncr(w).repos.api?.orcaRepo ?? "", ".git"));
    expect(statSync(join(wt.gitCommonDir, "refs", "heads", "furoyce")).isDirectory()).toBe(true);
    const launch = LaunchSchema.parse(
      JSON.parse(readFileSync(join(wt.path, ".wingmate", "launch.json"), "utf8")),
    );
    expect(launch.tiers).toEqual({
      claude: { model: "claude-fable-5-1[1m]", effort: "max" },
      codex: { model: "gpt-6.1-sol", effort: "xhigh" },
    });
    const kit = (await w.ctx.ledger.readIssue("JRF-501")).find((e) => e.type === "kit_installed");
    expect(kit?.data.courtesySettings).toBe("written");
    const kitDir = w.ctx.kitDirFor("JRF-501");
    const [cmd] = commands(w);
    expect(cmd).toContain(`--settings ${join(kitDir, "claude-settings.json")}`);
    expect(cmd).toContain("WINGMATE_ROLE=coordinator");
    expect(cmd).toContain(`--session-id ${r.coordinator.sessionId}`);
    const send = w.orca.calls.find((c) => c.verb === "terminalSend")?.args as { text: string };
    expect(send.text).toContain(`Nonce: ${String(kit?.data.nonce)}`);
    const v = verbs(w);
    const order = ["worktreeCreate", "terminalCreate", "terminalWait", "terminalSend", "worktreeSet"].map(
      (x) => v.indexOf(x),
    );
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const [entry] = (await w.ctx.journal.all()).filter((e) => e.kind === "claim");
    expect(entry?.state).toBe("confirmed");
    expect(entry?.steps.every((s) => s.state === "done")).toBe(true);
  });

  test("R22/R24: after a second claim in the repo, the first record's kit settings deny the new sibling's gitdir and branch", async () => {
    const w = await makeWorld();
    const a = await claim(w, "i1", "JRF-501");
    const b = await claim(w, "i2", "JRF-502");
    const common = a.worktree?.gitCommonDir ?? "";
    expect(b.worktree?.gitCommonDir).toBe(common);
    const fileA = join(w.ctx.kitDirFor("JRF-501"), "claude-settings.json");
    expect(settingsOf(fileA).sandbox.filesystem.denyWrite).not.toContain(`${common}/worktrees/wm-jrf-502`);
    await refreshRepoSiblings(w.ctx, [a, b], common, "JRF-502");
    for (const f of ["claude-settings.json", "claude-settings.worker.json"]) {
      const deny = settingsOf(join(w.ctx.kitDirFor("JRF-501"), f)).sandbox.filesystem.denyWrite;
      expect(deny).toContain(`${common}/worktrees/wm-jrf-502`);
      expect(deny).toContain(`${common}/refs/heads/furoyce/wm-jrf-502`);
    }
    const denyB = settingsOf(join(w.ctx.kitDirFor("JRF-502"), "claude-settings.json")).sandbox.filesystem
      .denyWrite;
    expect(denyB).toContain(`${common}/worktrees/wm-jrf-501`);
  });

  test("launch_not_ready: claimed with the failure journaled; the replay waits on the same handle — no second worktree, terminal or status comment", async () => {
    const w = await makeWorld();
    w.orca.nextWaitSatisfied = false;
    const r = await claim(w);
    expect(r.stage).toBe("claimed");
    expect(r.attention).toContain("launch_not_ready");
    const [entry] = (await w.ctx.journal.all()).filter((e) => e.kind === "claim");
    expect(entry).toMatchObject({ state: "intent", attempts: 1 });
    w.orca.nextWaitSatisfied = true;
    const again = await readRecord(w.dirs, "JRF-501");
    if (!again || !entry) throw new Error("record or entry missing");
    await provisionAndLaunch(w.ctx, again, await issueOf(w, "i1"), bouncr(w), entry.id, {
      model: "claude-fable-5-1[1m]",
      effort: "max",
    });
    expect(again.stage).toBe("working");
    expect(again.attention).not.toContain("launch_not_ready");
    expect(verbs(w).filter((x) => x === "worktreeCreate")).toHaveLength(1);
    expect(verbs(w).filter((x) => x === "terminalCreate")).toHaveLength(1);
    expect(w.linear.comments.filter((c) => c.body.startsWith("<!-- wingmate:status -->"))).toHaveLength(1);
  });

  test("a crash right after worktree create: the replay adopts the worktree linked to the issue instead of creating another", async () => {
    const w = await makeWorld();
    w.orca.failNext = "worktreeShow";
    await expect(claim(w)).rejects.toThrow(/fake orca failure/);
    const r = await readRecord(w.dirs, "JRF-501");
    const [entry] = (await w.ctx.journal.all()).filter((e) => e.kind === "claim");
    if (!r || !entry) throw new Error("record or entry missing");
    expect(r.worktree).toBeNull();
    expect(r.attention).toContain("claim_step_failed");
    expect(entry.attempts).toBe(1);
    await provisionAndLaunch(w.ctx, r, await issueOf(w, "i1"), bouncr(w), entry.id, {
      model: "claude-fable-5-1[1m]",
      effort: "max",
    });
    expect(r.stage).toBe("working");
    expect(verbs(w).filter((x) => x === "worktreeCreate")).toHaveLength(1);
  });

  test("a failing setup command blocks (setup_failed): Blocked, one blocked comment naming only the exit code, no terminal", async () => {
    const w = await makeWorld();
    const repo = bouncr(w).repos.api;
    if (!repo) throw new Error("api repo missing");
    repo.setup = ["sh", "-c", "echo do-not-post-this >&2; exit 3"];
    const r = await claim(w);
    expect(r.stage).toBe("blocked");
    expect(r.history.at(-1)?.cause).toBe("setup_failed");
    expect(w.linear.issues.get("i1")?.labels.map((l) => l.name)).toContain("Blocked");
    const blocked = w.linear.comments.filter((c) => c.body.startsWith("<!-- wingmate:blocked -->"));
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.body).toContain("exited 3");
    expect(blocked[0]?.body).not.toContain("do-not-post-this");
    expect(verbs(w)).not.toContain("terminalCreate");
    expect((await w.ctx.journal.all()).find((e) => e.kind === "claim")?.state).toBe("abandoned");
  });

  test("R6: the folder-trust dialog is answered with Down then Enter, and the brief is sent only after that", async () => {
    const w = await makeWorld();
    w.orca.nextWaitSatisfied = false;
    w.orca.nextBlockedReason = "agent-trust-workspace";
    const r = await claim(w);
    expect(r.stage).toBe("working");
    const keys = w.orca.calls
      .filter((c) => c.verb === "terminalKeys")
      .map((c) => (c.args as { k: unknown }).k);
    expect(keys).toEqual([{ text: "\x1b[B" }, { enter: true }]);
    expect(verbs(w).indexOf("terminalSend")).toBeGreaterThan(verbs(w).lastIndexOf("terminalKeys"));
    expect((await w.ctx.ledger.readIssue("JRF-501")).some((e) => e.type === "trust_dialog_answered")).toBe(
      true,
    );
  });

  test("model_unresolved: without the provider's configured model there is no claim at all", async () => {
    const w = await makeWorld();
    rmSync(join(w.root, ".claude", "settings.json"));
    const err = await claim(w).catch((e: unknown) => e);
    expect(err instanceof WingmateError && err.code).toBe("model_unresolved");
    expect(await readRecord(w.dirs, "JRF-501")).toBeNull();
  });
});

describe("relaunch", () => {
  test("after the attempt's first turn a successor resumes the Claude session (--resume) in the same worktree", async () => {
    const w = await makeWorld();
    const r = await claim(w);
    const before = r.coordinator.terminalHandle;
    expect(await relaunch(w.ctx, r, "exited")).toBe(true);
    expect(r.coordinator.relaunches).toBe(1);
    expect(r.coordinator.terminalHandle).not.toBe(before);
    const cmd = commands(w)[1] ?? "";
    expect(cmd).toContain(`--resume ${r.coordinator.sessionId}`);
    expect(cmd).not.toContain("--session-id");
  });

  test("before any turn of the attempt (a handoff's new attempt) the successor starts a fresh session; uncounted keeps relaunches", async () => {
    const w = await makeWorld();
    const r = await claim(w);
    const old = r.coordinator.sessionId;
    r.attempts = [];
    r.stage = "claimed";
    expect(await relaunch(w.ctx, r, "handoff:test", { counted: false })).toBe(true);
    expect(r.coordinator.relaunches).toBe(0);
    expect(r.coordinator.sessionId).not.toBe(old);
    expect(commands(w)[1]).toContain(`--session-id ${r.coordinator.sessionId}`);
    expect((await readRecord(w.dirs, "JRF-501"))?.stage).toBe("working");
    expect(r.attempts).toHaveLength(1);
  });

  test("a worktree gone from disk: no terminal is created, the relaunch still counts, attention worktree_gone", async () => {
    const w = await makeWorld();
    const r = await claim(w);
    rmSync(r.worktree?.path ?? "", { recursive: true, force: true });
    expect(await relaunch(w.ctx, r, "exited")).toBe(false);
    expect(r.coordinator.relaunches).toBe(1);
    expect(r.attention).toContain("worktree_gone");
    expect(commands(w)).toHaveLength(1);
  });

  test("an Orca failure is absorbed into relaunch_failed and the counter still advances (the next exited hands off)", async () => {
    const w = await makeWorld();
    const r = await claim(w);
    w.orca.failNext = "terminalCreate";
    expect(await relaunch(w.ctx, r, "exited")).toBe(false);
    expect(r.coordinator.relaunches).toBe(1);
    expect(r.attention).toContain("relaunch_failed");
    expect((await readRecord(w.dirs, "JRF-501"))?.coordinator.relaunches).toBe(1);
  });
});

describe("deliver (§7.1 step 4, §7.2)", () => {
  test("persist first: the answer is in the inbox fenced with the brief's nonce and stage.json names the stage; then one pointer", async () => {
    const w = await makeWorld();
    const r = await claim(w);
    const sends = () => w.orca.calls.filter((c) => c.verb === "terminalSend").length;
    const n = sends();
    expect(await deliver(w.ctx, r, "answer", "use milliseconds", "idle", "plan")).toBe("turn_started");
    expect(sends()).toBe(n + 1);
    const inbox = join(r.worktree?.path ?? "", ".wingmate", "inbox");
    const file = readdirSync(inbox).find((f) => f.startsWith("answer-")) ?? "";
    const text = readFileSync(join(inbox, file), "utf8");
    const nonce = (await w.ctx.ledger.readIssue("JRF-501")).find((e) => e.type === "kit_installed")?.data
      .nonce;
    expect(text).toContain(`<untrusted nonce="${String(nonce)}">`);
    expect(text).toContain("use milliseconds");
    const stage = JSON.parse(readFileSync(join(r.worktree?.path ?? "", ".wingmate", "stage.json"), "utf8"));
    expect(stage.pipelineStage).toBe("plan");
  });

  test("a working coordinator with a child Run gets notes through the Run mailbox; an answer never goes there", async () => {
    const w = await makeWorld();
    const r = await claim(w);
    r.coordinator.childRunId = "run_1";
    expect(await deliver(w.ctx, r, "note", "fyi", "working", "plan")).toBe("input_accepted");
    expect(w.orca.calls.at(-1)?.verb).toBe("orchestrationSend");
    await deliver(w.ctx, r, "answer", "1", "working", "plan");
    expect(w.orca.calls.filter((c) => c.verb === "orchestrationSend")).toHaveLength(1);
  });

  test("exited: the text is persisted and nothing is sent", async () => {
    const w = await makeWorld();
    const r = await claim(w);
    const n = w.orca.calls.length;
    expect(await deliver(w.ctx, r, "note", "later", "exited", "plan")).toBe("exited");
    expect(w.orca.calls.length).toBe(n);
  });

  test("C11: a worktree gone from disk is never re-created — nothing written or sent; exited with attention worktree_gone", async () => {
    const w = await makeWorld();
    const r = await claim(w);
    const path = r.worktree?.path ?? "";
    rmSync(path, { recursive: true, force: true });
    const n = w.orca.calls.length;
    expect(await deliver(w.ctx, r, "note", "later", "idle", "plan")).toBe("exited");
    expect(existsSync(path)).toBe(false);
    expect(r.attention).toContain("worktree_gone");
    expect(w.orca.calls.length).toBe(n);
  });

  test("C11: a symlinked .wingmate/inbox or .wingmate is never written through; nothing is sent (attention inbox_unsafe)", async () => {
    for (const planted of [".wingmate/inbox", ".wingmate"]) {
      const w = await makeWorld();
      const r = await claim(w);
      const outside = mkdtempSync(join(tmpdir(), "wm-outside-"));
      const link = join(r.worktree?.path ?? "", planted);
      rmSync(link, { recursive: true, force: true });
      symlinkSync(outside, link);
      const n = w.orca.calls.length;
      const d = await deliver(w.ctx, r, "note", "fyi", "idle", "plan");
      expect({ planted, outside: readdirSync(outside) }).toEqual({ planted, outside: [] });
      expect(d).toBe("input_accepted");
      expect(w.orca.calls.length).toBe(n); // no pointer to a file that was never written
      expect(r.attention).toContain("inbox_unsafe");
    }
  });

  test("C11: a stage.json planted as a symlink is replaced in the worktree, never followed", async () => {
    const w = await makeWorld();
    const r = await claim(w);
    const outside = join(mkdtempSync(join(tmpdir(), "wm-outside-")), "target.txt");
    writeFileSync(outside, "keep");
    const stage = join(r.worktree?.path ?? "", ".wingmate", "stage.json");
    rmSync(stage, { force: true });
    symlinkSync(outside, stage);
    expect(await deliver(w.ctx, r, "note", "fyi", "idle", "plan")).toBe("turn_started");
    expect(readFileSync(outside, "utf8")).toBe("keep");
    expect(lstatSync(stage).isFile()).toBe(true);
    expect(JSON.parse(readFileSync(stage, "utf8")).pipelineStage).toBe("plan");
  });
});

describe("release and block", () => {
  test("release stops live workers (abandoning an unproven stop), closes terminals, sweeps, and restores Ready", async () => {
    const w = await makeWorld();
    addLabeledByOwner(
      w.linear,
      todo("i1", "JRF-501", {
        labels: [
          { id: "lb-agent-ready", name: "agent-ready", parentId: "grp-agent", parentName: "Agent" },
          { id: "lb-Ready", name: "Ready", parentId: "grp-life", parentName: "Lifecycle" },
        ],
      }),
    );
    const r = await claimIssue(w.ctx, {
      issue: await issueOf(w, "i1"),
      project: bouncr(w),
      provider: "claude",
      repoName: "api",
      routing: ROUTING,
    });
    expect(r.linear.lifecycleLabelAtClaim).toBe("Ready");
    r.coordinator.childRunId = "run_1";
    const worker = (d: string) => ({
      dispatchId: d,
      taskId: "t",
      runId: "run_1",
      workerState: "running",
      dispatchStatus: "active",
      agentTerminalHandle: null,
      verdict: "live" as const,
    });
    w.orca.workers.set("run_1", [worker("ctx_1"), worker("ctx_2")]);
    const stop = w.orca.workerStop.bind(w.orca);
    w.orca.workerStop = async (d, retry) => (d === "ctx_2" ? { verdict: "unverifiable" } : stop(d, retry));
    expect(await release(w.ctx, r, await issueOf(w, "i1"), "override", "released by test")).toBe(true);
    expect(r.stage).toBe("released");
    expect(w.orca.calls.filter((c) => c.verb === "workerAbandon").map((c) => c.args)).toEqual(["ctx_2"]);
    expect(r.attention).toContain("release_unverifiable(ctx_2)");
    expect(w.orca.closed).toContain(r.worktree?.id ?? "");
    expect(w.swept).toContain(r.worktree?.path ?? "");
    expect(
      w.linear.issues
        .get("i1")
        ?.labels.map((l) => l.name)
        .sort(),
    ).toEqual(["Ready", "agent-ready"]);
    expect(r.attempts.at(-1)?.outcome).toBe("released");
  });

  test("a failed bulk terminal close keeps the record as it is; the release is retried later", async () => {
    const w = await makeWorld();
    const r = await claim(w);
    w.orca.terminalClose = async () => ({ ok: false });
    expect(await release(w.ctx, r, await issueOf(w, "i1"), "override", null)).toBe(false);
    expect(r.stage).toBe("working");
    expect(r.attention).toContain("release_unverifiable(terminals)");
  });

  test("block: stopped, blocked, the Blocked label and exactly one blocked comment", async () => {
    const w = await makeWorld();
    const r = await claim(w);
    await block(w.ctx, r, await issueOf(w, "i1"), "kit_tampered", ".claude/settings.local.json", "inspect");
    expect(r.stage).toBe("blocked");
    expect(
      w.linear.issues
        .get("i1")
        ?.labels.map((l) => l.name)
        .sort(),
    ).toEqual(["Blocked", "agent-ready"]);
    expect(w.linear.comments.filter((c) => c.body.startsWith("<!-- wingmate:blocked -->"))).toHaveLength(1);
    expect(w.orca.closed).toContain(r.worktree?.id ?? "");
  });
});
