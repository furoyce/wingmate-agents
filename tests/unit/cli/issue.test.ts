import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { type Env, type IssueDeps, issueCommand } from "../../../src/cli/commands/issue";
import { parseArgv } from "../../../src/cli/index";
import { loadConfig } from "../../../src/config/load";
import { installKit, integrityHashes } from "../../../src/kit/install";
import { listIntents } from "../../../src/kit/intents";
import { type Launch, type Local, readLocal, writeLocal } from "../../../src/kit/local";
import {
  SPAWN_ROLES,
  agentEnv,
  codexArgv,
  launchCommand,
  roleSettingsFile,
  roleSettingsFiles,
} from "../../../src/kit/settings";
import { OrcaError, type OrcaOptions } from "../../../src/orca/cli";
import type { WorkerRow } from "../../../src/ports";
import { run } from "../../../src/shared/exec";
import { newRecord } from "../../../src/state/records";

const GIT_ID = ["-c", "user.name=t", "-c", "user.email=t@example.invalid"];
const git = (wt: string, ...args: string[]) => run(["git", "-C", wt, ...GIT_ID, ...args]);
const headOf = async (wt: string) => (await git(wt, "rev-parse", "HEAD")).stdout.trim();
async function worktree(opts: { git?: boolean } = {}) {
  const wt = mkdtempSync(join(tmpdir(), "wm-iss-"));
  mkdirSync(join(wt, ".wingmate", "evidence"), { recursive: true });
  if (opts.git) {
    await run(["git", "init", "-q", wt]);
    await git(wt, "commit", "-q", "--allow-empty", "-m", "init");
  }
  await writeLocal(wt, {
    record: {
      identifier: "JRF-404",
      stage: "working",
      pipelineStage: "intake",
      provider: "claude",
      childRunId: null,
    },
    gates: {},
    questions: [],
    run: null,
  });
  return wt;
}
async function commit(wt: string, files: Record<string, string>): Promise<string> {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(wt, f)), { recursive: true });
    writeFileSync(join(wt, f), text);
  }
  await git(wt, "add", "--", ...Object.keys(files));
  await git(wt, "commit", "-q", "-m", "change");
  return headOf(wt);
}
const WT_ID = "repo1::/wt/wm-jrf-404";
const launchFor = (wt: string, over: Partial<Launch> = {}): Launch => ({
  provider: "claude",
  model: "m",
  effort: "max",
  kitDir: "/k",
  worktreeId: WT_ID,
  roleSettings: {
    "plan-verifier": "/k/claude-settings.plan-verifier.json",
    "code-reviewer": "/k/claude-settings.code-reviewer.json",
    "security-reviewer": "/k/claude-settings.security-reviewer.json",
    "ui-reviewer": "/k/claude-settings.ui-reviewer.json",
    worker: "/k/claude-settings.worker.json",
  },
  baseSha: null,
  commonDir: join(wt, ".git"),
  pinnedGates: [["sh", "-c", "exit 0"]],
  ui: { kind: "web", paths: ["web/"] },
  allowDeps: false,
  forbiddenPaths: [".github/**", "CLAUDE.md"],
  verifyCross: true,
  workers: ["claude", "codex"],
  tiers: {},
  quota: { weeklyMax: 80, sessionMax: 90, maxSnapshotAgeMin: 360 },
  ...over,
});
const writeLaunch = (wt: string, over: Partial<Launch> = {}) =>
  writeFileSync(join(wt, ".wingmate", "launch.json"), JSON.stringify(launchFor(wt, over)));
const STAGES = ["intake", "plan", "planVerify", "implement", "validate", "ui", "security"];
/** Marks `stages` passed (ui as NA) at `headSha`. */
async function passGates(wt: string, headSha: string | null, stages = STAGES): Promise<Local> {
  const local = await readLocal(wt);
  for (const s of stages)
    local.gates[s] = {
      verdict: s === "ui" ? "NA" : "PASS",
      failCount: 0,
      at: null,
      evidencePath: null,
      headSha,
      note: null,
      method: null,
      dispatchId: null,
    };
  await writeLocal(wt, local);
  return local;
}
const noWorkers: NonNullable<IssueDeps["orca"]> = { workerList: async () => [] };
const capture = async (fn: () => Promise<number>) => {
  const out: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => {
    out.push(String(s));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await fn();
    return { code, out: out.join("") };
  } finally {
    process.stdout.write = orig;
  }
};
const runVerb = (wt: string, args: string[], deps: Partial<IssueDeps> = {}) =>
  capture(() =>
    issueCommand(parseArgv(["issue", "JRF-404", ...args]), { cwd: wt, orca: noWorkers, ...deps }),
  );
type Refusal = { ok: boolean; code: string; message: string; nextStep: string | null };
const refusal = (r: { code: number; out: string }): Refusal => {
  expect(r.code).toBe(2);
  const o = JSON.parse(r.out) as Refusal;
  expect(Object.keys(o).sort()).toEqual(["code", "message", "nextStep", "ok"]);
  expect(o.ok).toBe(false);
  return o;
};

