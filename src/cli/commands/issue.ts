// src/cli/commands/issue.ts — the agent-facing verbs (§8.1). They read and write only <worktree>/.wingmate/ and perform no Linear
// or GitHub write (§13.3 a, D17); Orca is reached only for `spawn`, `ui-smoke` and the read-only `workers_live` check. Every
// refusal prints `{ ok:false, code, message, nextStep }` and exits 2.
import { join } from "node:path";
import { consumeIntent, listIntents, writeIntent } from "../../kit/intents";
import { type Local, readLaunch, readLocal, worktreeFile, writeLocal, writeStage } from "../../kit/local";
import { dispatcherMode, readRoleJobs } from "../../kit/roles";
import { OrcaError, orca } from "../../orca/cli";
import { OrcaClient } from "../../orca/client";
import { scanText } from "../../policy/secrets";
import type { WorkerRow } from "../../ports";
import { WingmateError } from "../../shared/errors";
import { run } from "../../shared/exec";
import { IDENTIFIER_RE } from "../../shared/ids";
import { readText } from "../../state/fs";
import { rolePending } from "../../state/roles";
import type { Argv } from "../index";
import { gateVerb, gitHead, markStale } from "./issue/gate";
import { requestNativeUi } from "./issue/nativeUi";
import { spawnVerb } from "./issue/spawn";
import { readAgentContext, uiSmoke } from "./issue/uiSmoke";

/** Signature of `orca()`, the envelope runner behind `spawn` and `ui-smoke`. */
export type OrcaExec = typeof orca;
export type Env = Record<string, string | undefined>;
export interface IssueDeps {
  cwd?: string;
  /** The process environment (absent → `process.env`): `spawn` reads WINGMATE_ROLE and derives the kit dir from `homeDirs()`. */
  env?: Env;
  /**
   * Orca access. Absent → the real Orca. Injected (tests) → exactly what is given, never the real binary: `workerList` backs the
   * `workers_live` check of `ask`/`finish`; `exec` runs the Orca verbs of `spawn` (`account list`, `run-create`, `terminal
   * create|wait|send|close`, `worker-start`) and `ui-smoke` (browser verbs); `agentContext` reads `orca agent-context --json`. A
   * missing member refuses `orca_unavailable`.
   */
  orca?: {
    workerList(runId: string): Promise<WorkerRow[]>;
    exec?: OrcaExec;
    agentContext?: () => Promise<unknown>;
  };
}
export type Refuse = (code: string, message: string, nextStep?: string) => number;
export type Out = (o: unknown) => void;
type Ctx = {
  argv: Argv;
  cwd: string;
  local: Local;
  id: string;
  orca: NonNullable<IssueDeps["orca"]>;
  env: Env;
};

const out: Out = (o) => {
  process.stdout.write(`${JSON.stringify(o)}\n`);
};
const refuse: Refuse = (code, message, nextStep) => {
  out({ ok: false, code, message, nextStep: nextStep ?? null });
  return 2;
};
const flag = (a: Argv, k: string): string | null =>
  typeof a.flags[k] === "string" ? (a.flags[k] as string) : null;
const FINISH_GATES = ["intake", "plan", "planVerify", "implement", "validate", "ui", "security"];
/** Flags a verb accepts more than once (§8.1: `finish … [--repo <name>]…`); any other repeated flag is refused. */
const REPEATABLE: Record<string, string[]> = { finish: ["repo"] };
const END_TURN = "END YOUR TURN NOW";
const USAGE = "issue [<id>] gate|ask|note|spawn|run|finish|handoff|followup|ui-smoke|show|log …";

const realOrca = (): NonNullable<IssueDeps["orca"]> => {
  const client = new OrcaClient();
  return { workerList: (runId) => client.workerList(runId), exec: orca, agentContext: readAgentContext };
};
const noRunner = (verb: string) =>
  refuse(
    "orca_unavailable",
    `no Orca runner is configured for ${verb}`,
    "run the verb from the issue worktree's terminal",
  );

