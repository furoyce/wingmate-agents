// src/ops/probe.ts — `doctor`'s live §13.3(b)/(c) checks. The Claude probe runs one `claude -p` under the kit settings and agentEnv in
// a scratch `wm-doctor-<ulid>` worktree of this repository (under the owner's home, removed when it ends; never an issue worktree).
// Every probe is a dispatcher-written script that prints exactly one `PROBE <n> exit=<code> sig=<class>` line, the class computed by
// the shell from the command's own stderr, so a GitHub auth failure is never mistaken for a network block. A probe's result is read
// only from the tool result of the Bash call that ran its own script (joined by tool_use_id in the stream-json output); the model's
// reply is never read, so a command that did not run has no result (F3). Command 8 counts only as a call that set
// `dangerouslyDisableSandbox: true` (F1/F4). A missing, conflicting or inverted line fails, and every write probe is also checked on
// disk. Nothing a probe reads is ever printed: the credential read discards its output, the token probe compares without echoing.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { DISPATCHER_GIT_ENV } from "../git/cli";
import { discoverGitLinks, verifyGitLinks } from "../git/trust";
import { agentEnv, claudeSettings, shellQuote } from "../kit/settings";
import type { Ctx } from "../machine/context";
import { resolveTier } from "../policy/providers";
import type { GitTarget } from "../ports";
import { errorCode } from "../shared/errors";
import { type RunOptions, type RunResult, run } from "../shared/exec";
import { newUlid } from "../shared/ids";
import { createExclusive, readText, writeAtomic } from "../state/fs";

export type Runner = (argv: string[], opts?: RunOptions) => Promise<RunResult>;
export interface ProbeResult {
  ok: boolean;
  detail: string;
}
export interface ClaudeProbeResult extends ProbeResult {
  /** D14: whether `orca worktree current --json` worked from inside the sandbox; null when its line is missing. */
  orcaReachable: boolean | null;
}
export interface CodexProbeResult extends ProbeResult {
  /** §13.3(c): whether a read of the credentials file outside the worktree was blocked; null when unknown. */
  readsBlocked: boolean | null;
}
export interface ProbeLine {
  exit: number;
  sig: string;
}
type Expect = "fail" | "succeed" | "report";
interface Probe {
  n: number;
  name: string;
  expect: Expect;
  /** The classes a failing exit must carry to count as the control holding (`fail` probes); any class when absent. */
  blockedBy?: readonly string[];
  /** The failure text when it failed with a class outside `blockedBy` (default: "failed for another reason than the control"). */
  unproven?: string;
  /** The class a succeeding exit must carry (`succeed` probes); any when absent. */
  okSig?: RegExp;
  /**
   * The host a `net` failure must name: the block must also be the sandbox's own, the `network-outbound <host>:<port>` violation
   * Claude Code appends to that command's tool result (spike §3.4a/§3.4b) — a DNS or firewall failure prints the same curl/git error.
   */
  violation?: string;
  /**
   * F1/F4: the probe's Bash call must set `dangerouslyDisableSandbox: true` (the escape hatch is tried, not assumed). Only such a
   * call's tool result counts: a blocked line, or the harness refusing the call (an error result that printed no PROBE line).
   */
  escape?: boolean;
  body: string;
}
/** One Bash tool call of the stream: what it ran, whether it asked to leave the sandbox, and its tool result (null when none came). */
export interface BashCall {
  id: string;
  command: string;
  escape: boolean;
  result: { text: string; isError: boolean } | null;
}
export interface ProbePaths {
  credentials: string;
  commonDir: string;
  decoyHead: string;
  escapeFile: string;
  worktree: string;
  registryHost: string;
  blockedHost: string;
  identifier: string;
  home: string;
}

/** The PROBE line, strictly: a literal `$c` or `${sig}` in a script or prompt never matches, and the exit is a number (as printed). */
const LINE = /PROBE (\d{1,2}) exit=(-?\d{1,3}) sig=([a-z0-9]{1,24})/g;
export const PROBE_ID = "WMPROBE-1";
const q = (s: string) => shellQuote([s]);

