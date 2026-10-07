// spikes/orca-launch-spike.ts — creates and removes one scratch worktree (wm-spike-<8 hex>) in THIS repository
//
//   bun spikes/orca-launch-spike.ts          (takes ~3 minutes; one Claude turn of quota)
//
// Verifies §16.1 row 1 on the installed Orca/Claude: `terminal create --command "exec claude …"`, `terminal wait --for
// tui-idle` (including the workspace-trust dialog that blocks a first launch in a fresh worktree), `terminal send …
// --wait-submit` receipts, `--effort max`, the working → done → closed fleet vocabulary in three snapshots, and
// `claude --resume <id>` in the same worktree. Two extra probes (natural exit, single-terminal close) need no model
// turn. Every step prints one `[label] json` line; spike-results-2026-10-06.md quotes them. The scratch worktree and
// its branch are removed in `finally`, even when a step fails.
//
// Fixtures written to tests/fixtures/orca/: {worktree-ps,terminal-list}-{working,idle,exited}.json — full envelopes,
// scrubbed (see spikes/README.md); `worktree ps` rows are filtered to the scratch worktree.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";

const ORCA = "/usr/local/bin/orca";
const out = `${import.meta.dir}/../tests/fixtures/orca`;
// The brief's prompt is "Reply with the single word READY and then stop." — a one-word reply can finish before the
// fixed 5 s "working" snapshot, so a 25 s sleep holds the turn open (observed ≈ 44 s) to make the fixed timings valid.
const PROMPT = 'Run the shell command "sleep 25", then reply with the single word READY and then stop.';
const DOWN_ARROW = "\x1b[B";

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
const log = (label: string, data: unknown): void => console.log(`[${label}] ${typeof data === "string" ? data : JSON.stringify(data)}`);
/** POSIX single-quote a string for the login shell Orca types `--command` into (the model id contains `[1m]`, a zsh glob). */
const shq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

// ---- scrubbing (duplicated in orca-vocab-capture.ts on purpose: each spike is one self-contained script) ----------
const FREE_TEXT = new Set(["prompt", "lastAssistantMessage", "preview", "description", "body", "toolInput", "comment", "title", "taskTitle", "command"]);
const ALWAYS_REDACT = new Set(["providerAccountId"]);
const CREDLIKE = /token|secret|password|bearer|sk-ant|ghp_|api[_-]?key/i;
const TOKEN_PATTERN = /(sk-ant-|gh[pousr]_|github_pat_|xox[abp]-|eyJ[A-Za-z0-9_-]{20,})/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** Returns a scrubbed copy. `keepText` keeps (truncated) free text; every row captured here is the scratch worktree's. */
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
/** Runs `orca <args> --json`; returns the parsed envelope whether or not `ok` is true. */
async function envelopeOf(args: readonly string[]): Promise<Envelope> {
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
  return env as unknown as Envelope;
}

/** Like `envelopeOf` but throws on `ok: false` and returns only `result`. */
async function orca(args: readonly string[]): Promise<unknown> {
  const env = await envelopeOf(args);
  if (!env.ok) throw new Error(`orca ${args.join(" ")} failed: ${JSON.stringify(env.error)}`);
  return env.result;
}

/** Rendered screen of a terminal (`terminal read --screen`), blank lines dropped; for diagnostics and the resume check. */
async function screenLines(handle: string): Promise<string[]> {
  const env = await envelopeOf(["terminal", "read", "--terminal", handle, "--screen"]);
  if (!env.ok) return [`(terminal read failed: ${JSON.stringify(env.error)})`];
  return arr(get(env.result, "terminal", "tail")).map(String).filter((l) => l.trim().length > 0);
}

function resolveModel(): string | undefined {
  const path = `${homedir()}/.claude/settings.json`;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; // no settings file: omit --model
    throw new Error(`cannot read ${path}: ${String(e)}`);
  }
  const model = (JSON.parse(raw) as { model?: unknown }).model;
  return typeof model === "string" && model.length > 0 ? model : undefined;
}