async function workersLive(c: Ctx): Promise<string[]> {
  if (await dispatcherMode(c.cwd))
    return [
      ...(await readRoleJobs(c.cwd)).filter(rolePending).map((j) => j.id),
      ...(await listIntents(c.cwd))
        .filter((i) => i.kind === "spawn" || i.kind === "native-ui")
        .map((i) => i.id),
    ];
  const runId = c.local.run?.childRunId ?? c.local.record.childRunId;
  if (!runId) return [];
  return (await c.orca.workerList(runId)).filter((w) => w.verdict === "live").map((w) => w.dispatchId);
}

/** The text of an agent-named file the dispatcher will post to Linear: validated, then secret-scanned here for fast feedback. */
async function postable(c: Ctx, path: string): Promise<{ rel: string } | { refused: number }> {
  const file = await worktreeFile(c.cwd, path);
  if (!file.ok)
    return { refused: refuse("file_invalid", file.error, "write the text to a file under .wingmate/ first") };
  if (scanText((await readText(file.abs)) ?? "").length)
    return {
      refused: refuse("secret_detected", `${file.rel} contains a secret-like token`, "remove it and retry"),
    };
  return { rel: file.rel };
}

async function askVerb(c: Ctx): Promise<number> {
  const qf = flag(c.argv, "question-file");
  const append = flag(c.argv, "append");
  const reask = flag(c.argv, "reask");
  if (!qf || (append && reask))
    return refuse(
      "usage",
      "ask --question-file <path> [--options a,b,c] [--recommend b] [--append <qid> | --reask <qid>]",
    );
  const live = await workersLive(c);
  if (live.length)
    return refuse(
      "workers_live",
      `settle or stop workers first: ${live.join(",")}`,
      "orca orchestration check --wait … or worker-stop",
    );
  const target = append ?? reask;
  const known = target ? c.local.questions.find((q) => q.id === target) : undefined;
  if (target && !known)
    return refuse("unknown_question", `no question ${target} in .wingmate/questions.json`);
  // the hints are the exact commands `ask` accepts: it needs --question-file with --append/--reask too (F12)
  const hint = (mode: "append" | "reask", qid: string) =>
    `wingmate issue ${c.id} ask --${mode} ${qid} --question-file <path>`;
  if (append && known?.status !== "open")
    return refuse(
      "question_not_open",
      `question ${append} is ${known?.status ?? "unknown"}`,
      hint("reask", append),
    );
  const open = c.local.questions.find((q) => q.status === "open");
  if (open && open.id !== target)
    return refuse("question_open", `question ${open.id} is unanswered`, hint("append", open.id));
  const options = (flag(c.argv, "options") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const rec = flag(c.argv, "recommend");
  const recommend = rec ? options.indexOf(rec) + 1 || null : null;
  if (rec && !recommend) return refuse("bad_recommend", "--recommend must be one of --options");
  const file = await postable(c, qf);
  if ("refused" in file) return file.refused;
  const intent = await writeIntent(c.cwd, {
    issue: c.id,
    kind: "ask",
    payload: { questionFile: file.rel, options, recommend, append, reask },
  });
  const questionId = target ?? intent.id;
  if (known) known.status = "open";
  else c.local.questions.push({ id: intent.id, status: "open", askedAt: intent.createdAt });
  await writeLocal(c.cwd, c.local);
  await writeStage(c.cwd, { pipelineStage: c.local.record.pipelineStage, via: "ask", questionId });
  out({ ok: true, questionId, next: END_TURN });
  return 0;
}

async function noteVerb(c: Ctx): Promise<number> {
  const text = c.argv.cmd.slice(3).join(" ") || flag(c.argv, "text");
  if (!text) return refuse("usage", 'note "<text>"');
  if (text.length > 2000) return refuse("note_too_long", `${text.length} characters; the limit is 2000`);
  if (scanText(text).length)
    return refuse(
      "secret_detected",
      "the note contains a secret-like token",
      "notes reach Linear; remove it",
    );
  await writeIntent(c.cwd, { issue: c.id, kind: "note", payload: { text } });
  out({ ok: true });
  return 0;
}

async function runVerb(c: Ctx): Promise<number> {
  if (await dispatcherMode(c.cwd)) return refuse("role_mode", "dispatcher role jobs do not use Orca Runs");
  const runId = flag(c.argv, "id");
  if (!runId) return refuse("usage", "run --id <runId>");
  c.local.run = { childRunId: runId };
  await writeLocal(c.cwd, c.local);
  await writeIntent(c.cwd, { issue: c.id, kind: "run", payload: { runId } });
  out({ ok: true });
  return 0;
}

/** §8.1: nothing beyond `baseSha` → refuse locally; with no known base the dispatcher decides at publish (§13.3 a). */
async function nothingToPublish(cwd: string): Promise<boolean> {
  const launch = await readLaunch(cwd);
  if (!launch.baseSha) return false;
  const r = await run(["git", "rev-list", "--count", `${launch.baseSha}..HEAD`], { cwd, timeoutMs: 30_000 });
  return r.code === 0 && r.stdout.trim() === "0";
}

/** Every `--repo` value, repeated or comma-separated (§8.1 `[--repo <name>]…`), de-duplicated in order; null when malformed. */
function repoList(v: Argv["flags"][string] | undefined): string[] | null {
  if (typeof v === "boolean") return null;
  const values = v === undefined ? [] : Array.isArray(v) ? v : [v];
  return [
    ...new Set(
      values
        .flatMap((x) => x.split(","))
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

async function finishVerb(c: Ctx): Promise<number> {
  const sf = flag(c.argv, "summary-file");
  const repos = repoList(c.argv.flags.repo);
  if (!sf || repos === null)
    return refuse("usage", "finish --summary-file <path> [--title …] [--draft] [--repo <name>[,<name>…]]…");
  const live = await workersLive(c);
  if (live.length)
    return refuse("workers_live", live.join(","), "orca orchestration check --wait … or worker-stop");
  const head = await gitHead(c.cwd);
  if (markStale(c.local, head)) await writeLocal(c.cwd, c.local);
  const missing = FINISH_GATES.filter((s) => !["PASS", "NA"].includes(c.local.gates[s]?.verdict ?? ""));
  if (missing.length)
    return refuse(
      "gates_incomplete",
      `not passed${head ? ` at HEAD ${head.slice(0, 12)}` : ""}: ${missing.join(", ")}`,
      `wingmate issue ${c.id} gate ${missing[0]} …`,
    );
  const file = await postable(c, sf);
  if ("refused" in file) return file.refused;
  if (head && (await nothingToPublish(c.cwd)))
    return refuse(
      "nothing_to_publish",
      "the branch has no commits beyond its base SHA",
      "commit the work, re-gate, finish",
    );
  await writeIntent(c.cwd, {
    issue: c.id,
    kind: "finish",
    payload: {
      summaryFile: file.rel,
      title: flag(c.argv, "title"),
      draft: c.argv.flags.draft === true,
      repos,
    },
  });
  out({ ok: true, next: END_TURN });
  return 0;
}

async function handoffVerb(c: Ctx): Promise<number> {
  const reason = flag(c.argv, "reason");
  if (!reason || c.argv.flags.repo === true)
    return refuse("usage", "handoff --reason <code> [--repo <name>]");
  await writeIntent(c.cwd, { issue: c.id, kind: "handoff", payload: { reason, repo: flag(c.argv, "repo") } });
  out({ ok: true, next: END_TURN });
  return 0;
}

async function followupVerb(c: Ctx): Promise<number> {
  const title = flag(c.argv, "title");
  const bf = flag(c.argv, "body-file");
  if (!title || !bf) return refuse("usage", "followup --title … --body-file <path>");
  if (scanText(title).length) return refuse("secret_detected", "the title contains a secret-like token");
  const file = await postable(c, bf);
  if ("refused" in file) return file.refused;
  await writeIntent(c.cwd, { issue: c.id, kind: "followup", payload: { title, bodyFile: file.rel } });
  out({ ok: true });
  return 0;
}

async function showVerb(c: Ctx): Promise<number> {
  out({
    ok: true,
    record: c.local.record,
    gates: c.local.gates,
    questions: c.local.questions,
    roles: await readRoleJobs(c.cwd),
    // the child Run `spawn` or `run` recorded, before the dispatcher mirrors it into `record` (PROTOCOL: a timed-out spawn is
    // checked here before it is retried)
    run: c.local.run,
    pendingIntents: (await listIntents(c.cwd)).map((i) => ({ id: i.id, kind: i.kind })),
  });
  return 0;
}

async function logVerb(c: Ctx): Promise<number> {
  const t = await readText(join(c.cwd, ".wingmate", "record.json"));
  out({ ok: true, record: t ? JSON.parse(t) : null });
  return 0;
}

async function consumeVerb(c: Ctx): Promise<number> {
  const iid = flag(c.argv, "id");
  if (!iid) return refuse("usage", "consume --id <intentId>");
  await consumeIntent(c.cwd, iid);
  out({ ok: true });
  return 0;
}

const VERBS = new Map<string, (c: Ctx) => Promise<number>>([
  ["gate", (c) => gateVerb(c.argv, { cwd: c.cwd, local: c.local, id: c.id, refuse, out })],
  ["ask", askVerb],
  ["note", noteVerb],
  [
    "spawn",
    async (c) => {
      if (!c.orca.exec && !(await dispatcherMode(c.cwd))) return noRunner("spawn");
      return spawnVerb(c.argv, {
        cwd: c.cwd,
        local: c.local,
        id: c.id,
        refuse,
        out,
        exec:
          c.orca.exec ??
          (async () => {
            throw new WingmateError("orca_unavailable", "no Orca runner is configured for spawn");
          }),
        env: c.env,
      });
    },
  ],
  ["run", runVerb],
  ["finish", finishVerb],
  ["handoff", handoffVerb],
  ["followup", followupVerb],
  [
    "ui-smoke",
    async (c) => {
      const recipe = flag(c.argv, "recipe");
      if (!recipe) return refuse("usage", "ui-smoke --recipe <file>");
      if ((await readLaunch(c.cwd)).ui.kind === "ios")
        return requestNativeUi(c.cwd, c.id, recipe, c.local, out, refuse, c.env.WINGMATE_ROLE);
      if (!c.orca.exec || !c.orca.agentContext) return noRunner("ui-smoke");
      return uiSmoke(c.cwd, c.id, recipe, out, refuse, c.orca.exec, c.orca.agentContext);
    },
  ],
  ["show", showVerb],
  ["log", logVerb],
  ["consume", consumeVerb],
]);

async function dispatch(argv: Argv, deps: IssueDeps): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const local = await readLocal(cwd);
  const [top, idArg] = argv.cmd;
  const hasId = idArg !== undefined && IDENTIFIER_RE.test(idArg);
  const id = hasId ? idArg : local.record.identifier;
  if (id !== local.record.identifier)
    return refuse(
      "wrong_issue",
      `${id} is not this worktree's issue (${local.record.identifier})`,
      `wingmate issue ${local.record.identifier} …`,
    );
  // `<id>` defaults to the worktree's issue (§8.1); normalize to `issue <id> <verb> …` so positionals sit at fixed offsets.
  const a: Argv = hasId ? argv : { ...argv, cmd: [top ?? "issue", id, ...argv.cmd.slice(1)] };
  const name = a.cmd[2] ?? "";
  const verb = VERBS.get(name);
  if (!verb) return refuse("usage", USAGE);
  // F16: a single-valued flag given twice is ambiguous — refused rather than resolved to one of its values
  const repeated = Object.keys(a.flags).filter(
    (k) => Array.isArray(a.flags[k]) && !(REPEATABLE[name] ?? []).includes(k),
  );
  if (repeated.length)
    return refuse(
      "usage",
      `--${repeated.join(", --")} may be given only once`,
      `wingmate issue ${id} ${name} …`,
    );
  return verb({ argv: a, cwd, local, id, orca: deps.orca ?? realOrca(), env: deps.env ?? process.env });
}

export async function issueCommand(argv: Argv, deps: IssueDeps = {}): Promise<number> {
  try {
    return await dispatch(argv, deps);
  } catch (e) {
    if (e instanceof WingmateError) return refuse(e.code, e.message, e.nextStep);
    if (e instanceof OrcaError)
      return refuse(e.code, `orca: ${e.message}`, "retry once; if Orca stays unreachable, ask");
    // F11: anything else is a defect, still reported through the refusal contract (exit 2, no stack trace on stdout)
    const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return refuse(
      "internal_error",
      message.slice(0, 500),
      "retry once; if it fails again, ask the owner, quoting this code and message",
    );
  }
}
