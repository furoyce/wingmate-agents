// spikes/orca-vocab-capture.ts — read-only against Orca; writes scrubbed fixtures under tests/fixtures/orca/
//
//   bun spikes/orca-vocab-capture.ts        (output path is relative to this file, so any cwd works)
//
// The raw envelopes of `worktree ps`, `worker-list`, `automations list` and `account list` carry fleet-wide free text
// (prompts, assistant messages, an e-mail address, an account id) from unrelated projects. Each envelope is scrubbed
// and sampled BEFORE it is written so raw content never reaches git history. Scrub rules (also in spikes/README.md):
//   - strings that look like credentials, and credential-looking keys with string values -> "REDACTED"
//   - credential-looking keys with non-string values (token counters, *ApiKeyConfigured flags) are dropped
//   - e-mail addresses -> user@example.invalid; provider account ids -> "REDACTED"
//   - free-text fields: kept (cut to 80 chars + "…") only for rows of THIS repository, "REDACTED" everywhere else
// The distinct vocabulary seen across the FULL raw lists is printed to stdout as one JSON line (`VOCABULARY {...}`)
// for docs/superpowers/plans/spike-results-2026-10-06.md; it is never written to disk.
import { mkdir } from "node:fs/promises";

const ORCA = "/usr/local/bin/orca";
const out = `${import.meta.dir}/../tests/fixtures/orca`;

interface Envelope {
  readonly id: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly _meta?: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);
const get = (v: unknown, ...path: readonly string[]): unknown =>
  path.reduce<unknown>((acc, k) => (isObj(acc) ? acc[k] : undefined), v);
const keyList = (v: unknown): string[] => Object.keys(isObj(v) ? v : {});

// ---- scrubbing (duplicated in orca-launch-spike.ts on purpose: each spike is one self-contained script) ----------
const FREE_TEXT = new Set(["prompt", "lastAssistantMessage", "preview", "description", "body", "toolInput", "comment", "title", "taskTitle", "command"]);
const ALWAYS_REDACT = new Set(["providerAccountId"]);
const CREDLIKE = /token|secret|password|bearer|sk-ant|ghp_|api[_-]?key/i;
const TOKEN_PATTERN = /(sk-ant-|gh[pousr]_|github_pat_|xox[abp]-|eyJ[A-Za-z0-9_-]{20,})/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** Returns a scrubbed copy. `keepText` keeps (truncated) free text; pass true only for this repository's own rows. */
function scrub(v: unknown, key = "", keepText = false): unknown {
  if (Array.isArray(v)) return v.map((x) => scrub(x, key, keepText));
  if (isObj(v)) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (CREDLIKE.test(k) && typeof x !== "string") continue; // credential-looking key with a non-string value: drop
      o[k] = scrub(x, k, keepText);
    }
    return o;
  }
  if (typeof v !== "string") return v;
  if (CREDLIKE.test(key) || ALWAYS_REDACT.has(key) || TOKEN_PATTERN.test(v) || (FREE_TEXT.has(key) && CREDLIKE.test(v))) return "REDACTED";
  if (FREE_TEXT.has(key) && !keepText && v.length > 0) return "REDACTED";
  const s = v.replace(EMAIL, "user@example.invalid");
  return FREE_TEXT.has(key) && s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

// ---- Orca access --------------------------------------------------------------------------------------------------
async function orca(args: readonly string[]): Promise<Envelope> {
  const p = Bun.spawn([ORCA, ...args, "--json"], { stdout: "pipe", stderr: "pipe" });
  const [text, errText] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  let env: unknown;
  try {
    env = JSON.parse(text);
  } catch (e) {
    throw new Error(`orca ${args.join(" ")}: non-JSON output (exit ${p.exitCode}): ${text.slice(0, 200)} ${errText.slice(0, 200)} (${String(e)})`);
  }
  if (!isObj(env) || typeof env.ok !== "boolean") throw new Error(`orca ${args.join(" ")}: not an envelope: ${text.slice(0, 200)}`);
  if (!env.ok) throw new Error(`orca ${args.join(" ")} failed: ${JSON.stringify(env.error)}`);
  return env as unknown as Envelope;
}

/** First row per distinct key, then fill with the earliest remaining rows, capped at `max`. */
function sampleDistinct<T>(rows: readonly T[], keyOf: (r: T) => string, max: number): T[] {
  const seen = new Set<string>();
  const picked: T[] = [];
  for (const r of rows) {
    const k = keyOf(r);
    if (!seen.has(k)) {
      seen.add(k);
      picked.push(r);
    }
  }
  for (const r of rows) if (picked.length < max && !picked.includes(r)) picked.push(r);
  return picked.slice(0, max);
}

/**
 * Scrubbed envelope whose `result` keys in `patch` are replaced by caller-scrubbed values (each row may have its own
 * keepText decision); every other part of the envelope goes through the default scrub.
 */
function build(env: Envelope, patch: Record<string, unknown> = {}): Envelope {
  const { result, ...top } = env;
  const rest = Object.fromEntries(Object.entries(isObj(result) ? result : {}).filter(([k]) => !(k in patch)));
  return { ...(scrub(top) as object), result: { ...(scrub(rest) as object), ...patch } } as unknown as Envelope;
}

async function save(name: string, env: Envelope): Promise<void> {
  const text = `${JSON.stringify(env, null, 2)}\n`;
  await Bun.write(`${out}/${name}.json`, text);
  console.log(`${name}: ok=${env.ok}, ${text.length} bytes written (scrubbed)`);
}