function claudeCommand(model: string | undefined, sessionFlag: readonly string[]): string {
  return ["exec", "claude", ...(model ? ["--model", shq(model)] : []), "--effort", "max", ...sessionFlag, "--permission-mode", "bypassPermissions"].join(" ");
}

/** Where Claude persists workspace trust: only the scratch path's entry in ~/.claude.json is inspected, nothing else is logged. */
function trustEntry(worktreePath: string): unknown {
  try {
    const cfg = JSON.parse(readFileSync(`${homedir()}/.claude.json`, "utf8")) as { projects?: Record<string, Record<string, unknown>> };
    const e = cfg.projects?.[worktreePath];
    return e ? { found: true, hasTrustDialogAccepted: e.hasTrustDialogAccepted, keys: Object.keys(e) } : { found: false, projectCount: Object.keys(cfg.projects ?? {}).length };
  } catch (e) {
    return `unreadable: ${String(e)}`;
  }
}

async function save(name: string, env: Envelope): Promise<void> {
  await Bun.write(`${out}/${name}.json`, `${JSON.stringify(env, null, 2)}\n`);
}

/** Scrubbed copy of `env` whose `result` keys in `patch` are replaced (patch values are already scrubbed). */
function build(env: Envelope, patch: Record<string, unknown>): Envelope {
  const { result, ...top } = env;
  const rest = Object.fromEntries(Object.entries(isObj(result) ? result : {}).filter(([k]) => !(k in patch)));
  return { ...(scrub(top) as object), result: { ...(scrub(rest, "", true) as object), ...patch } } as unknown as Envelope;
}

// ---- the spike ----------------------------------------------------------------------------------------------------
await mkdir(out, { recursive: true });
let wt: string | undefined;
let wtPath: string | undefined;
let branchName: string | undefined;
const sessionId = randomUUID();
let failure: unknown;

/** Fleet view of the scratch worktree: its `worktree ps` row plus its `terminal list` rows (envelopes returned for saving). */
async function observe(handle: string): Promise<{ ps: Envelope; tl: Envelope; row: unknown; terminals: readonly unknown[]; summary: Record<string, unknown> }> {
  const ps = await envelopeOf(["worktree", "ps"]);
  const tl = await envelopeOf(["terminal", "list", "--worktree", `id:${wt}`]);
  const row = arr(get(ps.result, "worktrees")).find((w) => get(w, "worktreeId") === wt);
  const terminals = arr(get(tl.result, "terminals"));
  const ours = terminals.find((t) => get(t, "handle") === handle);
  const summary = {
    psOk: ps.ok,
    tlOk: tl.ok,
    worktreeStatus: get(row, "status"),
    liveTerminalCount: get(row, "liveTerminalCount"),
    worktreeLastOutputAt: get(row, "lastOutputAt"),
    agents: arr(get(row, "agents")).map((a) => ({ paneKey: get(a, "paneKey"), state: get(a, "state"), agentType: get(a, "agentType"), stateStartedAt: get(a, "stateStartedAt"), updatedAt: get(a, "updatedAt"), toolName: get(a, "toolName"), interrupted: get(a, "interrupted"), lastAssistantMessage: get(a, "lastAssistantMessage") })),
    terminals: terminals.map((t) => ({ handle: get(t, "handle"), tabId: get(t, "tabId"), leafId: get(t, "leafId"), agentIdentity: get(t, "agentIdentity"), lastOutputAt: get(t, "lastOutputAt"), title: get(t, "title"), connected: get(t, "connected"), writable: get(t, "writable") })),
    recordedHandlePresent: ours !== undefined,
    recordedPaneKey: ours ? `${String(get(ours, "tabId"))}:${String(get(ours, "leafId"))}` : null,
  };
  return { ps, tl, row, terminals, summary };
}