/** Shared by every script: classify a command's stderr. Auth before the generic permission text ("Permission denied (publickey)"). */
export const CLASSIFY = `classify() {
  case "$1" in
    *"could not read Username"*|*"Authentication failed"*|*"terminal prompts disabled"*|*"Permission denied (publickey)"*|*"gh auth login"*|*"HTTP 401"*) echo auth ;;
    *"CONNECT tunnel failed"*|*"response 403"*|*"Could not resolve host"*|*"Could not resolve hostname"*|*"nodename nor servname"*|*"Name or service not known"*|*"network-outbound"*|*"Failed to connect"*) echo net ;;
    *"Operation not permitted"*|*"Permission denied"*|*"Read-only file system"*) echo eperm ;;
    *"No such file or directory"*) echo enoent ;;
    "") echo none ;;
    *) echo other ;;
  esac
}`;

/** The §13.3(b) probe set (Ruling for Task 12): eight that must fail, five that must succeed, one reported (D14). */
export function claudeProbes(p: ProbePaths): Probe[] {
  const write = (path: string) => `o=$( { : >> ${q(path)}; } 2>&1 ); c=$?`;
  return [
    {
      n: 1,
      name: "credentials_read",
      expect: "fail",
      blockedBy: ["eperm"],
      body: `o=$(cat ${q(p.credentials)} 2>&1 >/dev/null); c=$?`,
    },
    {
      n: 2,
      name: "github_ls_remote",
      expect: "fail",
      blockedBy: ["net"],
      violation: "github.com",
      body: "o=$(git ls-remote https://github.com/git/git.git HEAD 2>&1 >/dev/null); c=$?",
    },
    {
      n: 3,
      name: "gh_api_user",
      expect: "fail",
      // F5: no credentials (spike: exit 4 "gh auth login") or the sandbox refusing api.github.com; gh missing proves nothing
      blockedBy: ["auth", "net"],
      unproven: "gh not reachable: control unproven",
      violation: "api.github.com",
      body: "o=$(gh api user 2>&1 >/dev/null); c=$?",
    },
    {
      n: 4,
      name: "hook_write",
      expect: "fail",
      blockedBy: ["eperm"],
      body: write(join(p.commonDir, "hooks", "pre-commit")),
    },
    {
      n: 5,
      name: "sibling_gitdir_write",
      expect: "fail",
      blockedBy: ["eperm"],
      // the decoy exists only for this probe, so this write may change it (and the disk check then sees it did)
      body: `o=$( { echo wingmate-probe >> ${q(p.decoyHead)}; } 2>&1 ); c=$?`,
    },
    {
      n: 6,
      name: "index_lock_write",
      expect: "fail",
      blockedBy: ["eperm"],
      body: write(join(p.commonDir, "index.lock")),
    },
    {
      n: 7,
      name: "unlisted_host",
      expect: "fail",
      blockedBy: ["net"],
      violation: p.blockedHost,
      body: `o=$(curl -sS -m 15 -o /dev/null https://${p.blockedHost}/ 2>&1); c=$?`,
    },
    {
      n: 8,
      name: "unsandboxed_bash",
      expect: "fail",
      blockedBy: ["eperm"],
      escape: true,
      body: write(p.escapeFile),
    },
    {
      n: 9,
      name: "allowlisted_registry",
      expect: "succeed",
      okSig: /^http[23]\d\d$/,
      body: `h=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' https://${p.registryHost}/ 2>/dev/null); c=$?; o="http$h"`,
    },
    {
      n: 10,
      name: "git_commit",
      expect: "succeed",
      body: `o=$(cd ${q(p.worktree)} && git commit --allow-empty -q -m 'wingmate doctor probe' 2>&1 >/dev/null); c=$?`,
    },
    {
      n: 11,
      name: "wingmate_issue_show",
      expect: "succeed",
      okSig: /^ok$/,
      body: `o=$(cd ${q(p.worktree)} && wingmate issue ${p.identifier} show 2>&1); c=$?; case "$o" in *'"ok":true'*) o=ok ;; esac`,
    },
    {
      n: 12,
      name: "wingmate_on_path",
      expect: "succeed",
      body: `w=$(command -v wingmate); c=$?; case "$w" in ${q(join(p.home, ".local", "bin", "wingmate"))}) o=local ;; '') o=none ;; *) o=elsewhere ;; esac`,
    },
    {
      n: 13,
      name: "github_token_empty",
      expect: "succeed",
      body: `test -z "\${GH_TOKEN:-}\${GITHUB_TOKEN:-}\${GH_ENTERPRISE_TOKEN:-}\${GITHUB_ENTERPRISE_TOKEN:-}"; c=$?; if printenv GITHUB_TOKEN >/dev/null 2>&1; then o=set; else o=unset; fi`,
    },
    {
      n: 14,
      name: "orca_from_sandbox",
      expect: "report",
      body: `b=$(command -v orca || echo /usr/local/bin/orca); r=$("$b" worktree current --json 2>/dev/null); c=$?; if printf '%s' "$r" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then o=reachable; else o=unreachable; fi`,
    },
  ];
}

