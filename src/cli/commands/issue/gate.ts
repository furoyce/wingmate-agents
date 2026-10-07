// src/cli/commands/issue/gate.ts — `wingmate issue <id> gate <stage>` (§8.1): order enforced, judgment gates need evidence,
// validate/security are computed by the CLI, and proven verdicts of validate/security/ui go STALE once HEAD moves.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { GitCli } from "../../../git/cli";
import { parseAddedLines } from "../../../git/diff";
import { writeIntent } from "../../../kit/intents";
import {
  type Launch,
  type Local,
  readLaunch,
  worktreeFile,
  writeLocal,
  writeStage,
} from "../../../kit/local";
import { depsPolicy } from "../../../policy/deps";
import { violations } from "../../../policy/pathguard";
import { type Finding, scanAddedLines, scanText } from "../../../policy/secrets";
import type { BranchHistory } from "../../../ports";
import { errorCode } from "../../../shared/errors";
import { type RunResult, run } from "../../../shared/exec";
import { writeAtomic } from "../../../state/fs";
import type { Argv } from "../../index";
import type { Out, Refuse } from "../issue";

const ORDER = ["intake", "plan", "planVerify", "implement", "validate", "ui", "security", "pr"] as const;
type Stage = (typeof ORDER)[number];
type Deps = { cwd: string; local: Local; id: string; refuse: Refuse; out: Out };
const HEAD_BOUND = ["validate", "security", "ui"] as const;
const EMPTY = {
  verdict: null,
  failCount: 0,
  at: null,
  evidencePath: null,
  headSha: null,
  note: null,
  method: null,
  dispatchId: null,
};

/** `git rev-parse HEAD`, or null outside a repository or before the first commit. */
export async function gitHead(cwd: string): Promise<string | null> {
  const r = await run(["git", "rev-parse", "--verify", "-q", "HEAD"], { cwd, timeoutMs: 30_000 });
  return r.code === 0 ? r.stdout.trim() || null : null;
}

/** The diff base: launch.json's claim-time `baseSha` (§8.1), else the merge-base with origin/HEAD; null when neither resolves. */
export async function diffBase(cwd: string, launch: Launch): Promise<string | null> {
  if (launch.baseSha) {
    const r = await run(["git", "cat-file", "-e", `${launch.baseSha}^{commit}`], { cwd, timeoutMs: 30_000 });
    if (r.code === 0) return launch.baseSha;
  }
  const mb = await run(["git", "merge-base", "HEAD", "origin/HEAD"], { cwd, timeoutMs: 30_000 });
  return mb.code === 0 ? mb.stdout.trim() || null : null;
}

/** Paths changed between `base` and HEAD (committed work only — that is what the dispatcher publishes); null when git fails. */
export async function changedNames(cwd: string, base: string): Promise<string[] | null> {
  const r = await run(["git", "diff", "--name-only", "-z", "--diff-filter=ACMRD", `${base}...HEAD`], {
    cwd,
    timeoutMs: 60_000,
  });
  return r.code === 0 ? r.stdout.split("\0").filter(Boolean) : null;
}

export { parseAddedLines };

const passed = (local: Local, s: string) => ["PASS", "NA"].includes(local.gates[s]?.verdict ?? "");

/**
 * §8.1: a PASS of validate/security/ui recorded at another HEAD is STALE. A ui NA is too: it was proven ("no UI path changed")
 * against that HEAD, and publish (Task 11) does not re-check ui. Returns whether anything changed.
 */
export function markStale(local: Local, head: string | null): boolean {
  if (!head) return false;
  let changed = false;
  for (const s of HEAD_BOUND) {
    const g = local.gates[s];
    const proven = g?.verdict === "PASS" || (s === "ui" && g?.verdict === "NA");
    if (g && proven && g.headSha !== head) {
      g.verdict = "STALE";
      changed = true;
    }
  }
  return changed;
}

const tail = (s: string, n: number) =>
  s
    .slice(-n)
    .split("\n")
    .map((l) => `| ${l}`)
    .join("\n");

/** Runs every pinned command (argv, no shell, 30 min each). Output is prefixed with `| ` so only our own lines start with `exit `. */
async function validateReport(cwd: string, launch: Launch): Promise<{ ok: boolean; lines: string[] }> {
  if (!launch.pinnedGates.length) return { ok: false, lines: ["no pinned gates in launch.json"] };
  const lines: string[] = [];
  let ok = true;
  for (const cmd of launch.pinnedGates) {
    let r: RunResult;
    try {
      r = await run(cmd, { cwd, timeoutMs: 30 * 60_000 });
    } catch (e) {
      r = { code: 127, stdout: "", stderr: (e as Error).message, timedOut: false };
    }
    const digest = createHash("sha256").update(r.stdout).update("\0").update(r.stderr).digest("hex");
    lines.push(
      `$ ${cmd.join(" ")}`,
      `exit ${r.code}${r.timedOut ? " (timeout)" : ""}`,
      `sha256 ${digest}`,
      tail(r.stdout, 4000),
      tail(r.stderr, 2000),
    );
    if (r.code !== 0) ok = false;
  }
  return { ok, lines };
}