async function snapshot(kind: "working" | "idle" | "exited", handle: string): Promise<void> {
  const { ps, tl, row, terminals, summary } = await observe(handle);
  // A failed envelope (ok: false) is saved as captured; only successful ones are filtered to the scratch worktree.
  await save(`worktree-ps-${kind}`, ps.ok ? build(ps, { worktrees: row ? [scrub(row, "", true)] : [], totalCount: row ? 1 : 0 }) : (scrub(ps, "", true) as Envelope));
  await save(`terminal-list-${kind}`, tl.ok ? build(tl, { terminals: terminals.map((t) => scrub(t, "", true)) }) : (scrub(tl, "", true) as Envelope));
  log(`snapshot.${kind}`, summary);
}

/**
 * `terminal wait --for tui-idle`; when Orca reports `blockedReason: "agent-trust-workspace"` (Claude's folder-trust
 * dialog, which highlights "No, exit" by default) answer it with Down + Enter and wait again.
 */
async function waitReady(handle: string, label: string): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const wait = await envelopeOf(["terminal", "wait", "--terminal", handle, "--for", "tui-idle", "--timeout-ms", "120000"]);
    log(`${label}.wait#${attempt}`, wait);
    if (get(wait.result, "wait", "satisfied") === true) return true;
    if (get(wait.result, "wait", "blockedReason") !== "agent-trust-workspace") return false;
    log(`${label}.screen-while-blocked`, await screenLines(handle));
    log(`${label}.trust-down`, await envelopeOf(["terminal", "send", "--terminal", handle, "--text", DOWN_ARROW]));
    await Bun.sleep(1000);
    log(`${label}.screen-after-down`, (await screenLines(handle)).slice(-4));
    log(`${label}.trust-enter`, await envelopeOf(["terminal", "send", "--terminal", handle, "--enter"]));
    await Bun.sleep(3000);
  }
  return false;
}

async function launch(label: string, sessionFlag: readonly string[], title: string): Promise<{ handle: string; ready: boolean }> {
  const command = claudeCommand(resolveModel(), sessionFlag);
  const term = await orca(["terminal", "create", "--worktree", `id:${wt}`, "--title", title, "--command", command]);
  log(`${label}.create`, { command, result: term });
  const handle = String(get(term, "terminal", "handle") ?? get(term, "handle"));
  return { handle, ready: await waitReady(handle, label) };
}