/** One script: the shared classifier, the probe's body, then its single line. Bodies that set `o` to a class word pass it through. */
export function probeScript(p: Probe): string {
  const sig =
    p.n === 9 || p.n === 11 || p.n === 12 || p.n === 13 || p.n === 14
      ? `$(case "$o" in http[0-9][0-9][0-9]|ok|local|none|elsewhere|set|unset|reachable|unreachable) echo "$o" ;; *) classify "$o" ;; esac)`
      : `$(classify "$o")`;
  return `#!/bin/sh\n# wingmate doctor probe ${p.n} (${p.name}): must ${p.expect === "report" ? "be reported" : p.expect}\n${CLASSIFY}\n${p.body}\necho "PROBE ${p.n} exit=$c sig=${sig}"\n`;
}

/** Every PROBE line of `text`, by probe number. */
export function probeLines(text: string): Map<number, ProbeLine[]> {
  const out = new Map<number, ProbeLine[]>();
  for (const m of text.matchAll(LINE)) {
    const n = Number(m[1]);
    out.set(n, [...(out.get(n) ?? []), { exit: Number(m[2]), sig: m[3] ?? "" }]);
  }
  return out;
}

const ToolUse = z.object({
  type: z.literal("tool_use"),
  id: z.string().min(1),
  name: z.string(),
  input: z.object({ command: z.string(), dangerouslyDisableSandbox: z.unknown().optional() }).passthrough(),
});
const ToolResult = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string().min(1),
  is_error: z.boolean().optional(),
  content: z.union([
    z.string(),
    z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
  ]),
});
const StreamEvent = z
  .object({
    type: z.string(),
    message: z
      .object({ content: z.union([z.string(), z.array(z.unknown())]) })
      .passthrough()
      .optional(),
  })
  .passthrough();

/**
 * Claude's stream-json output: every Bash tool call the model made (assistant `tool_use`), joined by `tool_use_id` to its tool result
 * (user `tool_result`; an error is `is_error` or a `<tool_use_error>` text). Other tools, results of unknown calls and lines that are
 * not stream-json are ignored; the model's reply is not read at all (F3).
 */
export function streamCalls(stdout: string): BashCall[] {
  const uses: Omit<BashCall, "result">[] = [];
  const results = new Map<string, NonNullable<BashCall["result"]>>();
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let ev: z.infer<typeof StreamEvent>;
    try {
      const parsed = StreamEvent.safeParse(JSON.parse(line));
      if (!parsed.success) continue;
      ev = parsed.data;
    } catch {
      continue;
    }
    if (!Array.isArray(ev.message?.content)) continue;
    for (const item of ev.message.content) {
      if (ev.type === "assistant") {
        const u = ToolUse.safeParse(item);
        if (u.success && u.data.name === "Bash" && !uses.some((x) => x.id === u.data.id))
          uses.push({
            id: u.data.id,
            command: u.data.input.command,
            escape: u.data.input.dangerouslyDisableSandbox === true,
          });
      } else if (ev.type === "user") {
        const t = ToolResult.safeParse(item);
        if (!t.success || results.has(t.data.tool_use_id)) continue;
        const c = t.data.content;
        const text = typeof c === "string" ? c : c.map((x) => x.text ?? "").join("\n");
        results.set(t.data.tool_use_id, {
          text,
          isError: t.data.is_error === true || text.includes("<tool_use_error>"),
        });
      }
    }
  }
  return uses.map((u) => ({ ...u, result: results.get(u.id) ?? null }));
}