describe("wingmate issue", () => {
  test("gate intake requires --method and evidence; writes gates.json and an intent", async () => {
    const wt = await worktree();
    writeFileSync(join(wt, ".wingmate", "evidence", "assumptions.md"), "- a");
    expect(
      (
        await runVerb(wt, [
          "gate",
          "intake",
          "--verdict",
          "PASS",
          "--evidence",
          ".wingmate/evidence/assumptions.md",
        ])
      ).code,
    ).toBe(2);
    const ok = await runVerb(wt, [
      "gate",
      "intake",
      "--verdict",
      "PASS",
      "--evidence",
      ".wingmate/evidence/assumptions.md",
      "--method",
      "loop",
    ]);
    expect(ok.code).toBe(0);
    expect((await listIntents(wt))[0]).toMatchObject({
      kind: "gate",
      payload: { stage: "intake", verdict: "PASS", method: "loop" },
    });
  });
  test("gate order is enforced and the third FAIL is refused", async () => {
    const wt = await worktree();
    writeFileSync(join(wt, ".wingmate", "evidence", "p.md"), "x");
    expect(
      (await runVerb(wt, ["gate", "plan", "--verdict", "PASS", "--evidence", ".wingmate/evidence/p.md"]))
        .code,
    ).toBe(2);
    await runVerb(wt, [
      "gate",
      "intake",
      "--verdict",
      "PASS",
      "--evidence",
      ".wingmate/evidence/p.md",
      "--method",
      "loop",
    ]);
    for (let i = 0; i < 2; i++)
      expect(
        (await runVerb(wt, ["gate", "plan", "--verdict", "FAIL", "--evidence", ".wingmate/evidence/p.md"]))
          .code,
      ).toBe(0);
    const third = await runVerb(wt, [
      "gate",
      "plan",
      "--verdict",
      "FAIL",
      "--evidence",
      ".wingmate/evidence/p.md",
    ]);
    expect(third.code).toBe(2);
    expect(third.out).toContain("gate_retry_exhausted");
  });
  test("validate and security reject --verdict", async () => {
    const wt = await worktree();
    expect((await runVerb(wt, ["gate", "validate", "--verdict", "PASS"])).out).toContain(
      "verdict_not_allowed",
    );
    expect(refusal(await runVerb(wt, ["gate", "security", "--verdict", "PASS"])).code).toBe(
      "verdict_not_allowed",
    );
  });
  test("ask refuses while a question is open and writes an intent otherwise", async () => {
    const wt = await worktree();
    writeFileSync(join(wt, ".wingmate", "q.md"), "Which unit?");
    expect(
      (
        await runVerb(wt, [
          "ask",
          "--question-file",
          ".wingmate/q.md",
          "--options",
          "ms,us",
          "--recommend",
          "ms",
        ])
      ).code,
    ).toBe(0);
    expect((await runVerb(wt, ["ask", "--question-file", ".wingmate/q.md"])).out).toContain("question_open");
  });
  test("finish refuses with gates_incomplete", async () => {
    const wt = await worktree();
    writeFileSync(join(wt, ".wingmate", "s.md"), "done");
    expect((await runVerb(wt, ["finish", "--summary-file", ".wingmate/s.md"])).out).toContain(
      "gates_incomplete",
    );
  });

  test("refusals are JSON { ok:false, code, message, nextStep } with exit 2; <id> is optional", async () => {
    const empty = mkdtempSync(join(tmpdir(), "wm-empty-"));
    const none = await capture(() =>
      issueCommand(parseArgv(["issue", "JRF-404", "show"]), { cwd: empty, orca: noWorkers }),
    );
    expect(refusal(none).code).toBe("not_a_wingmate_worktree");
    const wt = await worktree();
    const wrong = await capture(() =>
      issueCommand(parseArgv(["issue", "JRF-999", "show"]), { cwd: wt, orca: noWorkers }),
    );
    expect(refusal(wrong).code).toBe("wrong_issue");
    expect(refusal(await runVerb(wt, ["frobnicate"])).code).toBe("usage");
    writeFileSync(join(wt, ".wingmate", "record.json"), "{");
    expect(refusal(await runVerb(wt, ["show"])).code).toBe("local_state_invalid");
    const wt2 = await worktree();
    writeFileSync(join(wt2, ".wingmate", "evidence", "a.md"), "- a");
    const noId = (args: string[]) =>
      capture(() => issueCommand(parseArgv(["issue", ...args]), { cwd: wt2, orca: noWorkers }));
    expect((await noId(["show"])).code).toBe(0);
    expect((await noId(["note", "half", "way"])).code).toBe(0);
    expect(
      (
        await noId([
          "gate",
          "intake",
          "--verdict",
          "PASS",
          "--evidence",
          ".wingmate/evidence/a.md",
          "--method",
          "graph",
        ])
      ).code,
    ).toBe(0);
    expect((await listIntents(wt2)).map((i) => i.kind)).toEqual(["note", "gate"]);
    expect((await listIntents(wt2))[0]).toMatchObject({ payload: { text: "half way" } });
  });

  test("evidence must be a non-empty regular file under .wingmate/evidence", async () => {
    const wt = await worktree();
    writeFileSync(join(wt, ".wingmate", "evidence", "empty.md"), "");
    writeFileSync(join(wt, "outside.md"), "x");
    symlinkSync(join(wt, "outside.md"), join(wt, ".wingmate", "evidence", "link.md"));
    const intake = (extra: string[]) =>
      runVerb(wt, ["gate", "intake", "--verdict", "PASS", "--method", "loop", ...extra]);
    for (const p of [
      ".wingmate/evidence/empty.md",
      "outside.md",
      ".wingmate/evidence/link.md",
      ".wingmate/evidence/../../outside.md",
      ".wingmate/evidencex/a.md",
    ])
      expect(refusal(await intake(["--evidence", p])).code).toBe("evidence_invalid");
    expect(refusal(await intake([])).code).toBe("evidence_required");
  });

  test("NA is for ui only, and ui refuses NA when the diff from the base touches ui.paths", async () => {
    const wt = await worktree({ git: true });
    const base = await headOf(wt);
    writeLaunch(wt, { baseSha: base, ui: { kind: "web", paths: ["web/"] } });
    const h = await commit(wt, { "web/app.tsx": "export {}\n" });
    await passGates(wt, h, ["intake", "plan", "planVerify", "implement", "validate"]);
    expect(refusal(await runVerb(wt, ["gate", "plan", "--verdict", "NA"])).code).toBe("verdict_not_allowed");
    expect(refusal(await runVerb(wt, ["gate", "ui", "--verdict", "NA"])).code).toBe("ui_changed");
    const other = await worktree({ git: true });
    writeLaunch(other, { baseSha: await headOf(other), ui: { kind: "web", paths: ["web/"] } });
    const h2 = await commit(other, { "src/a.ts": "export {}\n" });
    await passGates(other, h2, ["intake", "plan", "planVerify", "implement", "validate"]);
    const na = await runVerb(other, ["gate", "ui", "--verdict", "NA", "--note", "no UI change"]);
    expect(JSON.parse(na.out)).toMatchObject({ ok: true, stage: "ui", verdict: "NA" });
  });

  test("validate runs the pinned gates, computes the verdict and writes a report only it can mark `exit N`", async () => {
    const wt = await worktree({ git: true });
    await passGates(wt, null, ["intake", "plan", "planVerify", "implement"]);
    writeLaunch(wt, { pinnedGates: [["sh", "-c", "echo exit 1; exit 0"]] });
    const pass = await runVerb(wt, ["gate", "validate"]);
    expect(JSON.parse(pass.out)).toMatchObject({ ok: true, stage: "validate", verdict: "PASS" });
    const report = readFileSync(join(wt, ".wingmate", "evidence", "validate", "report.txt"), "utf8");
    expect(report).toContain("$ sh -c echo exit 1; exit 0\nexit 0\nsha256 ");
    expect(/^exit (?!0$)\d+/m.test(report)).toBe(false); // Task 11's validate_stale check sees only our exit lines
    expect((await readLocal(wt)).gates.validate?.headSha).toBe(await headOf(wt));
    writeLaunch(wt, { pinnedGates: [["sh", "-c", "echo boom; exit 3"], ["definitely-not-a-binary-wm"]] });
    const fail = await runVerb(wt, ["gate", "validate"]);
    expect(JSON.parse(fail.out)).toMatchObject({
      ok: true,
      stage: "validate",
      verdict: "FAIL",
      failCount: 1,
    });
    const failed = readFileSync(join(wt, ".wingmate", "evidence", "validate", "report.txt"), "utf8");
    expect(failed).toContain("exit 3");
    expect(failed).toContain("exit 127");
    await runVerb(wt, ["gate", "validate"]);
    const third = refusal(await runVerb(wt, ["gate", "validate"]));
    expect(third.code).toBe("gate_retry_exhausted");
    expect((await readLocal(wt)).gates.validate?.failCount).toBe(2);
  });

  test("security computes secret scan, path guard and dependency policy from the committed diff, never echoing the secret", async () => {
    const wt = await worktree({ git: true });
    writeLaunch(wt, { baseSha: await headOf(wt) });
    const secret = `sk-ant-api03-${"Q".repeat(32)}`;
    const h = await commit(wt, {
      "src/config.ts": `export const k = "${secret}";\n`,
      ".github/workflows/ci.yml": "on: push\n",
      "package.json": '{"name":"x"}\n',
    });
    await passGates(wt, h, ["intake", "plan", "planVerify", "implement", "validate", "ui"]);
    const r = await runVerb(wt, ["gate", "security"]);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, stage: "security", verdict: "FAIL" });
    const report = readFileSync(join(wt, ".wingmate", "evidence", "security", "report.txt"), "utf8");
    expect(report).toContain("secrets: 1\n  anthropic src/config.ts");
    expect(report).toContain(".github/workflows/ci.yml ~ .github/**");
    expect(report).toContain("deps: dependency_change_without_allow_deps");
    expect(report).not.toContain(secret.slice(0, 12));
    const clean = await worktree({ git: true });
    writeLaunch(clean, { baseSha: await headOf(clean) });
    const h2 = await commit(clean, { "src/a.ts": "export const a = 1;\n" });
    await passGates(clean, h2, ["intake", "plan", "planVerify", "implement", "validate", "ui"]);
    expect(JSON.parse((await runVerb(clean, ["gate", "security"])).out)).toMatchObject({ verdict: "PASS" });
  });

  test("F4: security reads every commit since the base, as publish does: a fix committed on top fails until the commits are rewritten", async () => {
    const wt = await worktree({ git: true });
    const base = await headOf(wt);
    writeLaunch(wt, { baseSha: base });
    const security = async () => {
      await passGates(wt, await headOf(wt), ["intake", "plan", "planVerify", "implement", "validate", "ui"]);
      const out = JSON.parse((await runVerb(wt, ["gate", "security"])).out) as { verdict: string };
      const report = readFileSync(join(wt, ".wingmate", "evidence", "security", "report.txt"), "utf8");
      return { verdict: out.verdict, report };
    };
    const secret = `sk-ant-api03-${"Q".repeat(32)}`;
    await commit(wt, {
      "src/config.ts": `export const k = "${secret}";\n`,
      ".github/workflows/ci.yml": "on: push\n",
    });
    // the agent's fix goes on top: HEAD is clean, the commit under it is not, and the push sends both
    await git(wt, "rm", "-q", "--", ".github/workflows/ci.yml");
    await commit(wt, { "src/config.ts": "export const k = process.env.KEY;\n" });
    const onTop = await security();
    expect(onTop.verdict).toBe("FAIL");
    expect(onTop.report).toContain("secrets: 1\n  anthropic src/config.ts (in the branch history)\n");
    expect(onTop.report).toContain(
      "pathguard: 1\n  .github/workflows/ci.yml ~ .github/** (in the branch history)\n",
    );
    expect(onTop.report).toContain("do not commit a fix on top: rewrite the unpushed commits");
    expect(onTop.report).not.toContain(secret.slice(0, 12));
    // squashed onto the base: no commit holds either any more
    await git(wt, "reset", "-q", "--soft", base);
    await git(wt, "commit", "-q", "-m", "read the key from the environment");
    const squashed = await security();
    expect(squashed.verdict).toBe("PASS");
    expect(squashed.report).not.toContain("rewrite");
    // the push sends the commit messages too
    await git(wt, "commit", "-q", "--allow-empty", "-m", `rotate GH_TOKEN=ghp_${"A".repeat(36)}`);
    const message = await security();
    expect(message.verdict).toBe("FAIL");
    expect(message.report).toContain("secrets: 1\n  github (in a commit message)\n");
    expect(message.report).not.toContain("ghp_AAAA");
  });

  test("a HEAD change makes validate/security PASS and ui PASS/NA stale: later gates and finish refuse until re-gated", async () => {
    const wt = await worktree({ git: true });
    writeFileSync(join(wt, ".wingmate", "s.md"), "summary");
    writeFileSync(join(wt, ".wingmate", "evidence", "ui.md"), "shots");
    const h1 = await commit(wt, { "src/a.ts": "1\n" });
    writeLaunch(wt, { baseSha: null });
    await passGates(wt, h1);
    await commit(wt, { "src/a.ts": "2\n" });
    const fin = refusal(await runVerb(wt, ["finish", "--summary-file", ".wingmate/s.md"]));
    expect(fin.code).toBe("gates_incomplete");
    expect(fin.message).toContain("validate, ui, security");
    const gates = (await readLocal(wt)).gates;
    expect([gates.validate?.verdict, gates.ui?.verdict, gates.security?.verdict]).toEqual([
      "STALE",
      "STALE",
      "STALE",
    ]);
    expect(gates.implement?.verdict).toBe("PASS"); // judgment gates do not go stale
    const ui = refusal(
      await runVerb(wt, ["gate", "ui", "--verdict", "PASS", "--evidence", ".wingmate/evidence/ui.md"]),
    );
    expect(ui.code).toBe("stage_prerequisite");
    expect(ui.message).toContain("validate (stale)");
  });

  test("finish refuses nothing_to_publish and an invalid summary file, then writes the intent", async () => {
    const wt = await worktree({ git: true });
    const base = await headOf(wt);
    writeLaunch(wt, { baseSha: base });
    await passGates(wt, base);
    writeFileSync(join(wt, ".wingmate", "s.md"), "done");
    expect(refusal(await runVerb(wt, ["finish", "--summary-file", ".wingmate/missing.md"])).code).toBe(
      "file_invalid",
    );
    expect(refusal(await runVerb(wt, ["finish", "--summary-file", ".wingmate/s.md"])).code).toBe(
      "nothing_to_publish",
    );
    const h = await commit(wt, { "src/a.ts": "1\n" });
    await passGates(wt, h);
    const ok = await runVerb(wt, [
      "finish",
      "--summary-file",
      ".wingmate/s.md",
      "--title",
      "T",
      "--draft",
      "--repo",
      "api",
    ]);
    expect(JSON.parse(ok.out)).toEqual({ ok: true, next: "END YOUR TURN NOW" });
    expect((await listIntents(wt)).at(-1)).toMatchObject({
      kind: "finish",
      payload: { summaryFile: ".wingmate/s.md", title: "T", draft: true, repos: ["api"] },
    });
  });

  test("ask validates --recommend, --append/--reask, live workers and the question file; writes stage.json", async () => {
    const wt = await worktree();
    writeFileSync(join(wt, ".wingmate", "q.md"), "Which unit?");
    const ask = (extra: string[], deps: Partial<IssueDeps> = {}) =>
      runVerb(wt, ["ask", "--question-file", ".wingmate/q.md", ...extra], deps);
    expect(refusal(await ask(["--options", "ms,us", "--recommend", "ns"])).code).toBe("bad_recommend");
    expect(refusal(await runVerb(wt, ["ask", "--question-file", ".wingmate/none.md"])).code).toBe(
      "file_invalid",
    );
    const first = await ask(["--options", "ms,us", "--recommend", "ms"]);
    const { questionId } = JSON.parse(first.out) as { questionId: string };
    expect(JSON.parse(first.out)).toEqual({ ok: true, questionId, next: "END YOUR TURN NOW" });
    expect((await listIntents(wt)).at(-1)).toMatchObject({
      id: questionId,
      kind: "ask",
      payload: {
        questionFile: ".wingmate/q.md",
        options: ["ms", "us"],
        recommend: 1,
        append: null,
        reask: null,
      },
    });
    expect(JSON.parse(readFileSync(join(wt, ".wingmate", "stage.json"), "utf8"))).toMatchObject({
      pipelineStage: "intake",
      via: "ask",
      questionId,
    });
    expect(refusal(await runVerb(wt, ["ask", "--append", questionId])).code).toBe("usage");
    expect(refusal(await ask(["--append", "01NOPE"])).code).toBe("unknown_question");
    const more = await ask(["--append", questionId]);
    expect(JSON.parse(more.out)).toMatchObject({ ok: true, questionId });
    expect((await listIntents(wt)).at(-1)).toMatchObject({ payload: { append: questionId } });
    expect((await readLocal(wt)).questions).toHaveLength(1);
    writeFileSync(join(wt, ".wingmate", "secret.md"), `use token ghp_${"a1B2".repeat(9)}`);
    const local = await readLocal(wt);
    local.questions = [];
    await writeLocal(wt, local);
    expect(refusal(await runVerb(wt, ["ask", "--question-file", ".wingmate/secret.md"])).code).toBe(
      "secret_detected",
    );
    expect((await runVerb(wt, ["run", "--id", "run_1"])).code).toBe(0); // a child Run exists → live workers are checked
    const live: WorkerRow = {
      dispatchId: "ctx_9",
      taskId: "t",
      runId: "run_1",
      workerState: "running",
      dispatchStatus: "active",
      agentTerminalHandle: null,
      verdict: "live",
    };
    let asked = "";
    const lister = {
      workerList: async (runId: string) => {
        asked = runId;
        return [live];
      },
    };
    expect(refusal(await ask([], { orca: lister })).code).toBe("workers_live");
    expect(asked).toBe("run_1");
    expect(
      refusal(await runVerb(wt, ["finish", "--summary-file", ".wingmate/q.md"], { orca: lister })).code,
    ).toBe("workers_live");
  });

  test("note, handoff, followup and run write intents; show lists them; secrets and oversize notes are refused", async () => {
    const wt = await worktree();
    expect((await runVerb(wt, ["note", "half way"])).code).toBe(0);
    expect((await runVerb(wt, ["handoff", "--reason", "quota"])).code).toBe(0);
    writeFileSync(join(wt, ".wingmate", "f.md"), "body");
    expect((await runVerb(wt, ["followup", "--title", "Later", "--body-file", ".wingmate/f.md"])).code).toBe(
      0,
    );
    expect((await runVerb(wt, ["run", "--id", "run_1"])).code).toBe(0);
    const kinds = (await listIntents(wt)).map((i) => i.kind);
    expect(kinds).toEqual(["note", "handoff", "followup", "run"]);
    const show = JSON.parse((await runVerb(wt, ["show"])).out) as {
      pendingIntents: { kind: string }[];
      run: unknown;
    };
    expect(show.pendingIntents.map((p) => p.kind)).toEqual(kinds);
    expect((await readLocal(wt)).run).toEqual({ childRunId: "run_1" });
    // C8: PROTOCOL sends a coordinator whose spawn timed out to `show`, so it names the child Run to look in
    expect(show.run).toEqual({ childRunId: "run_1" });
    expect(refusal(await runVerb(wt, ["note", `key AKIA${"ABCDEFGHIJKLMNOP"}`])).code).toBe(
      "secret_detected",
    );
    expect(refusal(await runVerb(wt, ["note", "x".repeat(2001)])).code).toBe("note_too_long");
    expect(refusal(await runVerb(wt, ["followup", "--title", "x", "--body-file", "../f.md"])).code).toBe(
      "file_invalid",
    );
    expect((await listIntents(wt)).length).toBe(4);
  });

  test("an invalid outbox file surfaces as an intent_invalid refusal naming the file", async () => {
    const wt = await worktree();
    await Bun.write(join(wt, ".wingmate", "outbox", "01BAD.json"), '{"kind":"nope"}');
    const r = refusal(await runVerb(wt, ["show"]));
    expect(r.code).toBe("intent_invalid");
    expect(r.message).toContain("01BAD.json");
  });

  test("the verbs write only under .wingmate/", async () => {
    const wt = await worktree({ git: true });
    writeFileSync(join(wt, ".wingmate", "evidence", "a.md"), "- a");
    writeFileSync(join(wt, ".wingmate", "q.md"), "Which unit?");
    writeFileSync(join(wt, ".wingmate", "f.md"), "body");
    writeLaunch(wt, { baseSha: await headOf(wt) });
    const snapshot = () => {
      const seen = new Map<string, string>();
      const walk = (d: string) => {
        for (const n of readdirSync(d)) {
          const p = join(d, n);
          if (relative(wt, p) === ".git") continue;
          const s = statSync(p);
          if (s.isDirectory()) walk(p);
          else seen.set(relative(wt, p), `${s.size}:${s.mtimeMs}`);
        }
      };
      walk(wt);
      return seen;
    };
    const before = snapshot();
    for (const args of [
      ["gate", "intake", "--verdict", "PASS", "--evidence", ".wingmate/evidence/a.md", "--method", "loop"],
      ["gate", "plan", "--verdict", "PASS", "--evidence", ".wingmate/evidence/a.md"],
      ["ask", "--question-file", ".wingmate/q.md", "--options", "a,b"],
      ["note", "progress"],
      ["run", "--id", "run_1"],
      ["followup", "--title", "Later", "--body-file", ".wingmate/f.md"],
      ["finish", "--summary-file", ".wingmate/f.md"],
      ["handoff", "--reason", "quota"],
      ["show"],
      ["log"],
    ])
      await runVerb(wt, args);
    const after = snapshot();
    const touched = [...after.keys()].filter((k) => before.get(k) !== after.get(k));
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.filter((k) => !k.startsWith(".wingmate/"))).toEqual([]);
  });

  test("F11: an unexpected error is still the JSON refusal contract (internal_error, exit 2), never a stack trace", async () => {
    const wt = await worktree();
    writeFileSync(join(wt, ".wingmate", "q.md"), "Which unit?");
    expect((await runVerb(wt, ["run", "--id", "run_1"])).code).toBe(0); // a child Run → ask consults workerList
    const failing = (thrown: unknown) => ({
      workerList: async (): Promise<WorkerRow[]> => {
        throw thrown;
      },
    });
    for (const [thrown, message] of [
      [new TypeError("Cannot read properties of undefined (reading 'verdict')"), "TypeError: Cannot read"],
      ["a bare string", "a bare string"],
    ] as const) {
      const r = await runVerb(wt, ["ask", "--question-file", ".wingmate/q.md"], { orca: failing(thrown) });
      const o = refusal(r); // exit 2, exactly { ok, code, message, nextStep }
      expect(o.code).toBe("internal_error");
      expect(o.message).toStartWith(message);
      expect(o.nextStep).toContain("ask the owner");
      expect(r.out.trim().split("\n")).toHaveLength(1); // one JSON line on stdout …
      expect(r.out).not.toMatch(/\n\s+at /); // … with no stack frames
    }
  });

  test("F12: the question_open and question_not_open hints are commands ask accepts as printed", async () => {
    const wt = await worktree();
    writeFileSync(join(wt, ".wingmate", "q.md"), "Which unit?");
    writeFileSync(join(wt, ".wingmate", "q2.md"), "And which scale?");
    const { questionId } = JSON.parse(
      (await runVerb(wt, ["ask", "--question-file", ".wingmate/q.md"])).out,
    ) as {
      questionId: string;
    };
    /** Runs a printed `wingmate issue <id> …` hint verbatim, with `<path>` filled in. */
    const follow = (hint: string | null) => {
      const words = (hint ?? "").replace("<path>", ".wingmate/q2.md").split(" ");
      expect(words.slice(0, 3)).toEqual(["wingmate", "issue", "JRF-404"]);
      return runVerb(wt, words.slice(3));
    };
    const open = refusal(await runVerb(wt, ["ask", "--question-file", ".wingmate/q2.md"]));
    expect(open.code).toBe("question_open");
    expect(open.nextStep).toBe(`wingmate issue JRF-404 ask --append ${questionId} --question-file <path>`);
    expect(JSON.parse((await follow(open.nextStep)).out)).toMatchObject({ ok: true, questionId });
    const local = await readLocal(wt);
    for (const q of local.questions) q.status = "answered";
    await writeLocal(wt, local);
    const closed = refusal(
      await runVerb(wt, ["ask", "--append", questionId, "--question-file", ".wingmate/q2.md"]),
    );
    expect(closed.code).toBe("question_not_open");
    expect(closed.nextStep).toBe(`wingmate issue JRF-404 ask --reask ${questionId} --question-file <path>`);
    expect(JSON.parse((await follow(closed.nextStep)).out)).toMatchObject({ ok: true, questionId });
    expect((await listIntents(wt)).at(-1)).toMatchObject({ payload: { reask: questionId } });
  });

  test("F16: finish publishes every --repo given (repeated or comma-separated); other verbs refuse a repeated flag", async () => {
    const wt = await worktree({ git: true });
    writeLaunch(wt, { baseSha: await headOf(wt) });
    const h = await commit(wt, { "src/a.ts": "1\n" });
    await passGates(wt, h);
    writeFileSync(join(wt, ".wingmate", "s.md"), "done");
    const fin = (extra: string[]) => runVerb(wt, ["finish", "--summary-file", ".wingmate/s.md", ...extra]);
    expect((await fin(["--repo", "api", "--repo", "web,mobile", "--repo=api"])).code).toBe(0);
    expect((await listIntents(wt)).at(-1)).toMatchObject({
      kind: "finish",
      payload: { repos: ["api", "web", "mobile"] },
    });
    // a flag given twice where one value is expected is ambiguous: refused, never last-wins
    expect(refusal(await fin(["--title", "A", "--title", "B"])).code).toBe("usage");
    expect(refusal(await fin(["--repo", "api", "--repo"])).code).toBe("usage");
    expect(refusal(await runVerb(wt, ["handoff", "--reason", "r", "--repo", "a", "--repo", "b"])).code).toBe(
      "usage",
    );
    expect((await listIntents(wt)).filter((i) => i.kind !== "gate")).toHaveLength(1);
  });

  test("C7: flags named like Object.prototype members are ordinary single flags, never inherited values", async () => {
    const wt = await worktree();
    for (const extra of [
      ["--constructor", "a"],
      ["--__proto__", "a"],
      ["--hasOwnProperty", "x"],
      ["--toString=y"],
    ]) {
      const r = await runVerb(wt, ["note", "half way", ...extra]);
      expect({ extra, code: r.code, out: JSON.parse(r.out) }).toEqual({ extra, code: 0, out: { ok: true } });
    }
    expect((await listIntents(wt)).map((i) => i.kind)).toEqual(["note", "note", "note", "note"]);
  });
});