// ---- vocabulary (computed from the FULL raw lists; printed, never written) --------------------------------------------
const keysOf = (rows: readonly unknown[]): string[] => [...new Set(rows.flatMap((r) => keyList(r)))];
const distinct = (rows: readonly unknown[], pick: (r: unknown) => unknown): string[] =>
  [...new Set(rows.map((r) => pick(r)).map((v) => (v === undefined ? "<absent>" : JSON.stringify(v))))].sort();

await mkdir(out, { recursive: true });

const selfRepoId = String(get((await orca(["worktree", "current"])).result, "worktree", "repoId"));
const isSelf = (row: unknown): boolean => get(row, "repoId") === selfRepoId;
const hasAgents = (row: unknown): boolean => arr(get(row, "agents")).length > 0;

const ps = await orca(["worktree", "ps"]);
const psRows = arr(get(ps.result, "worktrees"));
const psAgents = psRows.flatMap((w) => arr(get(w, "agents")));
// Sample: this repo's row with agents (free text kept), a row without agents, a row with a linked PR (free text blanked).
const psPicked = [
  psRows.find((w) => isSelf(w) && hasAgents(w)),
  psRows.find((w) => !isSelf(w) && !hasAgents(w)),
  psRows.find((w) => !isSelf(w) && hasAgents(w) && get(w, "linkedPR") !== null),
].filter((w): w is unknown => w !== undefined);
const psRowsOut = psPicked.map((w) => scrub(w, "", isSelf(w)));
await save("worktree-ps", build(ps, { worktrees: psRowsOut, totalCount: psRowsOut.length }));

const account = await orca(["account", "list"]);
await save("account-list", build(account));

const automations = await orca(["automations", "list"]);
const autoRows = arr(get(automations.result, "automations"));
const keptAutos = sampleDistinct(autoRows, (a) => String(get(a, "enabled")), 3);
const keptIds = new Set(keptAutos.map((a) => get(a, "id")));
await save(
  "automations-list",
  build(automations, {
    automations: keptAutos.map((a) => scrub(a)),
    items: arr(get(automations.result, "items")).filter((i) => keptIds.has(get(i, "automationId"))).map((i) => scrub(i)),
  }),
);

const workers = await orca(["orchestration", "worker-list"]);
const workerRows = arr(get(workers.result, "workers"));
await save("worker-list", build(workers, { workers: sampleDistinct(workerRows, (w) => String(get(w, "projection", "liveness", "verdict")), 4).map((w) => scrub(w)) }));

const firstLive = psRows.find((w) => isSelf(w) && Number(get(w, "liveTerminalCount")) > 0) ?? psRows.find((w) => Number(get(w, "liveTerminalCount")) > 0);
let terminalRows: readonly unknown[] = [];
if (firstLive) {
  const tl = await orca(["terminal", "list", "--worktree", `id:${String(get(firstLive, "worktreeId"))}`]);
  terminalRows = arr(get(tl.result, "terminals"));
  await save("terminal-list-sample", build(tl, { terminals: terminalRows.map((t) => scrub(t, "", isSelf(firstLive))) }));
}

console.log(
  `VOCABULARY ${JSON.stringify({
    worktreePs: {
      rowCount: psRows.length,
      rowKeys: keysOf(psRows),
      "row.status": distinct(psRows, (w) => get(w, "status")),
      "row.workspaceStatus": distinct(psRows, (w) => get(w, "workspaceStatus")),
      agentKeys: keysOf(psAgents),
      "agents.state": distinct(psAgents, (a) => get(a, "state")),
      "agents.agentType": distinct(psAgents, (a) => get(a, "agentType")),
      resultKeys: keyList(ps.result),
    },
    terminalList: { rowCount: terminalRows.length, rowKeys: keysOf(terminalRows), agentIdentity: distinct(terminalRows, (t) => get(t, "agentIdentity")) },
    workerList: {
      rowCount: workerRows.length,
      rowKeys: keysOf(workerRows),
      workerState: distinct(workerRows, (w) => get(w, "workerState")),
      dispatchStatus: distinct(workerRows, (w) => get(w, "dispatchStatus")),
      terminalState: distinct(workerRows, (w) => get(w, "terminalState")),
      "liveness.verdict": distinct(workerRows, (w) => get(w, "projection", "liveness", "verdict")),
      "liveness.source": distinct(workerRows, (w) => get(w, "projection", "liveness", "source")),
      "stage.worker": distinct(workerRows, (w) => get(w, "projection", "stage", "worker")),
      "stage.dispatch": distinct(workerRows, (w) => get(w, "projection", "stage", "dispatch")),
      "stage.activity": distinct(workerRows, (w) => get(w, "projection", "stage", "activity")),
      "nextAction.kind": distinct(workerRows, (w) => get(w, "projection", "nextAction", "kind")),
      projectionKeys: keysOf(workerRows.map((w) => get(w, "projection"))),
      resultKeys: keyList(workers.result),
    },
    automations: { rowCount: autoRows.length, rowKeys: keysOf(autoRows), "precheck.keys": keysOf(autoRows.map((a) => get(a, "precheck"))), "precheck.timeoutSeconds": distinct(autoRows, (a) => get(a, "precheck", "timeoutSeconds")) },
    accountList: {
      resultKeys: keyList(account.result),
      "rateLimits.providers": keyList(get(account.result, "rateLimits")),
      "rateLimits.claude.keys": keyList(get(account.result, "rateLimits", "claude")),
      "rateLimits.claude.session.keys": keyList(get(account.result, "rateLimits", "claude", "session")),
    },
  })}`,
);