/** Whether `command` runs `script`: its full path, not a longer path that merely starts with it. */
function runsScript(command: string, script: string): boolean {
  for (let i = command.indexOf(script); i >= 0; i = command.indexOf(script, i + 1)) {
    const next = command[i + script.length];
    if (next === undefined || !/[\w./-]/.test(next)) return true;
  }
  return false;
}

/**
 * Judges each probe only from the tool results of the Bash calls that ran its own script (`scriptOf(n)`), never from the model's
 * reply (F3): no such result line, two different lines, a `fail` probe that succeeded or failed for another reason than its control
 * (an auth failure is not a network block; a network failure needs the sandbox's violation for its host in that same result), or a
 * `succeed` probe that failed — each is a failure. The `escape` probe (F1/F4) counts only calls that set dangerouslyDisableSandbox:
 * none is "not exercised"; such a call the harness refused (an error result without a PROBE line) is the control holding.
 */
export function judge(
  probes: Probe[],
  calls: BashCall[],
  scriptOf: (n: number) => string,
): { failures: string[]; lines: Map<number, ProbeLine> } {
  const failures: string[] = [];
  const lines = new Map<number, ProbeLine>();
  for (const p of probes) {
    const ran = calls.filter((c) => runsScript(c.command, scriptOf(p.n)));
    const mine = p.escape ? ran.filter((c) => c.escape) : ran;
    if (p.escape && !mine.length) {
      failures.push(
        `${p.name}: not exercised (no Bash call ran command ${p.n} with dangerouslyDisableSandbox: true)`,
      );
      continue;
    }
    const texts = mine.map((c) => c.result?.text ?? "");
    const seen = texts.flatMap((t) => probeLines(t).get(p.n) ?? []);
    const distinct = [...new Map(seen.map((l) => [`${l.exit}/${l.sig}`, l])).values()];
    if (distinct.length > 1) {
      failures.push(
        `${p.name}: conflicting results (${distinct.map((l) => `exit=${l.exit} sig=${l.sig}`).join(" vs ")})`,
      );
      continue;
    }
    const l = distinct[0];
    if (!l) {
      if (p.escape && mine.some((c) => c.result?.isError)) continue; // the harness refused the unsandboxed call
      if (p.expect !== "report") failures.push(`${p.name}: no PROBE line`);
      continue;
    }
    lines.set(p.n, l);
    const desc = `exit=${l.exit} sig=${l.sig}`;
    if (p.expect === "report") continue;
    if (p.expect === "fail") {
      if (l.exit === 0) failures.push(`${p.name}: ALLOWED (${desc})`);
      else if (p.blockedBy && !p.blockedBy.includes(l.sig))
        failures.push(
          `${p.name}: ${p.unproven ?? "failed for another reason than the control"} (${desc}${l.sig === "auth" ? "; an auth failure proves no network block" : ""})`,
        );
      else if (
        p.violation &&
        l.sig === "net" &&
        !texts.some((t) => t.includes(`network-outbound ${p.violation}:`))
      )
        failures.push(
          `${p.name}: blocked, but no sandbox violation for ${p.violation} in its tool result (a DNS or firewall failure proves nothing about the sandbox)`,
        );
    } else if (l.exit !== 0) failures.push(`${p.name}: failed (${desc})`);
    else if (p.okSig && !p.okSig.test(l.sig)) failures.push(`${p.name}: unexpected result (${desc})`);
  }
  return { failures, lines };
}

const PROMPT = (scripts: string[]) =>
  [
    "This is Wingmate's sandbox self-test. Run each command below exactly as written, each as its own Bash tool call, in the order given.",
    "Never retry, change, combine or work around a command: a command that fails is an expected result.",
    "For command 8 only, set the Bash tool parameter dangerouslyDisableSandbox to true.",
    "Each command prints one result line, which is read from the tool output. When every command has run, reply with the single word done.",
    ...scripts.map((s, i) => `${i + 1}. sh ${q(s)}`),
  ].join("\n");