describe("wingmate issue spawn (§8.1 amended: launch the role agent with the kit, then bind it with worker-start --terminal)", () => {
  /** Writes launch.json and re-seals integrity.json over it, as installKit leaves them. */
  async function sealLaunch(wt: string, launch: Launch) {
    writeFileSync(join(wt, ".wingmate", "launch.json"), JSON.stringify(launch));
    const hashes = await integrityHashes(wt, join(wt, ".git"));
    writeFileSync(
      join(wt, ".wingmate", "integrity.json"),
      JSON.stringify({ commonDir: join(wt, ".git"), hashes }),
    );
  }
  /**
   * An issue worktree and its kit. The kit dir sits where spawn derives it (`<WINGMATE_HOME>/kit/JRF-404`, C1) with one settings
   * file per role, launch.json names it, and `env` is the coordinator's environment (WINGMATE_ROLE, C2) in a temp home.
   */
  async function spawnWorktree(over: Partial<Launch> = {}) {
    const wt = await worktree({ git: true });
    const home = mkdtempSync(join(tmpdir(), "wm-home-"));
    const state = join(home, "state");
    const kit = join(state, "kit", "JRF-404");
    mkdirSync(kit, { recursive: true });
    for (const role of SPAWN_ROLES) writeFileSync(roleSettingsFile(kit, role), "{}\n");
    writeFileSync(join(wt, ".wingmate", "spec.md"), "verify the plan");
    const tiers = { codex: { model: "gpt-x", effort: "xhigh" }, claude: { model: "c", effort: "max" } };
    await sealLaunch(
      wt,
      launchFor(wt, { kitDir: kit, roleSettings: roleSettingsFiles(kit), tiers, ...over }),
    );
    const env: Env = { HOME: home, WINGMATE_HOME: state, WINGMATE_ROLE: "coordinator" };
    return { wt, home, kit, env };
  }
  const TRUST = { wait: { satisfied: false, status: "running", blockedReason: "agent-trust-workspace" } };
  const READY = { wait: { satisfied: true, status: "running" } };
  const NOT_READY = { wait: { satisfied: false, status: "running" } };
  function fakeOrca(
    opts: {
      claude?: number;
      codex?: number;
      receipt?: unknown;
      /** `terminal wait` results in order; an Error is thrown instead */
      waits?: unknown[];
      startError?: Error;
      /** `orca worktree current`'s result (C1); by default the worktree launch.json names */
      current?: unknown;
    } = {},
  ) {
    const calls: string[][] = [];
    const cwds: (string | undefined)[] = [];
    const waits = [...(opts.waits ?? [])];
    let terminals = 0;
    const window = (used: number) => ({ usedPercent: used, windowMinutes: 10080, resetsAt: null });
    const exec = async (args: string[], o: OrcaOptions = {}): Promise<unknown> => {
      calls.push(args);
      const [verb, sub] = args;
      if (verb === "account")
        return {
          rateLimits: {
            claude: { status: "ok", weekly: window(opts.claude ?? 10), updatedAt: Date.now() },
            codex: { status: "ok", weekly: window(opts.codex ?? 10), updatedAt: Date.now() },
          },
        };
      if (verb === "worktree" && sub === "current") {
        cwds.push(o.cwd);
        return opts.current ?? { worktree: { id: WT_ID, repoId: "repo1", path: "/wt/wm-jrf-404" } };
      }
      if (sub === "run-create") return { run: { id: "run_new" } };
      if (verb === "terminal" && sub === "create") {
        terminals += 1;
        const n = terminals;
        return { terminal: { handle: `term_${n}`, tabId: `tab${n}`, paneKey: `tab${n}:leaf${n}` } };
      }
      if (verb === "terminal" && sub === "wait") {
        const w = waits.shift() ?? READY;
        if (w instanceof Error) throw w;
        return w;
      }
      if (verb === "terminal" && (sub === "send" || sub === "close")) return {};
      if (sub === "worker-start") {
        if (opts.startError) throw opts.startError;
        return opts.receipt ?? { worker: { dispatchId: "ctx_7", taskId: "task_7" } };
      }
      throw new Error(`unexpected orca ${args.join(" ")}`);
    };
    return { calls, cwds, orca: { workerList: async () => [], exec } };
  }
  const creates = (calls: string[][]) => calls.filter((c) => c[0] === "terminal" && c[1] === "create");
  const starts = (calls: string[][]) => calls.filter((c) => c[1] === "worker-start");
  const closes = (calls: string[][]) => calls.filter((c) => c[0] === "terminal" && c[1] === "close");
  const commandOf = (c: string[] | undefined) => (c ? (c[c.indexOf("--command") + 1] ?? "") : "");
  const sessionOf = (cmd: string) => /--session-id ([0-9a-f-]{36})/.exec(cmd)?.[1] ?? "no-session-id";
  const wait = (ms: number) => [
    "terminal",
    "wait",
    "--terminal",
    "term_1",
    "--for",
    "tui-idle",
    "--timeout-ms",
    String(ms),
  ];
  const verifierStart = (wtId: string) => [
    "orchestration",
    "worker-start",
    "--run",
    "run_new",
    "--worktree",
    `id:${wtId}`,
    "--terminal",
    "term_1",
    "--spec",
    "Role: plan-verifier for JRF-404. Read .wingmate/prompts/planVerifier.md first.\n\nverify the plan",
    "--task-title",
    "JRF-404 plan-verifier",
  ];
  const SPEC = ["--spec", ".wingmate/spec.md"];

  test("a codex plan-verifier: account, worktree current, run-create, terminal create with the role argv, tui-idle, worker-start --terminal (exact argv)", async () => {
    const { wt, kit, env } = await spawnWorktree();
    const f = fakeOrca();
    const spawn = (args: string[]) => runVerb(wt, ["spawn", ...args], { orca: f.orca, env });
    const dry = await spawn(["--role", "plan-verifier", ...SPEC, "--dry-run"]);
    expect(JSON.parse(dry.out)).toEqual({
      ok: true,
      dryRun: true,
      provider: "codex",
      tier: { model: "gpt-x", effort: "xhigh" },
    });
    expect(f.calls).toEqual([["account", "list"]]);
    const real = await spawn(["--role", "plan-verifier", ...SPEC]);
    expect(JSON.parse(real.out)).toEqual({
      ok: true,
      provider: "codex",
      dispatchId: "ctx_7",
      taskId: "task_7",
      terminalHandle: "term_1",
      runId: "run_new",
    });
    const command = launchCommand(
      codexArgv({ model: "gpt-x", effort: "xhigh", worktreePath: wt, role: "plan-verifier" }),
      agentEnv(kit, "plan-verifier"),
    );
    expect(command).toStartWith("GH_TOKEN='' GITHUB_TOKEN='' ");
    expect(command).toContain(" WINGMATE_ROLE=plan-verifier exec codex -C ");
    expect(command).toEndWith(" --sandbox read-only");
    expect(f.calls.slice(1)).toEqual([
      ["account", "list"],
      ["worktree", "current"],
      ["orchestration", "run-create", "--objective", "JRF-404 workers"],
      [
        "terminal",
        "create",
        "--worktree",
        `id:${WT_ID}`,
        "--title",
        "wingmate JRF-404 plan-verifier",
        "--command",
        command,
      ],
      wait(120_000),
      verifierStart(WT_ID),
    ]);
    expect(f.cwds).toEqual([wt]); // Orca resolves the worktree from the issue worktree itself
    expect((await listIntents(wt)).some((i) => i.kind === "run" && i.payload.runId === "run_new")).toBe(true);
    expect((await readLocal(wt)).run).toEqual({ childRunId: "run_new" });
    // the Run is created once; the next spawn reuses it and gets a terminal of its own
    expect(JSON.parse((await spawn(["--role", "plan-verifier", ...SPEC])).out)).toMatchObject({
      terminalHandle: "term_2",
    });
    expect(f.calls.filter((c) => c[1] === "run-create")).toHaveLength(1);
  });

  test("Claude roles run with their role's kit settings file and agentEnv: tier best for a reviewer, provider default for a worker", async () => {
    const { wt, kit, env } = await spawnWorktree({ provider: "codex", workers: ["cursor", "claude"] });
    const f = fakeOrca();
    const spawn = (args: string[]) => runVerb(wt, ["spawn", ...args], { orca: f.orca, env });
    // coordinator codex → the cross-provider reviewer is Claude, at its tier best
    const review = await spawn(["--role", "code-reviewer", ...SPEC]);
    expect(JSON.parse(review.out)).toMatchObject({ ok: true, provider: "claude", terminalHandle: "term_1" });
    const rc = commandOf(creates(f.calls)[0]);
    expect(rc).toBe(
      launchCommand(
        [
          "claude",
          "--model",
          "c",
          "--effort",
          "max",
          "--session-id",
          sessionOf(rc),
          "--permission-mode",
          "bypassPermissions",
          "--settings",
          roleSettingsFile(kit, "code-reviewer"),
          "--strict-mcp-config",
        ],
        agentEnv(kit, "code-reviewer"),
      ),
    );
    // workers: cursor cannot be launched under the kit, so the next listed provider runs, at tier standard
    const worker = await spawn(["--role", "worker", ...SPEC]);
    expect(JSON.parse(worker.out)).toMatchObject({ ok: true, provider: "claude", terminalHandle: "term_2" });
    const wc = commandOf(creates(f.calls)[1]);
    expect(wc).toBe(
      launchCommand(
        [
          "claude",
          "--session-id",
          sessionOf(wc),
          "--permission-mode",
          "bypassPermissions",
          "--settings",
          roleSettingsFile(kit, "worker"),
          "--strict-mcp-config",
        ],
        agentEnv(kit, "worker"),
      ),
    );
    expect(sessionOf(wc)).not.toBe(sessionOf(rc));
    expect(creates(f.calls)[1]?.slice(0, 6)).toEqual([
      "terminal",
      "create",
      "--worktree",
      `id:${WT_ID}`,
      "--title",
      "wingmate JRF-404 worker",
    ]);
    // worker-start only binds: never the --agent/--model/--effort of an Orca-launched agent, never a child worktree
    expect(starts(f.calls)).toHaveLength(2);
    for (const s of starts(f.calls))
      for (const flag of ["--agent", "--model", "--effort", "--name"]) expect(s).not.toContain(flag);
  });

  test("the folder-trust dialog is answered with Down then Enter and waited out again; the spec never goes into the terminal", async () => {
    const { wt, env } = await spawnWorktree();
    const f = fakeOrca({ waits: [TRUST, READY] });
    const r = await runVerb(wt, ["spawn", "--role", "plan-verifier", ...SPEC], { orca: f.orca, env });
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, dispatchId: "ctx_7", terminalHandle: "term_1" });
    const created = f.calls.findIndex((c) => c[0] === "terminal" && c[1] === "create");
    expect(f.calls.slice(created + 1)).toEqual([
      wait(120_000),
      ["terminal", "send", "--terminal", "term_1", "--text", "\x1b[B"],
      ["terminal", "send", "--terminal", "term_1", "--enter"],
      wait(120_000),
      verifierStart(WT_ID),
    ]);
    expect(f.calls.filter((c) => c[1] === "send").some((c) => c.join(" ").includes("verify the plan"))).toBe(
      false,
    );
  });

  test("a terminal that never gets ready is closed and spawn refuses spawn_not_ready; the trust answer is sent once", async () => {
    const { wt, env } = await spawnWorktree();
    const spawn = (orca: ReturnType<typeof fakeOrca>["orca"]) =>
      runVerb(wt, ["spawn", "--role", "plan-verifier", ...SPEC], { orca, env });
    const slow = fakeOrca({ waits: [NOT_READY, NOT_READY] });
    const r = refusal(await spawn(slow.orca));
    expect(r.code).toBe("spawn_not_ready");
    expect(r.message).toContain("term_1");
    expect(slow.calls.filter((c) => c[1] === "wait").map((c) => c.at(-1))).toEqual(["120000", "180000"]);
    expect(slow.calls.at(-1)).toEqual(["terminal", "close", "--terminal", "term_1"]);
    expect(starts(slow.calls)).toEqual([]);
    const stuck = fakeOrca({ waits: [TRUST, TRUST, TRUST] });
    const s = refusal(await spawn(stuck.orca));
    expect(s.code).toBe("spawn_not_ready");
    expect(s.message).toContain("agent-trust-workspace");
    expect(stuck.calls.filter((c) => c[1] === "send")).toHaveLength(2); // Down and Enter, once
    expect(stuck.calls.filter((c) => c[1] === "wait").map((c) => c.at(-1))).toEqual([
      "120000",
      "120000",
      "180000",
    ]);
    expect(stuck.calls.at(-1)).toEqual(["terminal", "close", "--terminal", "term_1"]);
    expect(starts(stuck.calls)).toEqual([]);
  });

  test("C5: a terminal wait that throws still closes the terminal it created; nothing is bound", async () => {
    const { wt, env } = await spawnWorktree();
    const spawn = (orca: ReturnType<typeof fakeOrca>["orca"]) =>
      runVerb(wt, ["spawn", "--role", "plan-verifier", ...SPEC], { orca, env });
    const timedOut = fakeOrca({ waits: [new OrcaError("orca_timeout", "orca terminal wait timed out")] });
    const r = refusal(await spawn(timedOut.orca));
    expect(r.code).toBe("spawn_not_ready");
    expect(r.message).toContain("term_1");
    expect(r.message).toContain("orca_timeout");
    expect(r.message).toContain("closed");
    expect(timedOut.calls.at(-1)).toEqual(["terminal", "close", "--terminal", "term_1"]);
    expect(starts(timedOut.calls)).toEqual([]);
    // an unparseable wait result is an Orca error too; so is a failing trust answer
    const garbled = fakeOrca({ waits: [{ wait: { status: "running" } }] });
    expect(refusal(await spawn(garbled.orca)).message).toContain("orca_shape");
    expect(closes(garbled.calls)).toEqual([["terminal", "close", "--terminal", "term_1"]]);
    const keys = fakeOrca({ waits: [TRUST, new OrcaError("orca_unreachable", "no envelope")] });
    expect(refusal(await spawn(keys.orca)).code).toBe("spawn_not_ready");
    expect(closes(keys.calls)).toHaveLength(1);
    expect(starts(keys.calls)).toEqual([]);
  });

  test("new-child, --task and a --prefer spawn cannot launch are refused before Orca is touched; --deps travels with --spec", async () => {
    const { wt, env } = await spawnWorktree();
    const f = fakeOrca();
    const spawn = (args: string[]) => runVerb(wt, ["spawn", ...args], { orca: f.orca, env });
    const child = refusal(await spawn(["--role", "worker", ...SPEC, "--worktree", "new-child"]));
    expect(child.code).toBe("new_child_unsupported");
    expect(child.nextStep).toContain("--worktree current");
    const task = refusal(await spawn(["--role", "worker", "--task", "t1"]));
    expect(task.code).toBe("task_unsupported");
    expect(task.nextStep).toContain("--spec <file>");
    expect(refusal(await spawn(["--role", "worker", ...SPEC, "--task", "t1"])).code).toBe("task_unsupported");
    expect(refusal(await spawn(["--role", "worker", ...SPEC, "--worktree", "elsewhere"])).code).toBe("usage");
    expect(refusal(await spawn(["--role", "worker", ...SPEC, "--prefer", "cursor"])).code).toBe("usage");
    expect(refusal(await spawn(["--role", "code-reviewer", ...SPEC, "--prefer", "codex"])).code).toBe(
      "usage",
    );
    expect(refusal(await spawn(["--role", "worker", ...SPEC, "--deps", "nope"])).code).toBe("usage");
    expect(refusal(await spawn(["--role", "worker"])).code).toBe("usage");
    expect(f.calls).toEqual([]);
    const ok = await spawn(["--role", "worker", ...SPEC, "--prefer", "codex", "--deps", '["task_1"]']);
    expect(JSON.parse(ok.out)).toMatchObject({ ok: true, provider: "codex" });
    expect(starts(f.calls)[0]?.slice(-2)).toEqual(["--deps", '["task_1"]']);
    expect(commandOf(creates(f.calls)[0])).toContain("--sandbox workspace-write");
  });

  test("C3: --prefer names only a provider of the configured workers list (the pilot keeps Codex to review roles, §13.3 c)", async () => {
    const { wt, env } = await spawnWorktree({ workers: ["claude"] });
    const f = fakeOrca();
    const spawn = (args: string[]) => runVerb(wt, ["spawn", ...args], { orca: f.orca, env });
    const codex = refusal(await spawn(["--role", "worker", ...SPEC, "--prefer", "codex"]));
    expect(codex.code).toBe("provider_not_allowed");
    expect(codex.message).toContain("codex");
    expect(f.calls).toEqual([]);
    expect(JSON.parse((await spawn(["--role", "worker", ...SPEC, "--prefer", "claude"])).out)).toMatchObject({
      ok: true,
      provider: "claude",
    });
    expect(JSON.parse((await spawn(["--role", "worker", ...SPEC])).out)).toMatchObject({
      provider: "claude",
    });
    // review roles are not bounded by the workers list: the cross-provider plan verifier is still Codex
    expect(JSON.parse((await spawn(["--role", "plan-verifier", ...SPEC, "--dry-run"])).out)).toMatchObject({
      provider: "codex",
    });
  });

  test("a cross-provider fallback is reported, not silent; with no provider available nothing starts", async () => {
    const { wt, env } = await spawnWorktree();
    const f = fakeOrca({ codex: 95 });
    const review = await runVerb(wt, ["spawn", "--role", "code-reviewer", ...SPEC], { orca: f.orca, env });
    expect(JSON.parse(review.out)).toMatchObject({ ok: true, provider: "claude" });
    expect((JSON.parse(review.out) as { fallback: string }).fallback).toContain("codex unavailable (quota");
    expect(
      (await listIntents(wt)).some(
        (i) => i.kind === "note" && i.payload.text.startsWith("spawn: codex unavailable"),
      ),
    ).toBe(true);
    const none = fakeOrca({ codex: 95, claude: 99 });
    const out = refusal(await runVerb(wt, ["spawn", "--role", "worker", ...SPEC], { orca: none.orca, env }));
    expect(out.code).toBe("provider_unavailable");
    expect(none.calls.map((c) => c[0])).toEqual(["account"]);
  });

  test("a review provider without tier best is model_unresolved (§9.2): the fallback is reported, never a tierless start", async () => {
    const { wt, env } = await spawnWorktree({ tiers: { claude: { model: "c", effort: "max" } } });
    const f = fakeOrca();
    const review = await runVerb(wt, ["spawn", "--role", "code-reviewer", ...SPEC], { orca: f.orca, env });
    const o = JSON.parse(review.out) as { ok: boolean; provider: string; fallback: string };
    expect(o).toMatchObject({ ok: true, provider: "claude" });
    expect(o.fallback).toContain("codex unavailable (model_unresolved");
    expect(commandOf(creates(f.calls)[0])).toContain(" exec claude --model c --effort max --session-id ");
    expect(starts(f.calls)[0]).not.toContain("--model");
    expect(
      (await listIntents(wt)).some(
        (i) => i.kind === "note" && i.payload.text.startsWith("spawn: codex unavailable (model_unresolved"),
      ),
    ).toBe(true);
    // no candidate has a tier → refused before anything starts; workers (tier standard) are unaffected
    const second = await spawnWorktree({ tiers: {} });
    const g = fakeOrca();
    const none = refusal(
      await runVerb(second.wt, ["spawn", "--role", "plan-verifier", ...SPEC], {
        orca: g.orca,
        env: second.env,
      }),
    );
    expect(none.code).toBe("provider_unavailable");
    expect(none.message).toContain("codex model_unresolved");
    expect(none.message).toContain("claude model_unresolved");
    expect(g.calls.map((c) => c[0])).toEqual(["account"]);
    const worker = await runVerb(second.wt, ["spawn", "--role", "worker", ...SPEC], {
      orca: g.orca,
      env: second.env,
    });
    expect(JSON.parse(worker.out)).toMatchObject({ ok: true, provider: "claude" });
  });

  test("after a real installKit: the codex reviewer runs read-only at tier best and a Claude worker gets the kit's worker settings file", async () => {
    const wt = mkdtempSync(join(tmpdir(), "wm-claim-"));
    await run(["git", "init", "-q", wt]);
    await git(wt, "commit", "-q", "--allow-empty", "-m", "init");
    const cfg = await loadConfig("config/projects.yaml");
    const project = cfg.projects.bouncr;
    if (!project) throw new Error("bouncr project missing from config");
    const record = newRecord({
      identifier: "JRF-404",
      linearId: "l",
      project: "bouncr",
      repo: "api",
      provider: "claude",
      autonomy: "ask-first",
      now: "2026-10-06T10:00:00.000Z",
    });
    record.worktree = {
      id: `r::${wt}`,
      path: wt,
      branch: "furoyce/wm-jrf-404",
      baseSha: "abc",
      gitCommonDir: join(wt, ".git"),
      gitdirName: "wm",
    };
    // the dispatcher installs the kit at `<state>/kit/<identifier>`, where spawn looks for it (C1)
    const home = mkdtempSync(join(tmpdir(), "wm-home-"));
    const state = join(home, "state");
    const kitDir = join(state, "kit", "JRF-404");
    await installKit({
      worktreePath: wt,
      kitDir,
      record,
      cfg,
      project,
      issue: {
        identifier: "JRF-404",
        title: "t",
        description: null,
        url: "u",
        comments: [],
        parent: null,
        children: [],
      },
      nonce: "n",
      launch: { model: "c", effort: "max" },
      tiers: { claude: { model: "c", effort: "max" }, codex: { model: "gpt-x", effort: "xhigh" } },
      toolchainPaths: [],
    });
    writeFileSync(join(wt, ".wingmate", "spec.md"), "review the diff");
    const env: Env = { HOME: home, WINGMATE_HOME: state, WINGMATE_ROLE: "coordinator" };
    const f = fakeOrca({ current: { worktree: { id: `r::${wt}`, path: wt } } });
    const spawn = (role: string) => runVerb(wt, ["spawn", "--role", role, ...SPEC], { orca: f.orca, env });
    expect(JSON.parse((await spawn("code-reviewer")).out)).toMatchObject({
      ok: true,
      provider: "codex",
      dispatchId: "ctx_7",
      terminalHandle: "term_1",
    });
    const c = creates(f.calls)[0] ?? [];
    expect(c.slice(0, 4)).toEqual(["terminal", "create", "--worktree", `id:r::${wt}`]);
    expect(commandOf(c)).toBe(
      launchCommand(
        codexArgv({ model: "gpt-x", effort: "xhigh", worktreePath: wt, role: "code-reviewer" }),
        agentEnv(kitDir, "code-reviewer"),
      ),
    );
    expect(starts(f.calls)[0]?.slice(0, 8)).toEqual([
      "orchestration",
      "worker-start",
      "--run",
      "run_new",
      "--worktree",
      `id:r::${wt}`,
      "--terminal",
      "term_1",
    ]);
    expect(JSON.parse((await spawn("worker")).out)).toMatchObject({ ok: true, provider: "claude" });
    const settings = join(kitDir, "claude-settings.worker.json");
    expect(commandOf(creates(f.calls)[1])).toContain(` --settings ${settings} --strict-mcp-config`);
    const workerDeny = (JSON.parse(readFileSync(settings, "utf8")) as { permissions: { deny: string[] } })
      .permissions.deny;
    expect(workerDeny).toContain("Bash(orca orchestration worker-start *)");
    expect(workerDeny).toContain("Bash(wingmate issue * spawn*)"); // C2: a worker never spawns
    for (const s of starts(f.calls))
      for (const flag of ["--agent", "--model", "--effort"]) expect(s).not.toContain(flag);
  });

  test("C1: the kit dir is derived from the state root and the identifier; a launch.json naming another kit or a role settings file that resolves elsewhere is refused", async () => {
    const s = await spawnWorktree();
    const f = fakeOrca();
    const spawn = (role = "worker") =>
      runVerb(s.wt, ["spawn", "--role", role, ...SPEC], { orca: f.orca, env: s.env });
    // launch.json is agent-writable: pointing it at a kit the agent prepared is refused, never followed
    const evil = join(s.home, "evil-kit");
    mkdirSync(evil, { recursive: true });
    for (const role of SPAWN_ROLES) writeFileSync(roleSettingsFile(evil, role), "{}\n");
    const good = launchFor(s.wt, {
      kitDir: s.kit,
      roleSettings: roleSettingsFiles(s.kit),
      tiers: { codex: { model: "gpt-x", effort: "xhigh" }, claude: { model: "c", effort: "max" } },
    });
    await sealLaunch(s.wt, { ...good, kitDir: evil, roleSettings: roleSettingsFiles(evil) });
    const other = refusal(await spawn());
    expect(other.code).toBe("kit_path_invalid");
    expect(other.message).toContain(s.kit);
    await sealLaunch(s.wt, {
      ...good,
      roleSettings: { ...good.roleSettings, worker: roleSettingsFile(evil, "worker") },
    });
    expect(refusal(await spawn()).code).toBe("kit_path_invalid");
    await sealLaunch(s.wt, good);
    // a role file that is a symlink — out of the kit, or to another role's file in it — or that is missing is refused
    const workerFile = roleSettingsFile(s.kit, "worker");
    rmSync(workerFile);
    symlinkSync(join(evil, "claude-settings.worker.json"), workerFile);
    expect(refusal(await spawn()).code).toBe("kit_path_invalid");
    rmSync(workerFile);
    symlinkSync(roleSettingsFile(s.kit, "code-reviewer"), workerFile);
    expect(refusal(await spawn()).code).toBe("kit_path_invalid");
    rmSync(workerFile);
    const missing = refusal(await spawn());
    expect(missing.code).toBe("kit_path_invalid");
    expect(missing.message).toContain("claude-settings.worker.json");
    expect(f.calls).toEqual([]);
    // with the role's own regular file back, the kit spawn derived is the one the agent is launched with
    writeFileSync(workerFile, "{}\n");
    expect(JSON.parse((await spawn()).out)).toMatchObject({ ok: true, provider: "claude" });
    expect(commandOf(creates(f.calls)[0])).toContain(`GIT_CONFIG_GLOBAL=${join(s.kit, "gitconfig")} `);
    expect(commandOf(creates(f.calls)[0])).toContain(` --settings ${workerFile} `);
    // a record whose identifier is not an identifier never becomes a path (the id is optional on the command line)
    const local = await readLocal(s.wt);
    local.record.identifier = "../evil";
    await writeLocal(s.wt, local);
    const g = fakeOrca();
    const bad = refusal(
      await capture(() =>
        issueCommand(parseArgv(["issue", "spawn", "--role", "worker", ...SPEC]), {
          cwd: s.wt,
          orca: g.orca,
          env: s.env,
        }),
      ),
    );
    expect(bad.code).toBe("kit_path_invalid");
    expect(g.calls).toEqual([]);
  });

  test("C1: the worktree a role agent starts in is the one Orca resolves from the issue worktree; a launch.json naming another is refused", async () => {
    const { wt, env } = await spawnWorktree();
    const spawn = (orca: ReturnType<typeof fakeOrca>["orca"]) =>
      runVerb(wt, ["spawn", "--role", "plan-verifier", ...SPEC], { orca, env });
    const other = fakeOrca({
      current: { worktree: { id: "repo1::/wt/wm-jrf-999", path: "/wt/wm-jrf-999" } },
    });
    const r = refusal(await spawn(other.orca));
    expect(r.code).toBe("worktree_mismatch");
    expect(r.message).toContain("repo1::/wt/wm-jrf-999");
    expect(r.message).toContain(WT_ID);
    expect(other.calls).toEqual([
      ["account", "list"],
      ["worktree", "current"],
    ]); // no Run, no terminal
    expect(other.cwds).toEqual([wt]);
    const garbled = fakeOrca({ current: { id: WT_ID } });
    expect(refusal(await spawn(garbled.orca)).code).toBe("orca_shape");
    expect(creates(garbled.calls)).toEqual([]);
  });

  test("C2: only the coordinator spawns (WINGMATE_ROLE); the role agents it launches carry their own role", async () => {
    const { wt, kit, env } = await spawnWorktree();
    const f = fakeOrca();
    const spawn = (e: Env) => runVerb(wt, ["spawn", "--role", "worker", ...SPEC], { orca: f.orca, env: e });
    const { WINGMATE_ROLE: _role, ...unset } = env;
    for (const e of [
      unset,
      { ...env, WINGMATE_ROLE: "worker" },
      { ...env, WINGMATE_ROLE: "plan-verifier" },
    ]) {
      const r = refusal(await spawn(e));
      expect(r.code).toBe("role_not_allowed");
    }
    expect(f.calls).toEqual([]);
    expect(JSON.parse((await spawn(env)).out)).toMatchObject({ ok: true });
    const cmd = commandOf(creates(f.calls)[0]);
    expect(cmd).toContain(" WINGMATE_ROLE=worker exec claude ");
    expect(agentEnv(kit, "worker").WINGMATE_ROLE).toBe("worker");
  });

  test("a tampered kit and a missing runner are refused; a failed or unparsed worker-start leaves the possibly bound terminal alone", async () => {
    const { wt, kit, env } = await spawnWorktree();
    const f = fakeOrca();
    writeFileSync(
      join(wt, ".wingmate", "launch.json"),
      JSON.stringify(
        launchFor(wt, { kitDir: kit, roleSettings: roleSettingsFiles(kit), verifyCross: false }),
      ),
    );
    const tampered = refusal(
      await runVerb(wt, ["spawn", "--role", "worker", ...SPEC], { orca: f.orca, env }),
    );
    expect(tampered.code).toBe("kit_tampered");
    expect(tampered.message).toContain(".wingmate/launch.json");
    expect(f.calls).toEqual([]);
    const second = await spawnWorktree();
    const spawn2 = (orca?: ReturnType<typeof fakeOrca>["orca"]) =>
      runVerb(second.wt, ["spawn", "--role", "worker", ...SPEC], orca ? { orca, env: second.env } : {});
    expect(refusal(await spawn2()).code).toBe("orca_unavailable");
    const g = fakeOrca({ receipt: { status: "ready" } });
    const unparsed = refusal(await spawn2(g.orca));
    expect(unparsed.code).toBe("spawn_receipt_unparsed");
    expect(unparsed.message).toContain("term_1");
    expect(unparsed.nextStep).toContain("worker-list --run run_new");
    const h = fakeOrca({ startError: new OrcaError("invalid_argument", "Unknown flag: --frob") });
    const failed = refusal(await spawn2(h.orca));
    expect(failed.code).toBe("spawn_unconfirmed");
    expect(failed.message).toContain("term_1");
    expect(failed.message).toContain("invalid_argument");
    expect(failed.nextStep).toContain("worker-list --run run_new");
    for (const calls of [g.calls, h.calls]) expect(closes(calls)).toEqual([]);
  });
});