try {
  const repoId = String(get(await orca(["worktree", "current"]), "worktree", "repoId"));
  const name = `wm-spike-${randomUUID().slice(0, 8).toLowerCase()}`;
  const created = await orca(["worktree", "create", "--repo", `id:${repoId}`, "--name", name, "--no-parent", "--setup", "skip", "--comment", "wingmate spike"]);
  wt = String(get(created, "worktree", "id"));
  log("worktree.create", { id: wt, keys: isObj(created) ? Object.keys(created) : [], startupTerminal: get(created, "startupTerminal"), agentTerminalHandle: get(created, "agentTerminalHandle") });

  const shown = await orca(["worktree", "show", "--worktree", `id:${wt}`]);
  const branch = String(get(shown, "worktree", "branch") ?? get(shown, "branch"));
  wtPath = String(get(shown, "worktree", "path") ?? get(shown, "path"));
  branchName = branch.replace(/^refs\/heads\//, "");
  log("worktree.show", { branch, path: wtPath, displayName: get(shown, "worktree", "displayName"), head: get(shown, "worktree", "head") });
  log("terminals.before-launch", arr(get(await orca(["terminal", "list", "--worktree", `id:${wt}`]), "terminals")).map((t) => ({ handle: get(t, "handle"), title: get(t, "title"), agentIdentity: get(t, "agentIdentity") })));
  log("trust.before-launch", trustEntry(wtPath));

  // 1. launch + first turn + the three snapshots
  const first = await launch("launch", ["--session-id", sessionId], "wingmate spike");
  log("launch.ready", { argv: claudeCommand(resolveModel(), ["--session-id", sessionId]), sessionId, satisfied: first.ready });
  log("screen.after-ready", await screenLines(first.handle));
  log("trust.after-launch", trustEntry(wtPath));
  const send = await orca(["terminal", "send", "--terminal", first.handle, "--text", PROMPT, "--enter", "--wait-submit", "15"]);
  log("terminal.send", send);
  await Bun.sleep(5000);
  await snapshot("working", first.handle);
  await Bun.sleep(60000);
  await snapshot("idle", first.handle);
  log("screen.idle", (await screenLines(first.handle)).slice(-8));
  log("terminal.close", await envelopeOf(["terminal", "close", "--worktree", `id:${wt}`, "--all"]));
  await Bun.sleep(3000);
  await snapshot("exited", first.handle);
  log("wait-exit.on-closed-handle", await envelopeOf(["terminal", "wait", "--terminal", first.handle, "--for", "exit", "--timeout-ms", "1"]));
  log("terminal.show.on-closed-handle", await envelopeOf(["terminal", "show", "--terminal", first.handle]));

  // 2. resume (§16.1 row 1): same session id, same worktree; the restored transcript must be on the rendered screen
  const resumed = await launch("resume", ["--resume", sessionId], "wingmate spike resume");
  const resumedScreen = await screenLines(resumed.handle);
  log("resume.screen", resumedScreen);
  log("resume.restored", { ready: resumed.ready, promptVisible: resumedScreen.some((l) => l.includes("sleep 25")), answerVisible: resumedScreen.some((l) => l.includes("READY")), observed: (await observe(resumed.handle)).summary });

  // 3. extra probe, no model turn: natural exit of the agent (`/exit`; the `exec` prefix makes the PTY end with it)
  log("probe.exit.send", await envelopeOf(["terminal", "send", "--terminal", resumed.handle, "--text", "/exit", "--enter"]));
  log("probe.exit.wait", await envelopeOf(["terminal", "wait", "--terminal", resumed.handle, "--for", "exit", "--timeout-ms", "30000"]));
  await Bun.sleep(2000);
  log("probe.exit.observed", (await observe(resumed.handle)).summary);

  // 4. extra probe, no model turn: close ONE terminal (not --all) while the agent is idle
  const third = await launch("close-one", ["--resume", sessionId], "wingmate spike close-one");
  log("probe.close-one.before", (await observe(third.handle)).summary);
  log("probe.close-one.close", await envelopeOf(["terminal", "close", "--terminal", third.handle]));
  await Bun.sleep(3000);
  log("probe.close-one.after", (await observe(third.handle)).summary);
} catch (e) {
  failure = e;
  log("spike.error", String(e));
} finally {
  if (wt) {
    log("cleanup.terminal-close", await envelopeOf(["terminal", "close", "--worktree", `id:${wt}`, "--all"]).catch((e: unknown) => String(e)));
    await Bun.sleep(2000);
    log("cleanup.worktree-rm", await envelopeOf(["worktree", "rm", "--worktree", `id:${wt}`, "--force"]).catch((e: unknown) => String(e)));
    // `worktree rm` returns before the removal finishes; give Orca time to delete the checkout and its branch.
    for (let i = 0; i < 10 && wtPath && existsSync(wtPath); i++) await Bun.sleep(1500);
    await Bun.sleep(2000);
    log("cleanup.trust-entry", wtPath ? trustEntry(wtPath) : "(no path)");
    if (branchName?.includes("wm-spike-")) {
      // Orca normally deletes the scratch branch itself; the branch holds no commits, so delete it if it survived.
      const list = Bun.spawn(["git", "branch", "--list", branchName], { stdout: "pipe", stderr: "pipe" });
      if ((await new Response(list.stdout).text()).trim()) {
        const del = Bun.spawn(["git", "branch", "-D", branchName], { stdout: "pipe", stderr: "pipe" });
        log("cleanup.branch-delete", `${(await new Response(del.stdout).text()).trim()} ${(await new Response(del.stderr).text()).trim()}`.trim());
      } else {
        log("cleanup.branch-delete", "(branch already gone)");
      }
    }
    log("cleanup.worktree-dir-exists", wtPath ? existsSync(wtPath) : "(no path)");
  }
  console.log(`done; session id used: ${sessionId}`);
}
if (failure) process.exitCode = 1;