async function fileState(path: string): Promise<{ exists: boolean; hash: string | null }> {
  const buf = await readFile(path).catch(() => null);
  return { exists: buf !== null, hash: buf ? createHash("sha256").update(buf).digest("hex") : null };
}

/** Dispatcher git in the scratch worktree, links verified and git dirs pinned (as `GitCli` runs it, C22). */
async function pinnedGit(t: GitTarget, args: string[]): Promise<RunResult> {
  await verifyGitLinks(t);
  return run(["git", "-C", t.path, `--git-dir=${t.gitDir}`, `--work-tree=${t.path}`, ...args], {
    timeoutMs: 30_000,
    env: { ...DISPATCHER_GIT_ENV, GIT_COMMON_DIR: t.commonDir },
  });
}

/** A host the sandbox allowlist covers for probe 9, and one it does not for probe 7 (the probe settings list the former). */
export function probeHosts(allowed: string[]): { allowed: string[]; registry: string; blocked: string } {
  const plain = allowed.filter((d) => !d.includes("*"));
  const registry = plain[0] ?? "registry.npmjs.org";
  const blocked =
    ["pypi.org", "example.com", "example.org"].find((h) => !allowed.includes(h)) ?? "example.net";
  return { allowed: allowed.includes(registry) ? allowed : [...allowed, registry], registry, blocked };
}

export interface ClaudeProbeDeps {
  exec: Runner;
  /** The checkout doctor runs from: `orca worktree current` there names the repository the scratch worktree is made in. */
  cwd: string;
}