const IN_HISTORY = " (in the branch history)";
/** F4: with every secret or path finding — the commit that made it is pushed too, also once a later commit removed it from HEAD. */
const REWRITE =
  "history: the push sends every commit since the base, so do not commit a fix on top: rewrite the unpushed commits (amend or squash them) until none of them contains a finding";

/**
 * Secret scan over added lines, path guard and dependency policy over the committed diff from the base (§8.2 stage 6); the secret
 * scan and the path guard also over every commit since the base and its message, read as publish reads them (F3, F4), so a fix
 * committed on top fails here as it would be refused there.
 */
async function securityReport(cwd: string, launch: Launch): Promise<{ ok: boolean; lines: string[] }> {
  const base = await diffBase(cwd, launch);
  if (!base)
    return {
      ok: false,
      lines: ["diff: unavailable (no baseSha in launch.json, no merge-base with origin/HEAD)"],
    };
  const names = await changedNames(cwd, base);
  const diff = await run(["git", "diff", "--no-ext-diff", "--no-color", "--unified=0", `${base}...HEAD`], {
    cwd,
    timeoutMs: 120_000,
  });
  if (names === null || diff.code !== 0)
    return { ok: false, lines: [`diff: git diff ${base}...HEAD failed`] };
  let history: BranchHistory;
  try {
    history = await new GitCli().historyChanges(cwd, base, "HEAD");
  } catch (e) {
    return { ok: false, lines: [`diff: git log ${base}..HEAD failed (${errorCode(e)})`] };
  }
  const place = (s: Finding) => `${s.pattern} ${s.path ?? ""}`; // never the matched text
  const head = scanAddedLines(parseAddedLines(diff.stdout)).map(place);
  const shown = new Set(head);
  const earlier = [...new Set(scanAddedLines(history.added).map(place))].filter((p) => !shown.has(p));
  const messages = [...new Set(scanText(history.messages).map((s) => s.pattern))];
  const secrets = [
    ...head,
    ...earlier.map((p) => `${p}${IN_HISTORY}`),
    ...messages.map((p) => `${p} (in a commit message)`),
  ];
  const atHead = new Set(names);
  const vio = violations([...new Set([...names, ...history.paths])], launch.forbiddenPaths);
  const deps = depsPolicy(names, launch.allowDeps);
  return {
    ok: !secrets.length && !vio.length && deps.ok,
    lines: [
      `base: ${base}`,
      `changed: ${names.length}`,
      `secrets: ${secrets.length}`,
      ...secrets.map((s) => `  ${s}`),
      `pathguard: ${vio.length}`,
      ...vio.map((v) => `  ${v.path} ~ ${v.pattern}${atHead.has(v.path) ? "" : IN_HISTORY}`),
      `deps: ${deps.ok ? "ok" : deps.reason}`,
      ...(secrets.length || vio.length ? [REWRITE] : []),
    ],
  };
}

type Judged = { verdict: "PASS" | "FAIL" | "NA"; evidencePath: string | null } | { refused: number };

async function judge(argv: Argv, d: Deps, stage: Stage, failCount: number): Promise<Judged> {
  const f = (k: string) => (typeof argv.flags[k] === "string" ? (argv.flags[k] as string) : null);
  const v = f("verdict");
  if (v !== "PASS" && v !== "FAIL" && v !== "NA")
    return { refused: d.refuse("usage", `gate ${stage} --verdict PASS|FAIL|NA --evidence <path>`) };
  if (v === "NA" && stage !== "ui")
    return {
      refused: d.refuse(
        "verdict_not_allowed",
        `NA applies only to ui; ${stage} needs PASS or FAIL with evidence`,
      ),
    };
  if (stage === "intake" && f("method") === null)
    return { refused: d.refuse("method_required", "gate intake needs --method loop|graph") };
  if (stage === "planVerify" && !f("dispatch"))
    return {
      refused: d.refuse("dispatch_required", "gate planVerify needs --dispatch <id> of the verifier"),
    };
  if (failCount >= 2 && v === "FAIL")
    return {
      refused: d.refuse(
        "gate_retry_exhausted",
        `${stage} failed twice already`,
        `wingmate issue ${d.id} ask --question-file <path> --options a,b --recommend a`,
      ),
    };
  if (v === "NA") {
    const launch = await readLaunch(d.cwd);
    const base = await diffBase(d.cwd, launch);
    const names = base ? await changedNames(d.cwd, base) : null;
    if (names === null)
      return {
        refused: d.refuse("diff_unavailable", "cannot diff from the base SHA to prove no UI path changed"),
      };
    if (names.some((n) => launch.ui.paths.some((p) => n.startsWith(p))))
      return {
        refused: d.refuse(
          "ui_changed",
          "UI paths changed; run ui-smoke and gate with PASS/FAIL",
          `wingmate issue ${d.id} ui-smoke --recipe <file>`,
        ),
      };
    return { verdict: v, evidencePath: null };
  }
  const evidence = f("evidence");
  if (!evidence)
    return { refused: d.refuse("evidence_required", "--evidence <existing file under .wingmate/evidence>") };
  const ev = await worktreeFile(d.cwd, evidence, ".wingmate/evidence");
  if (!ev.ok) return { refused: d.refuse("evidence_invalid", ev.error) };
  return { verdict: v, evidencePath: ev.rel };
}

