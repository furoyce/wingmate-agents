import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { type IssueDeps, issueCommand } from "../../../src/cli/commands/issue";
import { parseArgv } from "../../../src/cli/index";
import { loadConfig } from "../../../src/config/load";
import { installKit, integrityHashes } from "../../../src/kit/install";
import { listIntents } from "../../../src/kit/intents";
import { type Launch, type Local, readLocal, writeLocal } from "../../../src/kit/local";
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
const launchFor = (wt: string, over: Partial<Launch> = {}): Launch => ({
  provider: "claude",
  model: "m",
  effort: "max",
  kitDir: "/k",
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
    const show = JSON.parse((await runVerb(wt, ["show"])).out) as { pendingIntents: { kind: string }[] };
    expect(show.pendingIntents.map((p) => p.kind)).toEqual(kinds);
    expect((await readLocal(wt)).run).toEqual({ childRunId: "run_1" });
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
});

describe("wingmate issue spawn", () => {
  async function spawnWorktree(over: Partial<Launch> = {}) {
    const wt = await worktree({ git: true });
    writeFileSync(join(wt, ".wingmate", "spec.md"), "verify the plan");
    writeLaunch(wt, {
      tiers: { codex: { model: "gpt-x", effort: "xhigh" }, claude: { model: "c", effort: "max" } },
      ...over,
    });
    const hashes = await integrityHashes(wt, join(wt, ".git"));
    writeFileSync(
      join(wt, ".wingmate", "integrity.json"),
      JSON.stringify({ commonDir: join(wt, ".git"), hashes }),
    );
    return wt;
  }
  function fakeOrca(opts: { claude?: number; codex?: number; receipt?: unknown } = {}) {
    const calls: string[][] = [];
    const window = (used: number) => ({ usedPercent: used, windowMinutes: 10080, resetsAt: null });
    const exec = async (args: string[]): Promise<unknown> => {
      calls.push(args);
      if (args[0] === "account")
        return {
          rateLimits: {
            claude: { status: "ok", weekly: window(opts.claude ?? 10), updatedAt: Date.now() },
            codex: { status: "ok", weekly: window(opts.codex ?? 10), updatedAt: Date.now() },
          },
        };
      if (args[1] === "run-create") return { run: { id: "run_new" } };
      if (args[1] === "worker-start")
        return opts.receipt ?? { worker: { dispatchId: "ctx_7", taskId: "task_7" } };
      throw new Error(`unexpected orca ${args.join(" ")}`);
    };
    return { calls, orca: { workerList: async () => [], exec } };
  }

  test("reviewers go to the other provider at tier best; the run is created once; the real binary is never called", async () => {
    const wt = await spawnWorktree();
    const f = fakeOrca();
    const spawn = (args: string[]) => runVerb(wt, ["spawn", ...args], { orca: f.orca });
    const dry = await spawn(["--role", "plan-verifier", "--spec", ".wingmate/spec.md", "--dry-run"]);
    expect(JSON.parse(dry.out)).toEqual({
      ok: true,
      dryRun: true,
      provider: "codex",
      tier: { model: "gpt-x", effort: "xhigh" },
    });
    const real = await spawn(["--role", "plan-verifier", "--spec", ".wingmate/spec.md"]);
    expect(JSON.parse(real.out)).toEqual({
      ok: true,
      provider: "codex",
      dispatchId: "ctx_7",
      taskId: "task_7",
      runId: "run_new",
    });
    const ws = f.calls.find((c) => c[1] === "worker-start") ?? [];
    expect(ws).toEqual([
      "orchestration",
      "worker-start",
      "--run",
      "run_new",
      "--worktree",
      "current",
      "--agent",
      "codex",
      "--spec",
      "Role: plan-verifier for JRF-404. Read .wingmate/prompts/planVerifier.md first.\n\nverify the plan",
      "--task-title",
      "JRF-404 plan-verifier",
      "--model",
      "gpt-x",
      "--effort",
      "xhigh",
    ]);
    expect((await listIntents(wt)).some((i) => i.kind === "run" && i.payload.runId === "run_new")).toBe(true);
    expect((await readLocal(wt)).run).toEqual({ childRunId: "run_new" });
    const worker = await spawn([
      "--role",
      "worker",
      "--spec",
      ".wingmate/spec.md",
      "--worktree",
      "new-child",
    ]);
    expect(JSON.parse(worker.out)).toMatchObject({ ok: true, provider: "claude", runId: "run_new" });
    const ws2 = f.calls.filter((c) => c[1] === "worker-start").at(-1) ?? [];
    expect(ws2).not.toContain("--model"); // workers run at tier standard (provider default)
    expect(ws2[ws2.indexOf("--name") + 1]).toMatch(/^wm-jrf-404-worker-[0-9a-z]{4}$/);
    expect(f.calls.filter((c) => c[1] === "run-create").length).toBe(1);
  });

  test("--task maps to worker-start --task; a cross-provider fallback is reported, not silent", async () => {
    const wt = await spawnWorktree();
    const f = fakeOrca({ codex: 95 });
    const spawn = (args: string[]) => runVerb(wt, ["spawn", ...args], { orca: f.orca });
    expect(
      refusal(await spawn(["--role", "worker", "--spec", ".wingmate/spec.md", "--task", "t1"])).code,
    ).toBe("usage");
    expect(refusal(await spawn(["--role", "worker", "--task", "t1", "--deps", '["t0"]'])).code).toBe("usage");
    expect(
      refusal(await spawn(["--role", "code-reviewer", "--spec", ".wingmate/spec.md", "--prefer", "codex"]))
        .code,
    ).toBe("usage");
    const task = await spawn(["--role", "worker", "--task", "t1"]);
    expect(JSON.parse(task.out)).toMatchObject({ ok: true, provider: "claude" });
    const ws = f.calls.find((c) => c[1] === "worker-start") ?? [];
    expect(ws).toContain("--task");
    expect(ws).not.toContain("--spec");
    const review = await spawn(["--role", "code-reviewer", "--spec", ".wingmate/spec.md"]);
    expect(JSON.parse(review.out)).toMatchObject({ ok: true, provider: "claude" });
    expect((JSON.parse(review.out) as { fallback: string }).fallback).toContain("codex unavailable (quota");
    expect(
      (await listIntents(wt)).some(
        (i) => i.kind === "note" && i.payload.text.startsWith("spawn: codex unavailable"),
      ),
    ).toBe(true);
    const none = fakeOrca({ codex: 95, claude: 99 });
    const out = refusal(
      await runVerb(wt, ["spawn", "--role", "worker", "--spec", ".wingmate/spec.md"], { orca: none.orca }),
    );
    expect(out.code).toBe("provider_unavailable");
    expect(none.calls.map((c) => c[0])).toEqual(["account"]);
  });

  test("a review provider without tier best is model_unresolved (§9.2): the fallback is reported, never a tierless start", async () => {
    const wt = await spawnWorktree({ tiers: { claude: { model: "c", effort: "max" } } });
    const f = fakeOrca();
    const review = await runVerb(wt, ["spawn", "--role", "code-reviewer", "--spec", ".wingmate/spec.md"], {
      orca: f.orca,
    });
    const o = JSON.parse(review.out) as { ok: boolean; provider: string; fallback: string };
    expect(o).toMatchObject({ ok: true, provider: "claude" });
    expect(o.fallback).toContain("codex unavailable (model_unresolved");
    const ws = f.calls.find((c) => c[1] === "worker-start") ?? [];
    expect(ws.slice(ws.indexOf("--model"))).toEqual(["--model", "c", "--effort", "max"]);
    expect(
      (await listIntents(wt)).some(
        (i) => i.kind === "note" && i.payload.text.startsWith("spawn: codex unavailable (model_unresolved"),
      ),
    ).toBe(true);
    // no candidate has a tier → refused before anything starts; workers (tier standard) are unaffected
    const wt2 = await spawnWorktree({ tiers: {} });
    const g = fakeOrca();
    const none = refusal(
      await runVerb(wt2, ["spawn", "--role", "plan-verifier", "--spec", ".wingmate/spec.md"], {
        orca: g.orca,
      }),
    );
    expect(none.code).toBe("provider_unavailable");
    expect(none.message).toContain("codex model_unresolved");
    expect(none.message).toContain("claude model_unresolved");
    expect(g.calls.map((c) => c[0])).toEqual(["account"]);
    const worker = await runVerb(wt2, ["spawn", "--role", "worker", "--spec", ".wingmate/spec.md"], {
      orca: g.orca,
    });
    expect(JSON.parse(worker.out)).toMatchObject({ ok: true, provider: "claude" });
  });

  test("spawn applies the tier best installKit resolved at claim: the codex reviewer's argv carries --model and --effort", async () => {
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
    await installKit({
      worktreePath: wt,
      kitDir: mkdtempSync(join(tmpdir(), "wm-kit-")),
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
    const f = fakeOrca();
    const res = await runVerb(wt, ["spawn", "--role", "code-reviewer", "--spec", ".wingmate/spec.md"], {
      orca: f.orca,
    });
    expect(JSON.parse(res.out)).toMatchObject({ ok: true, provider: "codex", dispatchId: "ctx_7" });
    const ws = f.calls.find((c) => c[1] === "worker-start") ?? [];
    expect(ws.slice(ws.indexOf("--agent"), ws.indexOf("--agent") + 2)).toEqual(["--agent", "codex"]);
    expect(ws.slice(ws.indexOf("--model"))).toEqual(["--model", "gpt-x", "--effort", "xhigh"]);
  });

  test("a tampered kit, a missing runner and an unparsed receipt are refused", async () => {
    const wt = await spawnWorktree();
    const f = fakeOrca();
    writeFileSync(
      join(wt, ".wingmate", "launch.json"),
      JSON.stringify(launchFor(wt, { verifyCross: false })),
    );
    const tampered = refusal(
      await runVerb(wt, ["spawn", "--role", "worker", "--spec", ".wingmate/spec.md"], { orca: f.orca }),
    );
    expect(tampered.code).toBe("kit_tampered");
    expect(tampered.message).toContain(".wingmate/launch.json");
    expect(f.calls).toEqual([]);
    const wt2 = await spawnWorktree();
    expect(
      refusal(await runVerb(wt2, ["spawn", "--role", "worker", "--spec", ".wingmate/spec.md"])).code,
    ).toBe("orca_unavailable");
    const g = fakeOrca({ receipt: { status: "ready" } });
    const unparsed = refusal(
      await runVerb(wt2, ["spawn", "--role", "worker", "--spec", ".wingmate/spec.md"], { orca: g.orca }),
    );
    expect(unparsed.code).toBe("spawn_receipt_unparsed");
    expect(unparsed.nextStep).toContain("worker-list --run run_new");
  });
});
