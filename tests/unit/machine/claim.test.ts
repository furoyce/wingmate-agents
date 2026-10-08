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
import { claimIssue, provisionAndLaunch, setupCommandBudget } from "../../../src/machine/claim";
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
    expect((await w.ctx.ledger.readIssue("JRF-501")).some((e) => e.type.startsWith("setup"))).toBe(false);
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

  test("a failing setup sequence short circuits (setup_failed): prior commands run, later commands and the terminal do not", async () => {
    const w = await makeWorld();
    const repo = bouncr(w).repos.api;
    if (!repo) throw new Error("api repo missing");
    repo.setup = [
      ["sh", "-c", "touch .setup-first"],
      ["sh", "-c", "echo do-not-post-this >&2; exit 3"],
      ["sh", "-c", "touch .setup-last"],
    ];
    const r = await claim(w);
    expect(r.stage).toBe("blocked");
    expect(r.history.at(-1)?.cause).toBe("setup_failed");
    expect(w.linear.issues.get("i1")?.labels.map((l) => l.name)).toContain("Blocked");
    const blocked = w.linear.comments.filter((c) => c.body.startsWith("<!-- wingmate:blocked -->"));
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.body).toContain("exited 3");
    expect(blocked[0]?.body).toContain("command 2/3");
    expect(blocked[0]?.body).not.toContain("do-not-post-this");
    expect(existsSync(join(r.worktree?.path ?? "", ".setup-first"))).toBe(true);
    expect(existsSync(join(r.worktree?.path ?? "", ".setup-last"))).toBe(false);
    const setup = (await w.ctx.ledger.readIssue("JRF-501")).filter((e) => e.type === "setup");
    expect(setup.map((e) => [e.data.command, e.data.code])).toEqual([
      [1, 0],
      [2, 3],
    ]);
    expect(verbs(w)).not.toContain("terminalCreate");
    expect((await w.ctx.journal.all()).find((e) => e.kind === "claim")?.state).toBe("abandoned");
  });

  test("REL-2: the setup's timeout ends 30 s before the tick's deadline; cut off there it is retried by the replay, never blocked setup_failed", async () => {
    const w = await makeWorld();
    const repo = bouncr(w).repos.api;
    if (!repo) throw new Error("api repo missing");
    repo.setup = [
      ["sh", "-c", "sleep 1"],
      ["sh", "-c", "sleep 20"],
      ["sh", "-c", "touch .setup-last"],
    ];
    addLabeledByOwner(w.linear, todo("i1", "JRF-501"));
    const at = Date.now() + 38_500; // 8.5 s total for both commands before the terminal's reserve
    const ctx = { ...w.ctx, deadline: { at, now: Date.now } };
    const started = Date.now();
    const r = await claimIssue(ctx, {
      issue: await issueOf(w, "i1"),
      project: bouncr(w),
      provider: "claude",
      repoName: "api",
      routing: ROUTING,
    });
    expect(Date.now() - started).toBeLessThan(15_000); // run() killed the setup's process group at its budget
    expect(r.stage).toBe("claimed");
    expect(r.attention).toContain("setup_timed_out");
    expect(verbs(w)).not.toContain("terminalCreate");
    const setup = (await w.ctx.ledger.readIssue("JRF-501")).filter((e) => e.type === "setup");
    expect(setup.map((e) => e.data.timedOut)).toEqual([false, true]);
    expect(Number(setup[1]?.data.timeoutMs)).toBeLessThan(Number(setup[0]?.data.timeoutMs) - 900);
    expect(existsSync(join(r.worktree?.path ?? "", ".setup-last"))).toBe(false);
    const [entry] = (await w.ctx.journal.all()).filter((e) => e.kind === "claim");
    expect(entry).toMatchObject({ state: "intent", attempts: 1 });
    repo.setup = [["sh", "-c", "exit 0"]];
    if (!entry) throw new Error("entry missing");
    await provisionAndLaunch(w.ctx, r, await issueOf(w, "i1"), bouncr(w), entry.id, {
      model: "claude-fable-5-1[1m]",
      effort: "max",
    });
    expect(r.stage).toBe("working");
    expect(r.attention).not.toContain("setup_timed_out");
    const ran = (await w.ctx.ledger.readIssue("JRF-501")).filter((e) => e.type === "setup");
    expect(ran.map((e) => e.data.timedOut)).toEqual([false, true, false]); // the replay ran setup again: a worktree this claim created
  }, 30_000);

  test("setup sequence runs argv literally and in order before launching the coordinator", async () => {
    const w = await makeWorld();
    const repo = bouncr(w).repos.api;
    if (!repo) throw new Error("api repo missing");
    const literal = "first; $(touch .setup-injected)";
    repo.setup = [
      [process.execPath, "-e", 'require("node:fs").writeFileSync(".setup-order", process.argv[1])', literal],
      [
        process.execPath,
        "-e",
        'const f = require("node:fs"); if (f.readFileSync(".setup-order", "utf8") !== process.argv[1]) process.exit(3); f.appendFileSync(".setup-order", "\\nsecond");',
        literal,
      ],
    ];
    const r = await claim(w);
    expect(r.stage).toBe("working");
    expect(readFileSync(join(r.worktree?.path ?? "", ".setup-order"), "utf8")).toBe(`${literal}\nsecond`);
    expect(existsSync(join(r.worktree?.path ?? "", ".setup-injected"))).toBe(false);
    const setup = (await w.ctx.ledger.readIssue("JRF-501")).filter((e) => e.type === "setup");
    expect(setup.map((e) => [e.data.command, e.data.commands, e.data.code])).toEqual([
      [1, 2, 0],
      [2, 2, 0],
    ]);
    expect(verbs(w)).toContain("terminalCreate");
  });

  test("setup commands share one 10-minute cap, distinguish tick cutoff, and reserve terminal time", async () => {
    const w = await makeWorld();
    const startedAt = 1000;
    let now = startedAt;
    expect(setupCommandBudget(w.ctx, startedAt, () => now)).toEqual({
      timeoutMs: 600_000,
      tickLimited: false,
    });
    now += 590_000;
    expect(setupCommandBudget(w.ctx, startedAt, () => now)).toEqual({
      timeoutMs: 10_000,
      tickLimited: false,
    });
    now += 6000;
    expect(setupCommandBudget(w.ctx, startedAt, () => now)).toEqual({ timeoutMs: null, tickLimited: false });
    now = startedAt;
    const ctx = { ...w.ctx, deadline: { at: now + 40_000, now: () => now } };
    expect(setupCommandBudget(ctx, startedAt, () => now)).toEqual({ timeoutMs: 10_000, tickLimited: true });
    now += 6000;
    expect(setupCommandBudget(ctx, startedAt, () => now)).toEqual({ timeoutMs: null, tickLimited: true });
  });

  test("REL-2: a crash between worktree create and its journal step — the replay knows this claim created it: the start check reads its HEAD and the setup runs", async () => {
    const w = await makeWorld();
    const repo = bouncr(w).repos.api;
    if (!repo) throw new Error("api repo missing");
    repo.setup = [["sh", "-c", "touch .setup-ran"]];
    w.orca.failNext = "worktreeShow";
    await expect(claim(w)).rejects.toThrow(/fake orca failure/);
    const r = await readRecord(w.dirs, "JRF-501");
    const [entry] = (await w.ctx.journal.all()).filter((e) => e.kind === "claim");
    if (!r || !entry) throw new Error("record or entry missing");
    await provisionAndLaunch(w.ctx, r, await issueOf(w, "i1"), bouncr(w), entry.id, {
      model: "claude-fable-5-1[1m]",
      effort: "max",
    });
    expect(r.stage).toBe("working");
    expect(existsSync(join(r.worktree?.path ?? "", ".setup-ran"))).toBe(true);
    const types = (await w.ctx.ledger.readIssue("JRF-501")).map((e) => e.type);
    expect(types).toContain("setup");
    expect(types).not.toContain("setup_skipped");
    const done = (await w.ctx.journal.get(entry.id)).steps.find((s) => s.name === "worktree");
    expect(done).toMatchObject({ state: "done", receipt: { reused: false } });
  });

  test("REL-2: …and a created worktree that did not start at the verified commit is refused on that replay too (kit_tampered), never adopted as reused", async () => {
    const w = await makeWorld();
    w.orca.startCommit = "planted0000"; // a ref an agent planted stood in for the base when Orca checked it out
    w.orca.failNext = "worktreeShow";
    await expect(claim(w)).rejects.toThrow(/fake orca failure/);
    const r = await readRecord(w.dirs, "JRF-501");
    const [entry] = (await w.ctx.journal.all()).filter((e) => e.kind === "claim");
    if (!r || !entry) throw new Error("record or entry missing");
    await provisionAndLaunch(w.ctx, r, await issueOf(w, "i1"), bouncr(w), entry.id, {
      model: "claude-fable-5-1[1m]",
      effort: "max",
    });
    expect(r.stage).toBe("blocked");
    expect(r.history.at(-1)?.cause).toBe("kit_tampered");
    expect(verbs(w)).not.toContain("terminalCreate");
  });

  test("SEC-1: the user-level Claude env's credential keys are blank in every kit settings file, on the launch line and for the setup", async () => {
    const w = await makeWorld();
    writeFileSync(
      join(w.root, ".claude", "settings.json"),
      JSON.stringify({ model: "claude-fable-5-1[1m]", env: { LANGFUSE_SECRET_KEY: "sk-lf-x" } }),
    );
    const repo = bouncr(w).repos.api;
    if (!repo) throw new Error("api repo missing");
    repo.setup = [["sh", "-c", 'test -z "$LANGFUSE_SECRET_KEY" && test -z "$GITHUB_PERSONAL_ACCESS_TOKEN"']];
    const saved = process.env.LANGFUSE_SECRET_KEY;
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-dispatcher"; // as if the dispatcher's own environment carried it
    let r: WRecord;
    try {
      r = await claim(w);
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, "LANGFUSE_SECRET_KEY");
      else process.env.LANGFUSE_SECRET_KEY = saved;
    }
    expect(r.stage).toBe("working"); // the setup saw both blank
    const kit = w.ctx.kitDirFor("JRF-501");
    for (const f of readdirSync(kit).filter((n) => /^claude-settings.*\.json$/.test(n))) {
      const env = (JSON.parse(readFileSync(join(kit, f), "utf8")) as { env: Record<string, string> }).env;
      expect(env).toMatchObject({ LANGFUSE_SECRET_KEY: "", GITHUB_PERSONAL_ACCESS_TOKEN: "", GH_TOKEN: "" });
    }
    expect(commands(w)[0]).toContain("LANGFUSE_SECRET_KEY='' ");
    expect(commands(w)[0]).not.toContain("sk-lf");
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

  test("model_unresolved: a provider whose configured model cannot be read (Claude's settings.json does not parse) gets no claim at all", async () => {
    const w = await makeWorld();
    writeFileSync(join(w.root, ".claude", "settings.json"), "{ not json");
    const err = await claim(w).catch((e: unknown) => e);
    expect(err instanceof WingmateError && err.code).toBe("model_unresolved");
    expect(await readRecord(w.dirs, "JRF-501")).toBeNull();
  });

  test("R31: with no top-level model in ~/.claude/settings.json (Claude Code keeps per-model settings under modelSettings) the coordinator runs on the CLI default — launch.model null, no --model but --effort max, shown as CLI default in launch.json, the brief and the status comment", async () => {
    const w = await makeWorld();
    writeFileSync(
      join(w.root, ".claude", "settings.json"),
      JSON.stringify({ modelSettings: { "claude-fable-5-1": { effort: "high" } }, effortLevel: "high" }),
    );
    const r = await claim(w);
    expect(r.stage).toBe("working");
    expect(r.coordinator.launch).toEqual({ model: null, effort: "max" });
    expect(r.coordinator.argv).not.toContain("--model");
    expect(r.coordinator.argv.slice(0, 3)).toEqual(["claude", "--effort", "max"]);
    expect(commands(w)[0]).not.toContain("--model");
    const wt = r.worktree?.path ?? "";
    const launch = LaunchSchema.parse(JSON.parse(readFileSync(join(wt, ".wingmate", "launch.json"), "utf8")));
    expect(launch).toMatchObject({ model: null, effort: "max" });
    expect(launch.tiers.claude).toEqual({ model: null, effort: "max" });
    expect(readFileSync(join(wt, ".wingmate", "BRIEF.md"), "utf8")).toContain(
      "claude · CLI default · effort max",
    );
    const status = w.linear.comments.find((c) => c.body.startsWith("<!-- wingmate:status -->"));
    expect(status?.body).toContain("| Provider | claude · CLI default · effort max |");
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

  test("SEC-1: a credential key added to the user-level Claude env after the claim is blank for the successor: the kit's env blocks are refreshed and the launch line blanks it", async () => {
    const w = await makeWorld();
    const r = await claim(w);
    writeFileSync(
      join(w.root, ".claude", "settings.json"),
      JSON.stringify({ model: "claude-fable-5-1[1m]", env: { OPENAI_API_KEY: "sk-x" } }),
    );
    expect(await relaunch(w.ctx, r, "exited")).toBe(true);
    const kit = w.ctx.kitDirFor("JRF-501");
    for (const f of ["claude-settings.json", "claude-settings.worker.json"]) {
      const env = (JSON.parse(readFileSync(join(kit, f), "utf8")) as { env: Record<string, string> }).env;
      expect(env.OPENAI_API_KEY).toBe("");
    }
    expect(commands(w)[1]).toContain("OPENAI_API_KEY='' ");
  });

  /** N3: Orca lists the title the agent set (spike §3.3), never the `--title` it was created with. */
  const oscTitles = (w: World, r: WRecord) => {
    const wt = r.worktree?.id ?? "";
    w.orca.terminals.set(
      wt,
      (w.orca.terminals.get(wt) ?? []).map((t) => ({ ...t, title: "✳ Implement the scoring API" })),
    );
  };

  test("INT-2 + N3: a live coordinator of the issue that the record does not hold (Orca re-issued its handle and pane) is adopted whatever its title — no second coordinator, the relaunch not counted", async () => {
    const w = await makeWorld();
    const r = await claim(w);
    oscTitles(w, r);
    const live = r.coordinator.terminalHandle;
    r.coordinator.terminalHandle = "term_before_restart";
    r.coordinator.paneKey = "tab0:leaf0";
    expect(await relaunch(w.ctx, r, "exited")).toBe(true); // its pane is working: nothing is sent into the turn
    expect(r.coordinator.terminalHandle).toBe(live ?? "");
    expect(r.coordinator.relaunches).toBe(0);
    expect(verbs(w).filter((x) => x === "terminalCreate")).toHaveLength(1);
    expect((await w.ctx.ledger.readIssue("JRF-501")).some((e) => e.type === "terminal_adopted")).toBe(true);
    // an idle adopted coordinator gets the resume pointer, as a successor would
    w.orca.setAgentState(r.worktree?.id ?? "", r.coordinator.paneKey ?? "", "done", w.ctx.now());
    r.coordinator.terminalHandle = "term_before_restart";
    const sends = verbs(w).filter((x) => x === "terminalSend").length;
    expect(await relaunch(w.ctx, r, "exited")).toBe(true);
    expect(verbs(w).filter((x) => x === "terminalSend")).toHaveLength(sends + 1);
    expect(verbs(w).filter((x) => x === "terminalCreate")).toHaveLength(1);
  });

  test("N3: two live agent terminals the record does not hold are never guessed between — nothing adopted, nothing created, the relaunch not counted, attention coordinator_ambiguous", async () => {
    const w = await makeWorld();
    const r = await claim(w);
    const wt = r.worktree?.id ?? "";
    // the owner's own Claude session in the issue worktree, next to the coordinator Orca re-issued
    await w.orca.terminalCreate(wt, "owner", "claude");
    oscTitles(w, r);
    r.coordinator.terminalHandle = "term_before_restart";
    r.coordinator.paneKey = "tab0:leaf0";
    const creates = verbs(w).filter((x) => x === "terminalCreate").length;
    expect(await relaunch(w.ctx, r, "exited")).toBe(false);
    expect(verbs(w).filter((x) => x === "terminalCreate")).toHaveLength(creates);
    expect(r.coordinator).toMatchObject({ terminalHandle: "term_before_restart", relaunches: 0 });
    expect(r.attention).toContain("coordinator_ambiguous");
    expect((await w.ctx.ledger.readIssue("JRF-501")).some((e) => e.type === "coordinator_ambiguous")).toBe(
      true,
    );
  });

  test("N3: a live role agent of the child Run (worker-list agentTerminalHandle) is never adopted as the coordinator: the successor is created", async () => {
    const w = await makeWorld();
    const r = await claim(w);
    const wt = r.worktree?.id ?? "";
    const coordinator = r.coordinator.terminalHandle ?? "";
    w.orca.killTerminal(wt, coordinator); // the coordinator exited
    const role = await w.orca.terminalCreate(wt, "wingmate JRF-501 code-reviewer", "claude");
    oscTitles(w, r);
    r.coordinator.childRunId = "run_child";
    w.orca.workers.set("run_child", [
      {
        dispatchId: "ctx_1",
        taskId: "task_1",
        runId: "run_child",
        workerState: "running",
        dispatchStatus: "active",
        agentTerminalHandle: role.handle,
        verdict: "live",
      },
    ]);
    const creates = commands(w).length;
    expect(await relaunch(w.ctx, r, "exited")).toBe(true);
    expect(r.coordinator.terminalHandle).not.toBe(role.handle);
    expect(r.coordinator.relaunches).toBe(1);
    expect(commands(w)).toHaveLength(creates + 1); // the successor
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

  test("M-RELAUNCH (R32): an Orca read failing in the adoption lookup (terminal list, fleet, the Run's workers) is absorbed into relaunch_failed like any Orca failure — nothing thrown or created, the record written, the counter advanced (not for a handoff's first launch)", async () => {
    for (const verb of ["terminalList", "worktreePs", "workerList"]) {
      const w = await makeWorld();
      const r = await claim(w);
      await w.orca.terminalCreate(r.worktree?.id ?? "", "owner", "claude"); // a terminal the lookup has to look at
      r.coordinator.childRunId = "run_child";
      w.orca.failNext = verb;
      expect(await relaunch(w.ctx, r, "exited")).toBe(false);
      expect({ verb, relaunches: r.coordinator.relaunches }).toEqual({ verb, relaunches: 1 });
      expect(r.attention).toContain("relaunch_failed");
      expect((await readRecord(w.dirs, "JRF-501"))?.coordinator.relaunches).toBe(1);
      const failed = (await w.ctx.ledger.readIssue("JRF-501")).filter((e) => e.type === "relaunch_failed");
      expect(failed.map((e) => e.data)).toEqual([{ reason: "exited", code: "orca_unreachable" }]);
      expect(commands(w)).toHaveLength(2); // the claim's coordinator and the test's own terminal: no successor
    }
    const w = await makeWorld();
    const r = await claim(w);
    w.orca.failNext = "terminalList";
    expect(await relaunch(w.ctx, r, "handoff:test", { counted: false })).toBe(false);
    expect(r.coordinator.relaunches).toBe(0);
    expect(r.attention).toContain("relaunch_failed");
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