export async function gateVerb(argv: Argv, d: Deps): Promise<number> {
  const stage = argv.cmd[3] as Stage | undefined;
  if (!stage || !ORDER.includes(stage) || stage === "pr")
    return d.refuse("usage", "gate <intake|plan|planVerify|implement|validate|ui|security> …");
  const f = (k: string) => (typeof argv.flags[k] === "string" ? (argv.flags[k] as string) : null);
  const computed = stage === "validate" || stage === "security";
  if (computed && argv.flags.verdict !== undefined)
    return d.refuse(
      "verdict_not_allowed",
      `${stage} is computed by the CLI`,
      `wingmate issue ${d.id} gate ${stage}`,
    );
  const method = f("method");
  if (method !== null && method !== "loop" && method !== "graph")
    return d.refuse("usage", "--method loop|graph");
  const head = await gitHead(d.cwd);
  if (markStale(d.local, head)) await writeLocal(d.cwd, d.local);
  const idx = ORDER.indexOf(stage);
  const missing = ORDER.slice(0, idx).filter((s) => !passed(d.local, s));
  if (missing.length)
    return d.refuse(
      "stage_prerequisite",
      `earlier stages not passed: ${missing.map((s) => (d.local.gates[s]?.verdict === "STALE" ? `${s} (stale)` : s)).join(", ")}`,
      `wingmate issue ${d.id} gate ${missing[0]} …`,
    );
  const g = d.local.gates[stage] ?? EMPTY;
  let verdict: "PASS" | "FAIL" | "NA";
  let evidencePath: string | null;
  let note = f("note");
  if (computed) {
    const launch = await readLaunch(d.cwd);
    const res =
      stage === "validate" ? await validateReport(d.cwd, launch) : await securityReport(d.cwd, launch);
    evidencePath = join(".wingmate", "evidence", stage, "report.txt");
    await writeAtomic(join(d.cwd, evidencePath), `${res.lines.join("\n")}\n`);
    verdict = res.ok ? "PASS" : "FAIL";
    note = res.ok ? null : `${stage} computed FAIL`;
    if (verdict === "FAIL" && g.failCount >= 2)
      return d.refuse(
        "gate_retry_exhausted",
        `${stage} computed FAIL a third time (report: ${evidencePath})`,
        `wingmate issue ${d.id} ask --question-file <path> --options a,b --recommend a`,
      );
  } else {
    const j = await judge(argv, d, stage, g.failCount);
    if ("refused" in j) return j.refused;
    verdict = j.verdict;
    evidencePath = j.evidencePath;
  }
  const dispatchId = f("dispatch");
  d.local.gates[stage] = {
    verdict,
    failCount: g.failCount + (verdict === "FAIL" ? 1 : 0),
    at: new Date().toISOString(),
    evidencePath,
    headSha: head,
    note,
    method: method ?? g.method,
    dispatchId,
  };
  if (verdict !== "FAIL") d.local.record.pipelineStage = ORDER[Math.min(idx + 1, ORDER.length - 1)] as string;
  await writeLocal(d.cwd, d.local);
  await writeStage(d.cwd, { pipelineStage: d.local.record.pipelineStage, via: "gate" });
  await writeIntent(d.cwd, {
    issue: d.id,
    kind: "gate",
    payload: { stage, verdict, evidencePath, note, method, headSha: head, dispatchId },
  });
  const failCount = d.local.gates[stage]?.failCount ?? 0;
  d.out({
    ok: true,
    stage,
    verdict,
    failCount,
    ...(verdict === "FAIL" && failCount >= 2
      ? { next: `ask required before another attempt: wingmate issue ${d.id} ask …` }
      : {}),
  });
  return 0;
}