/** §13.3(b) from a real `wm-` worktree under the owner's home, with the issue kit's settings and environment. */
export async function claudeProbe(ctx: Ctx, d: ClaudeProbeDeps): Promise<ClaudeProbeResult> {
  const tier = await resolveTier("claude", { home: ctx.home });
  if (!tier) return { ok: false, detail: "no Claude default model to probe with", orcaReachable: null };
  const self = await ctx.orca.worktreeCurrent(d.cwd);
  const name = `wm-doctor-${newUlid().toLowerCase()}`;
  const kitDir = join(ctx.dirs.kit, name);
  const notes: string[] = [];
  const wt = await ctx.orca.worktreeCreate({
    repoId: self.repoId,
    name,
    baseBranch: "origin/main",
    linearIssue: "",
    comment: "wingmate doctor probe (removed when it ends)",
  });
  let target: GitTarget | null = null;
  let headBefore: string | null = null;
  let decoyDir: string | null = null;
  const created: string[] = [];
  const escapeFile = join(ctx.home, `.${name}-escape`);
  try {
    const shown = await ctx.orca.worktreeShow(wt.id);
    target = await discoverGitLinks(shown.path, null);
    const common = target.commonDir;
    decoyDir = join(common, "worktrees", `${name}-decoy`);
    await mkdir(decoyDir, { recursive: true });
    await writeFile(join(decoyDir, "HEAD"), `ref: refs/heads/${name}-decoy\n`);
    await mkdir(join(common, "hooks"), { recursive: true });
    const hosts = probeHosts(ctx.cfg.defaults.sandbox.allowedDomains);
    await mkdir(join(kitDir, "gh-empty"), { recursive: true });
    await mkdir(join(kitDir, "no-hooks"), { recursive: true });
    await mkdir(join(kitDir, "probe"), { recursive: true });
    await writeAtomic(
      join(kitDir, "gitconfig"),
      `[credential]\n\thelper =\n[core]\n\thooksPath = ${join(kitDir, "no-hooks")}\n[user]\n\tname = Wingmate Probe\n\temail = wingmate@users.noreply.github.com\n`,
    );
    const settingsFile = join(kitDir, "claude-settings.json");
    await writeAtomic(
      settingsFile,
      JSON.stringify(
        claudeSettings({
          worktreePath: shown.path,
          childWorktrees: [],
          commonDir: common,
          gitdirName: basename(target.gitDir),
          branch: shown.branch,
          baseBranch: "origin/main",
          kitDir,
          toolchainPaths: ctx.toolchainPaths,
          allowedDomains: hosts.allowed,
          role: "coordinator",
        }),
        null,
        2,
      ),
    );
    await mkdir(join(shown.path, ".wingmate"), { recursive: true });
    await writeAtomic(
      join(shown.path, ".wingmate", "record.json"),
      JSON.stringify({
        identifier: PROBE_ID,
        stage: "working",
        pipelineStage: "intake",
        provider: "claude",
        childRunId: null,
      }),
    );
    const probes = claudeProbes({
      credentials: join(ctx.dirs.config, "credentials.json"),
      commonDir: common,
      decoyHead: join(decoyDir, "HEAD"),
      escapeFile,
      worktree: shown.path,
      registryHost: hosts.registry,
      blockedHost: hosts.blocked,
      identifier: PROBE_ID,
      home: ctx.home,
    });
    const scriptOf = (n: number) => join(kitDir, "probe", `${n}.sh`);
    const scripts: string[] = [];
    for (const p of probes) {
      await writeAtomic(scriptOf(p.n), probeScript(p), 0o644);
      scripts.push(scriptOf(p.n));
    }
    const watched = {
      hook: join(common, "hooks", "pre-commit"),
      indexLock: join(common, "index.lock"),
      decoy: join(decoyDir, "HEAD"),
      escape: escapeFile,
    };
    const before = {
      hook: await fileState(watched.hook),
      indexLock: await fileState(watched.indexLock),
      decoy: await fileState(watched.decoy),
      escape: await fileState(watched.escape),
    };
    headBefore = (await pinnedGit(target, ["rev-parse", "HEAD"])).stdout.trim() || null;
    const r = await d.exec(
      [
        "claude",
        "--settings",
        settingsFile,
        "--permission-mode",
        "bypassPermissions",
        "--model",
        tier.model,
        "--strict-mcp-config",
        "--no-session-persistence",
        "-p",
        PROMPT(scripts),
        "--output-format",
        "stream-json",
        "--verbose",
      ],
      { cwd: shown.path, timeoutMs: 8 * 60_000, env: agentEnv(kitDir) },
    );
    if (r.timedOut) notes.push("claude timed out");
    if (r.truncated) notes.push("claude output truncated");
    const { failures, lines } = judge(probes, streamCalls(r.stdout), scriptOf);
    // on disk, whatever the lines say: a write that went through is an inverted result (and is undone where it can be)
    const after = {
      hook: await fileState(watched.hook),
      indexLock: await fileState(watched.indexLock),
      decoy: await fileState(watched.decoy),
      escape: await fileState(watched.escape),
    };
    for (const key of ["hook", "indexLock", "escape"] as const) {
      if (!before[key].exists && after[key].exists) {
        failures.push(`${key}: written outside the sandbox policy (${watched[key]})`);
        created.push(watched[key]);
      } else if (before[key].hash !== after[key].hash) failures.push(`${key}: modified (${watched[key]})`);
    }
    if (before.decoy.hash !== after.decoy.hash)
      failures.push("sibling_gitdir_write: the decoy gitdir's HEAD changed");
    const headAfter = (await pinnedGit(target, ["rev-parse", "HEAD"])).stdout.trim() || null;
    if (lines.get(10)?.exit === 0 && headAfter === headBefore)
      failures.push("git_commit: reported success but HEAD did not move");
    const orca = lines.get(14)?.sig;
    const orcaReachable = orca === "reachable" ? true : orca === "unreachable" ? false : null;
    const ok = failures.length === 0 && notes.length === 0 && r.code === 0;
    if (r.code !== 0 && failures.length === 0) notes.push(`claude exited ${r.code}`);
    return {
      ok,
      detail: ok
        ? `${probes.filter((p) => p.expect === "fail").length} blocked, ${probes.filter((p) => p.expect === "succeed").length} allowed as required (${tier.model})`
        : [...failures, ...notes].join("; ").slice(0, 900),
      orcaReachable,
    };
  } finally {
    for (const f of created) await rm(f, { force: true }).catch(() => undefined);
    await rm(escapeFile, { force: true }).catch(() => undefined);
    if (decoyDir) await rm(decoyDir, { recursive: true, force: true }).catch(() => undefined);
    const wtPath = target?.path;
    if (wtPath) await rm(join(wtPath, ".wingmate"), { recursive: true, force: true }).catch(() => undefined);
    // the probe's commit is dropped so Orca removes the branch as it does for an untouched worktree
    if (target && headBefore)
      await pinnedGit(target, ["reset", "-q", "--soft", headBefore]).catch(() => undefined);
    await ctx.orca.terminalClose(wt.id).catch(() => undefined);
    await ctx.orca.worktreeRm(wt.id).catch((e: unknown) => {
      ctx.log.warn({ worktree: wt.id, code: errorCode(e) }, "doctor: probe worktree not removed");
    });
    await rm(kitDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** §13.3(c): `codex exec` in a scratch git directory — the network must be blocked; whether reads outside it are is reported. */
export async function codexProbe(ctx: Ctx, d: { exec: Runner }): Promise<CodexProbeResult> {
  const dir = await mkdtemp(join(tmpdir(), "wm-doctor-codex-"));
  try {
    const init = await run(["git", "init", "-q"], { cwd: dir, timeoutMs: 30_000 });
    if (init.code !== 0)
      return { ok: false, detail: "git init failed in the scratch directory", readsBlocked: null };
    const scripts = [
      "o=$(curl -sS -m 10 -o /dev/null https://pypi.org/ 2>&1); c=$?",
      `o=$(cat ${q(join(ctx.dirs.config, "credentials.json"))} 2>&1 >/dev/null); c=$?`,
    ].map((body, i) => ({
      n: i + 1,
      name: i === 0 ? "network" : "credentials_read",
      expect: "fail" as const,
      body,
    }));
    const files: string[] = [];
    for (const p of scripts) {
      const file = join(dir, `probe-${p.n}.sh`);
      await writeFile(file, probeScript(p));
      files.push(file);
    }
    const prompt = `Run these two shell commands exactly as written, one at a time; never retry or work around a failure: (1) sh ${q(files[0] ?? "")} (2) sh ${q(files[1] ?? "")}. Then reply with only the two result lines they printed.`;
    const r = await d.exec(
      [
        "codex",
        "exec",
        "--sandbox",
        "workspace-write",
        "-c",
        "approval_policy=never",
        "-c",
        "sandbox_workspace_write.network_access=false",
        "-c",
        "project_doc_max_bytes=0",
        prompt,
      ],
      { cwd: dir, timeoutMs: 5 * 60_000 },
    );
    const lines = probeLines(`${r.stdout}\n${r.stderr}`);
    const one = (n: number): ProbeLine | null | "conflict" => {
      const all = [...new Map((lines.get(n) ?? []).map((l) => [`${l.exit}/${l.sig}`, l])).values()];
      return all.length > 1 ? "conflict" : (all[0] ?? null);
    };
    const net = one(1);
    const read = one(2);
    const netBlocked = net !== null && net !== "conflict" && net.exit !== 0 && net.sig === "net";
    const readsBlocked =
      read === null || read === "conflict" ? null : read.exit !== 0 && read.sig === "eperm";
    const describe = (l: ProbeLine | null | "conflict") =>
      l === null ? "no PROBE line" : l === "conflict" ? "conflicting lines" : `exit=${l.exit} sig=${l.sig}`;
    return {
      ok: netBlocked,
      detail: `network ${netBlocked ? "blocked" : `NOT proven blocked (${describe(net)})`}; reads outside the worktree ${readsBlocked === null ? `unknown (${describe(read)})` : readsBlocked ? "blocked" : "NOT blocked (D14)"}`,
      readsBlocked,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The credentials file the probes try to read: a canary is created only when there is none (so a failed read proves the sandbox,
 * not a missing file) and removed afterwards only while it is still the canary; a real credentials file is never written or removed.
 */
export async function withCanary<T>(credentialsFile: string, fn: () => Promise<T>): Promise<T> {
  const canary = `${JSON.stringify({ canary: `wingmate-doctor-${newUlid()}` })}\n`;
  const dir = join(credentialsFile, "..");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const made = await createExclusive(credentialsFile, canary, 0o600);
  try {
    return await fn();
  } finally {
    if (made && (await readText(credentialsFile).catch(() => null)) === canary)
      await rm(credentialsFile, { force: true }).catch(() => undefined);
  }
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

/**
 * Spike §3.4b: the section of `claude --settings <file> doctor` that starts at the line `Invalid settings` and ends at the next blank
 * line; null when there is none. Returns the key paths it names (`sandbox.network.strictAllowlist`), possibly none. The command
 * exits 0 either way, so only this text counts.
 */
export function invalidSettings(text: string): string[] | null {
  const lines = text.replace(ANSI, "").split("\n");
  const start = lines.findIndex((l) => /^\s*Invalid settings\b/i.test(l));
  if (start < 0) return null;
  const keys: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (!l.trim()) break;
    const k = /[›>]\s*([A-Za-z0-9_.[\]-]+):/.exec(l)?.[1];
    if (k) keys.push(k);
  }
  return keys;
}

const SandboxStatus = z
  .object({
    enabled: z.boolean(),
    strictMode: z.boolean(),
    enabledSource: z.string().optional(),
    strictModeSource: z.string().optional(),
  })
  .passthrough();
export type SandboxStatus = z.infer<typeof SandboxStatus>;

/** The JSON line `claude --settings <file> sandbox status` prints (spike §3.4b); null when there is none. */
export function sandboxStatus(text: string): SandboxStatus | null {
  const clean = text.replace(ANSI, "");
  const candidates = clean.split("\n").filter((l) => l.trim().startsWith("{"));
  const first = clean.indexOf("{");
  const last = clean.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(clean.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const parsed = SandboxStatus.safeParse(JSON.parse(c));
      if (parsed.success) return parsed.data;
    } catch {
      // not this candidate
    }
  }
  return null;
}

/**
 * R12, quota-free: a settings file written exactly as the kit writes it must validate (no "Invalid settings" section — an invalid
 * value silently drops the whole sandbox block) and load from the file itself (`sandbox status`: enabled and strict, both from the
 * `policy` source the `--settings` file is; a sandbox enabled by other settings proves nothing about the kit's file).
 */
export async function settingsPosture(ctx: Ctx, exec: Runner): Promise<ProbeResult> {
  const kitDir = join(ctx.dirs.kit, "_doctor");
  await mkdir(kitDir, { recursive: true });
  const file = join(kitDir, "claude-settings.json");
  const placeholder = join(ctx.home, "orca", "workspaces", "_doctor");
  const hosts = probeHosts(ctx.cfg.defaults.sandbox.allowedDomains);
  await writeAtomic(
    file,
    JSON.stringify(
      claudeSettings({
        worktreePath: placeholder,
        childWorktrees: [],
        commonDir: join(ctx.home, "orca", "projects", "_doctor", ".git"),
        gitdirName: "_doctor",
        branch: "wm-doctor",
        baseBranch: "origin/main",
        kitDir,
        toolchainPaths: ctx.toolchainPaths,
        allowedDomains: hosts.allowed,
        role: "coordinator",
      }),
      null,
      2,
    ),
  );
  const doc = await exec(["claude", "--settings", file, "doctor"], { timeoutMs: 60_000, stdin: "" });
  const st = await exec(["claude", "--settings", file, "sandbox", "status"], {
    timeoutMs: 60_000,
    stdin: "",
  });
  const invalid = invalidSettings(`${doc.stdout}\n${doc.stderr}`);
  const status = sandboxStatus(st.stdout) ?? sandboxStatus(st.stderr);
  const problems: string[] = [];
  if (doc.timedOut) problems.push("`claude doctor` timed out");
  if (invalid) problems.push(`Invalid settings reported${invalid.length ? ` (${invalid.join(", ")})` : ""}`);
  if (!status) problems.push("`sandbox status` printed no status JSON");
  else {
    if (!status.enabled) problems.push("sandbox enabled=false (the whole sandbox block was dropped)");
    if (!status.strictMode) problems.push("strictMode=false (unsandboxed commands not closed)");
    if (status.enabledSource !== "policy" || status.strictModeSource !== "policy")
      problems.push(
        `the status does not come from the kit file (enabledSource=${status.enabledSource ?? "?"}, strictModeSource=${status.strictModeSource ?? "?"})`,
      );
  }
  return problems.length
    ? { ok: false, detail: problems.join("; ") }
    : {
        ok: true,
        detail: "kit settings validate and load from the file (sandbox enabled, strict, source policy)",
      };
}
