// tests/unit/ops/probe.test.ts — doctor's live probes, without a model: the PROBE-line rules, the shell classifier run by real `sh`,
// the Claude probe end to end against a real temp worktree (a simulated agent stands in for `claude -p`), the Codex probe, the
// canary, and the quota-free posture check. No test starts claude, codex, orca or touches the network or the real home.
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { blankedEnv, shellQuote } from "../../../src/kit/settings";
import { TOKEN_ENV } from "../../../src/linear/envToken";
import {
  CLASSIFY,
  PROBE_ID,
  claudeProbe,
  claudeProbes,
  codexProbe,
  credentialNames,
  invalidSettings,
  judge,
  probeLaunch,
  probeLines,
  probeScript,
  sandboxStatus,
  settingsPosture,
  streamCalls,
  withCanary,
} from "../../../src/ops/probe";
import { OrcaError } from "../../../src/orca/cli";
import type { RunOptions } from "../../../src/shared/exec";
import { childEnv, run } from "../../../src/shared/exec";
import { SANDBOX_STATUS_OK, fakeExec, gitIn, ok } from "../../fakes/fakeExec";
import { world } from "../../sim/harness";

const PATHS = {
  credentials: "/h/.config/wingmate/credentials.json",
  commonDir: "/h/orca/projects/wingmate-agents/.git",
  decoyHead: "/h/orca/projects/wingmate-agents/.git/worktrees/wm-doctor-x-decoy/HEAD",
  escapeFile: "/h/.wm-doctor-x-escape",
  worktree: "/h/orca/workspaces/wingmate-agents/wm-doctor-x",
  registryHost: "registry.npmjs.org",
  blockedHost: "pypi.org",
  identifier: PROBE_ID,
  home: "/h",
  // N1: what the kit blanks for every agent — its fixed names plus a user-level Claude env key — and what probe 13 fails on
  blanked: Object.keys(blankedEnv(["LANGFUSE_SECRET_KEY"])),
};
const PROBES = claudeProbes(PATHS);
/** What a holding sandbox prints (spike §3.4/§3.4a): each must-fail probe blocked for its own reason, each must-succeed one fine. */
const GOOD: Record<number, string> = {
  1: "exit=1 sig=eperm",
  2: "exit=128 sig=net",
  3: "exit=4 sig=auth",
  4: "exit=1 sig=eperm",
  5: "exit=1 sig=eperm",
  6: "exit=1 sig=eperm",
  7: "exit=56 sig=net",
  8: "exit=1 sig=eperm",
  9: "exit=0 sig=http200",
  10: "exit=0 sig=none",
  11: "exit=0 sig=ok",
  12: "exit=0 sig=local",
  13: "exit=0 sig=unset",
  14: "exit=0 sig=reachable",
  15: "exit=1 sig=auth",
  16: "exit=128 sig=auth",
  17: "exit=2 sig=usage",
  18: "exit=2 sig=methodrequired",
};
const lines = (over: Record<number, string | null> = {}) =>
  Object.entries({ ...GOOD, ...over })
    .filter(([, v]) => v !== null)
    .map(([n, v]) => `PROBE ${n} exit=${v?.replace(/^exit=/, "")}`)
    .join("\n");
/** Spike §3.4a: the block Claude Code appends to a Bash tool result whose connection the sandbox refused. */
const violation = (host: string) =>
  `<sandbox_violations>\ndeny network-outbound ${host}:443 (host is not on the allow list)\n</sandbox_violations>`;
function violationFor(line: string, violations: Record<number, string>): string {
  const n = Number(/^PROBE (\d+)/.exec(line)?.[1]);
  const host = violations[n];
  return host && !/ exit=0 /.test(line) ? violation(host) : "";
}
/** Where a probe's script lives in the kit dir: the path a Bash call must run for its tool result to count for that probe. */
const SCRIPT = (n: number, kit = "/k") => `${kit}/probe/${n}.sh`;
const scriptOf = (n: number) => SCRIPT(n);
interface CallSpec {
  n: number;
  text: string;
  /** The Bash tool parameter dangerouslyDisableSandbox: true. */
  escape?: boolean;
  isError?: boolean;
  /** The command the model ran (default: `sh <the probe's script>`). */
  command?: string;
}
/** Claude's stream-json: per call one assistant tool_use (Bash) and its user tool_result, joined by id; then the final reply. */
function streamOf(calls: CallSpec[], o: { kit?: string; final?: string } = {}): string {
  const out = [JSON.stringify({ type: "system", subtype: "init", model: "claude-fable-5-1" })];
  calls.forEach((c, i) => {
    const input = {
      command: c.command ?? `sh ${SCRIPT(c.n, o.kit)}`,
      ...(c.escape ? { dangerouslyDisableSandbox: true } : {}),
    };
    out.push(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input }] },
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: `t${i}`,
              ...(c.isError ? { is_error: true } : {}),
              content: [{ type: "text", text: c.text }],
            },
          ],
        },
      }),
    );
  });
  out.push(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: o.final ?? "" }));
  return `${out.join("\n")}\n`;
}
/**
 * The calls a model makes for `tools`, one PROBE line each: every line comes back in the tool result of the call that ran that
 * probe's own script, the network probes' with their violation, and command 8 runs with dangerouslyDisableSandbox (unless `noEscape`).
 */
function stream(
  tools: string,
  o: { kit?: string; final?: string; violations?: Record<number, string>; noEscape?: boolean } = {},
): string {
  const violations = o.violations ?? { 2: "github.com", 7: "pypi.org" };
  const calls = tools
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const n = Number(/^PROBE (\d+)/.exec(l)?.[1]);
      return { n, text: `${l}\n${violationFor(l, violations)}`, escape: n === 8 && !o.noEscape };
    });
  return streamOf(calls, o);
}
const judged = (stdout: string) => judge(PROBES, streamCalls(stdout), scriptOf).failures;
/** Every probe's call as a holding sandbox answers it, except those `over` replaces (null drops the call). */
const callsExcept = (over: Record<number, CallSpec | null>): CallSpec[] =>
  PROBES.map((p) => p.n)
    .map((n) =>
      n in over
        ? (over[n] ?? null)
        : {
            n,
            text: `PROBE ${n} exit=${GOOD[n]?.replace(/^exit=/, "")}\n${violationFor(`PROBE ${n} ${GOOD[n]}`, { 2: "github.com", 7: "pypi.org" })}`,
            escape: n === 8,
          },
    )
    .filter((c): c is CallSpec => c !== null);

describe("PROBE lines (inverted or missing lines fail the probe)", () => {
  test("a holding sandbox passes every probe", () => {
    expect(judged(stream(lines(), { final: lines() }))).toEqual([]);
    expect(judged(streamOf(callsExcept({})))).toEqual([]);
  });
  test("a missing line fails; an inverted must-fail or must-succeed result fails", () => {
    expect(judged(stream(lines({ 4: null }), { final: lines({ 4: null }) }))).toEqual([
      "hook_write: no PROBE line",
    ]);
    expect(judged(stream(lines({ 1: "0 sig=none", 10: "1 sig=eperm" }), { final: lines() }))).toEqual([
      "credentials_read: ALLOWED (exit=0 sig=none)",
      "git_commit: failed (exit=1 sig=eperm)",
    ]);
  });
  test("SEC-1: credential variables seen inside the sandbox fail probe 13, and their names (never values) come from its own tool result", () => {
    const out = streamOf(
      callsExcept({
        13: {
          n: 13,
          text: "CREDENV GITHUB_PERSONAL_ACCESS_TOKEN LANGFUSE_SECRET_KEY \nPROBE 13 exit=1 sig=set",
        },
      }),
    );
    expect(judged(out)).toEqual(["credential_env_empty: failed (exit=1 sig=set)"]);
    expect(credentialNames(streamCalls(out), scriptOf(13))).toEqual([
      "GITHUB_PERSONAL_ACCESS_TOKEN",
      "LANGFUSE_SECRET_KEY",
    ]);
    // a name typed by the model into another call's result is not probe 13's
    const elsewhere = streamOf(
      callsExcept({ 12: { n: 12, text: "CREDENV FAKE_TOKEN\nPROBE 12 exit=0 sig=local" } }),
    );
    expect(credentialNames(streamCalls(elsewhere), scriptOf(13))).toEqual([]);
  });
  test("SEC-2: gh and git must find no stored GitHub credential — a network block no longer proves gh found none; a token or credential handed back fails", () => {
    expect(
      judged(
        stream(lines({ 3: "1 sig=net" }), {
          violations: { 2: "github.com", 3: "api.github.com", 7: "pypi.org" },
        }),
      ),
    ).toEqual(["gh_api_user: gh found a credential or failed otherwise: control unproven (exit=1 sig=net)"]);
    expect(judged(stream(lines({ 15: "0 sig=none", 16: "0 sig=none" })))).toEqual([
      "gh_stored_token: ALLOWED (exit=0 sig=none)",
      "git_credential_fill: ALLOWED (exit=0 sig=none)",
    ]);
    const token = PROBES.find((x) => x.name === "gh_stored_token");
    const fill = PROBES.find((x) => x.name === "git_credential_fill");
    expect(token?.body).toContain("gh auth token 2>&1 >/dev/null"); // a token is discarded, never printed
    expect(fill?.body).toContain("git credential fill 2>&1 >/dev/null");
  });
  test("a private-repo style auth failure is not accepted as network proof", () => {
    const f = judged(stream(lines({ 2: "128 sig=auth" })));
    expect(f.length).toBe(1);
    expect(f[0]).toContain("github_ls_remote");
    expect(f[0]).toContain("an auth failure proves no network block");
    expect(
      judged(stream(lines({ 7: "6 sig=other", 1: "1 sig=enoent" }))).map((x) => x.split(":")[0]),
    ).toEqual(["credentials_read", "unlisted_host"]);
  });
  test("a network block must be the sandbox's: without its network-outbound violation for the host in that command's result, net is not proof", () => {
    expect(judged(stream(lines(), { violations: { 7: "pypi.org" } }))).toEqual([
      "github_ls_remote: blocked, but no sandbox violation for github.com in its tool result (a DNS or firewall failure proves nothing about the sandbox)",
    ]);
    expect(judged(stream(lines(), { violations: { 2: "example.com", 7: "pypi.org" } })).length).toBe(1);
    // github.com's violation in another command's result (probe 7's) is no proof for probe 2
    const misplaced = callsExcept({
      2: { n: 2, text: "PROBE 2 exit=128 sig=net" },
      7: { n: 7, text: `PROBE 7 exit=56 sig=net\n${violation("pypi.org")}\n${violation("github.com")}` },
    });
    expect(judged(streamOf(misplaced)).map((x) => x.split(":")[0])).toEqual(["github_ls_remote"]);
  });
  test("F3: only the tool result of the call that ran a probe's own script counts — never the model's reply", () => {
    expect(judged(stream(lines({ 2: "0 sig=none" }), { final: lines() }))).toEqual([
      "github_ls_remote: ALLOWED (exit=0 sig=none)",
    ]);
    // a command that never ran fails, whatever the reply claims: the credentials read, the three write probes
    expect(judged(stream(lines({ 1: null }), { final: lines() }))).toEqual([
      "credentials_read: no PROBE line",
    ]);
    expect(judged(stream(lines({ 4: null, 5: null, 6: null }), { final: lines() }))).toEqual([
      "hook_write: no PROBE line",
      "sibling_gitdir_write: no PROBE line",
      "index_lock_write: no PROBE line",
    ]);
    // the reply alone settles nothing: every required probe fails (17 of 18; the orca line is only reported)
    const replyOnly = judged(stream("", { final: lines() }));
    expect(replyOnly.length).toBe(17);
    expect(replyOnly).toContain("credentials_read: no PROBE line");
    expect(judged(lines())).toEqual(replyOnly); // not stream-json at all
    // a line printed in another command's result (probe 3's call printing probe 1's line) is not probe 1's result
    const borrowed = callsExcept({
      1: null,
      3: { n: 3, text: "PROBE 3 exit=4 sig=auth\nPROBE 1 exit=1 sig=eperm" },
    });
    expect(judged(streamOf(borrowed))).toEqual(["credentials_read: no PROBE line"]);
    // a longer script name that starts with the probe's path is another script
    const lookalike = callsExcept({
      1: { n: 1, text: "PROBE 1 exit=1 sig=eperm", command: "sh /k/probe/1.sh.bak" },
    });
    expect(judged(streamOf(lookalike))).toEqual(["credentials_read: no PROBE line"]);
  });
  test("F1/F4: command 8 counts only as the Bash call that set dangerouslyDisableSandbox: true", () => {
    // run sandboxed (the parameter absent), its eperm line proves nothing about the escape hatch
    expect(judged(stream(lines(), { noEscape: true }))).toEqual([
      "unsandboxed_bash: not exercised (no Bash call ran command 8 with dangerouslyDisableSandbox: true)",
    ]);
    // `refused` typed in the reply, with no refused tool call: the flagged call printed nothing and was no error
    const replyRefused = callsExcept({ 8: { n: 8, text: "", escape: true } });
    expect(judged(streamOf(replyRefused, { final: "PROBE 8 exit=refused sig=refused" }))).toEqual([
      "unsandboxed_bash: no PROBE line",
    ]);
    expect(judged(streamOf(callsExcept({ 8: null }), { final: "PROBE 8 exit=refused sig=refused" }))).toEqual(
      ["unsandboxed_bash: not exercised (no Bash call ran command 8 with dangerouslyDisableSandbox: true)"],
    );
    // a `refused` line printed in a tool result is no result either: only the harness refusing the call is
    const printed = callsExcept({ 8: { n: 8, text: "PROBE 8 exit=refused sig=refused", escape: true } });
    expect(judged(streamOf(printed))).toEqual(["unsandboxed_bash: no PROBE line"]);
    // the escape went through: an inverted result
    expect(
      judged(streamOf(callsExcept({ 8: { n: 8, text: "PROBE 8 exit=0 sig=none", escape: true } }))),
    ).toEqual(["unsandboxed_bash: ALLOWED (exit=0 sig=none)"]);
  });
  test("F1/F4: the harness refusing the flagged call (an error tool result, no PROBE line) is the control holding", () => {
    const refusal =
      "<tool_use_error>dangerouslyDisableSandbox is not allowed: unsandboxed commands are disabled by policy</tool_use_error>";
    expect(
      judged(streamOf(callsExcept({ 8: { n: 8, text: refusal, escape: true, isError: true } }))),
    ).toEqual([]);
    expect(judged(streamOf(callsExcept({ 8: { n: 8, text: refusal, escape: true } })))).toEqual([]);
    expect(
      judged(streamOf(callsExcept({ 8: { n: 8, text: "Error: denied", escape: true, isError: true } }))),
    ).toEqual([]);
    // a refused call without the parameter is not the escape hatch refused
    expect(judged(streamOf(callsExcept({ 8: { n: 8, text: refusal, isError: true } })))).toEqual([
      "unsandboxed_bash: not exercised (no Bash call ran command 8 with dangerouslyDisableSandbox: true)",
    ]);
    // an error result does not excuse a missing line for any other probe
    expect(judged(streamOf(callsExcept({ 1: { n: 1, text: refusal, isError: true } })))).toEqual([
      "credentials_read: no PROBE line",
    ]);
  });
  test("F5 + SEC-2: gh api user must fail on auth alone; gh missing, an unclassified failure or a network refusal (gh found a token) proves nothing", () => {
    expect(judged(stream(lines({ 3: "127 sig=other" })))).toEqual([
      "gh_api_user: gh found a credential or failed otherwise: control unproven (exit=127 sig=other)",
    ]);
    expect(judged(stream(lines({ 3: "126 sig=eperm" })))).toEqual([
      "gh_api_user: gh found a credential or failed otherwise: control unproven (exit=126 sig=eperm)",
    ]);
    expect(judged(stream(lines({ 3: "1 sig=enoent" }))).map((x) => x.split(":")[0])).toEqual(["gh_api_user"]);
    // SEC-2: even the sandbox's own block of api.github.com no longer passes — gh only goes there with a token in hand
    expect(judged(stream(lines({ 3: "1 sig=net" })))).toEqual([
      "gh_api_user: gh found a credential or failed otherwise: control unproven (exit=1 sig=net)",
    ]);
    expect(judged(stream(lines({ 3: "0 sig=none" })))).toEqual(["gh_api_user: ALLOWED (exit=0 sig=none)"]);
  });
  test("two different lines for one probe conflict", () => {
    const dup = judged(stream(`${lines()}\nPROBE 6 exit=0 sig=none`));
    expect(dup[0]).toContain("index_lock_write: conflicting results");
  });
  test("required CLI paths need their exact refusal and exit: hidden role context, child ENOENT, and false successes fail", () => {
    expect(judged(stream(lines({ 17: "2 sig=other", 18: "2 sig=enoent" })))).toEqual([
      "wingmate_coordinator_role: unexpected result (exit=2 sig=other)",
      "wingmate_child_git: unexpected result (exit=2 sig=enoent)",
    ]);
    expect(judged(stream(lines({ 17: "0 sig=usage", 18: "1 sig=methodrequired" })))).toEqual([
      "wingmate_coordinator_role: failed (exit=0 sig=usage)",
      "wingmate_child_git: failed (exit=1 sig=methodrequired)",
    ]);
    expect(judged(stream(lines({ 17: null, 18: null })))).toEqual([
      "wingmate_coordinator_role: no PROBE line",
      "wingmate_child_git: no PROBE line",
    ]);
  });
  test("a registry reply must be an HTTP success; a missing report line (orca) is no failure; literal script text never parses", () => {
    expect(judged(stream(lines({ 9: "0 sig=http403" })))).toEqual([
      "allowlisted_registry: unexpected result (exit=0 sig=http403)",
    ]);
    expect(judged(stream(lines({ 14: null })))).toEqual([]);
    expect(probeLines('echo "PROBE 2 exit=$c sig=$(classify "$o")"').size).toBe(0);
    expect(probeLines("PROBE 8 exit=refused sig=refused").size).toBe(0); // the scripts print numbers only
    for (const p of PROBES) expect(probeLines(probeScript(p)).size).toBe(0); // the script's own echo line has `$c`
  });
  test("streamCalls joins each Bash tool_use to its tool_result by id; other tools and unknown ids are ignored", () => {
    const s = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "running" },
            {
              type: "tool_use",
              id: "a",
              name: "Bash",
              input: { command: "sh /k/probe/8.sh", dangerouslyDisableSandbox: true },
            },
            { type: "tool_use", id: "b", name: "Read", input: { file_path: "/k/probe/1.sh" } },
            {
              type: "tool_use",
              id: "c",
              name: "Bash",
              input: { command: "sh /k/probe/2.sh", dangerouslyDisableSandbox: "true" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "a",
              is_error: true,
              content: "<tool_use_error>no</tool_use_error>",
            },
            { type: "tool_result", tool_use_id: "b", content: "PROBE 1 exit=1 sig=eperm" },
            { type: "tool_result", tool_use_id: "zzz", content: "PROBE 2 exit=1 sig=net" },
          ],
        },
      }),
      "not json",
    ].join("\n");
    expect(streamCalls(s)).toEqual([
      {
        id: "a",
        command: "sh /k/probe/8.sh",
        escape: true,
        result: { text: "<tool_use_error>no</tool_use_error>", isError: true },
      },
      { id: "c", command: "sh /k/probe/2.sh", escape: false, result: null },
    ]);
  });
});

describe("probe scripts (real sh, temp files only)", () => {
  const sh = async (script: string) => (await run(["sh", "-c", script], { timeoutMs: 10_000 })).stdout.trim();
  test("the classifier tells a network block from an auth failure and a permission denial", async () => {
    const cls = async (stderr: string) => sh(`${CLASSIFY}\nclassify ${JSON.stringify(stderr)}`);
    expect(
      await cls(
        "fatal: unable to access 'https://github.com/git/git.git/': CONNECT tunnel failed, response 403",
      ),
    ).toBe("net");
    expect(await cls("curl: (6) Could not resolve host: pypi.org")).toBe("net");
    expect(
      await cls("fatal: could not read Username for 'https://github.com': terminal prompts disabled"),
    ).toBe("auth");
    expect(await cls("git@github.com: Permission denied (publickey).")).toBe("auth");
    expect(await cls("To get started with GitHub CLI, please run:  gh auth login")).toBe("auth");
    expect(await cls("no oauth token found for github.com")).toBe("auth"); // SEC-2: `gh auth token` with none stored
    // R35: Claude Code's shell sets credential.interactive=false, so git's "no credential" is this (exit 128; git 2.53 live probe)
    expect(await cls("fatal: unable to get password from user")).toBe("auth");
    expect(await cls("cat: /h/.config/wingmate/credentials.json: Operation not permitted")).toBe("eperm");
    expect(await cls("sh: /x/hooks/pre-commit: No such file or directory")).toBe("enoent");
    expect(await cls("")).toBe("none");
  });
  test("each script prints exactly one PROBE line for its own number; without a sandbox the write probes go through", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wm-probe-sh-"));
    const common = join(dir, "common");
    await run(["mkdir", "-p", join(common, "hooks"), join(common, "worktrees", "decoy")], {});
    writeFileSync(join(common, "worktrees", "decoy", "HEAD"), "ref: refs/heads/decoy\n");
    const creds = join(dir, "credentials.json");
    writeFileSync(creds, '{"canary":"x"}');
    chmodSync(creds, 0o000);
    const p = claudeProbes({
      ...PATHS,
      credentials: creds,
      commonDir: common,
      decoyHead: join(common, "worktrees", "decoy", "HEAD"),
      escapeFile: join(dir, ".escape"),
    });
    for (const n of [1, 4, 5, 6, 8]) {
      const probe = p.find((x) => x.n === n);
      if (!probe) throw new Error(`no probe ${n}`);
      const out = await sh(probeScript(probe));
      expect(out.split("\n").length).toBe(1);
      const parsed = probeLines(out).get(n);
      expect(parsed?.length).toBe(1);
      if (n === 1)
        expect(parsed?.[0]?.sig).toBe("eperm"); // unreadable file: denied, and never printed
      else expect(parsed?.[0]?.exit).toBe(0); // no sandbox here: the write went through
    }
    expect(existsSync(join(common, "index.lock"))).toBe(true);
    expect(existsSync(join(dir, ".escape"))).toBe(true);
    // the decoy's HEAD changed: what the dispatcher's disk check compares (it exists only for the probe)
    expect(readFileSync(join(common, "worktrees", "decoy", "HEAD"), "utf8")).toBe(
      "ref: refs/heads/decoy\nwingmate-probe\n",
    );
  });
  test("the probes whose body sets their own class (9, 11–14, 17–18) print a parseable PROBE line under the system sh (bash 3.2 as sh on macOS)", async () => {
    for (const [n, o] of [
      [9, "http200"],
      [11, "ok"],
      [12, "local"],
      [13, "unset"],
      [14, "reachable"],
      [14, "Some Other Text"],
      [17, "usage"],
      [18, "methodrequired"],
    ] as const) {
      const out = await sh(
        probeScript({ n, name: "stub", expect: "report", body: `o=${JSON.stringify(o)}; c=0` }),
      );
      expect(probeLines(out).get(n)).toEqual([{ exit: 0, sig: o === "Some Other Text" ? "other" : o }]);
    }
  });
  test("the CLI probes exercise coordinator authorization and child git, without local writes or external actions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wm-probe-cli-"));
    const bin = join(dir, "bin");
    const wt = join(dir, "worktree");
    mkdirSync(bin);
    mkdirSync(join(wt, ".wingmate"), { recursive: true });
    const record = JSON.stringify({
      identifier: PROBE_ID,
      stage: "working",
      pipelineStage: "intake",
      provider: "claude",
      childRunId: null,
    });
    writeFileSync(join(wt, ".wingmate", "record.json"), record);
    const launch = JSON.stringify(probeLaunch(`probe::${wt}`, join(wt, ".git"), join(dir, "kit")));
    writeFileSync(join(wt, ".wingmate", "launch.json"), launch);
    expect((await gitIn(wt, ["init", "-q"])).code).toBe(0);
    await commit(wt);
    const wingmate = join(bin, "wingmate");
    writeFileSync(
      wingmate,
      `#!/bin/sh\nexec ${shellQuote([process.execPath, resolve("bin/wingmate.ts")])} "$@"\n`,
      { mode: 0o755 },
    );
    const git = join(bin, "git");
    const invoked = join(dir, "git-invoked");
    const gitPath = Bun.which("git");
    if (!gitPath) throw new Error("git missing from the test host");
    writeFileSync(
      git,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${shellQuote([invoked])}\nexec ${shellQuote([gitPath])} "$@"\n`,
      { mode: 0o755 },
    );
    const probes = claudeProbes({ ...PATHS, worktree: wt });
    const execute = async (n: number, role: string | null, path = bin) => {
      const probe = probes.find((p) => p.n === n);
      if (!probe) throw new Error(`no probe ${n}`);
      const r = await run(
        [
          "env",
          "-i",
          `HOME=${dir}`,
          `PATH=${path}`,
          ...(role === null ? [] : [`WINGMATE_ROLE=${role}`]),
          "/bin/sh",
          "-c",
          probeScript(probe),
        ],
        { timeoutMs: 10_000 },
      );
      expect(r.code).toBe(0); // the script reports the command's own exit in its PROBE line
      return probeLines(r.stdout).get(n);
    };
    expect(await execute(17, "coordinator")).toEqual([{ exit: 2, sig: "usage" }]);
    expect(existsSync(invoked)).toBe(false); // malformed spawn stops before any child or launcher
    expect(await execute(17, null)).toEqual([{ exit: 2, sig: "other" }]);
    expect(await execute(17, "worker")).toEqual([{ exit: 2, sig: "other" }]);
    expect(await execute(18, "coordinator")).toEqual([{ exit: 2, sig: "methodrequired" }]);
    expect(readFileSync(invoked, "utf8")).toBe("rev-parse\n--verify\n-q\nHEAD\n");
    // Leave wingmate resolvable but no git in PATH: internal_error is not an expected method refusal.
    const noGitBin = join(dir, "no-git");
    mkdirSync(noGitBin);
    writeFileSync(join(noGitBin, "wingmate"), readFileSync(wingmate), { mode: 0o755 });
    const missingGit = await execute(18, "coordinator", noGitBin);
    expect(missingGit?.[0]?.exit).toBe(2);
    expect(missingGit?.[0]?.sig).not.toBe("methodrequired");
    // A git process that starts but fails to resolve HEAD must also fail the dispatcher-mode probe.
    writeFileSync(git, "#!/bin/sh\nexit 128\n", { mode: 0o755 });
    expect(await execute(18, "coordinator")).toEqual([{ exit: 2, sig: "other" }]);
    expect(readdirSync(join(wt, ".wingmate")).sort()).toEqual(["launch.json", "record.json"]);
    expect(readFileSync(join(wt, ".wingmate", "record.json"), "utf8")).toBe(record);
    expect(readFileSync(join(wt, ".wingmate", "launch.json"), "utf8")).toBe(launch);
  });
  /** Probe 13's script run by real `sh` under `env -i` with only PATH and `vars`: its output, as the tool result would carry it. */
  const probe13In = async (vars: string[]) => {
    const probe = PROBES.find((x) => x.n === 13);
    if (!probe) throw new Error("no probe 13");
    expect(probe.name).toBe("credential_env_empty");
    const argv = ["env", "-i", `PATH=${process.env.PATH ?? "/usr/bin:/bin"}`, ...vars];
    return (await run([...argv, "sh", "-c", probeScript(probe)], {})).stdout.trim();
  };
  /** What an Orca terminal running Claude Code puts in every agent shell (names seen on the owner's host; the values are made up). */
  const ORCA_CLAUDE_ENV = [
    "GIT_CONFIG_COUNT=2",
    "GIT_CONFIG_KEY_0=credential.interactive",
    "GIT_CONFIG_VALUE_0=never",
    "GIT_CONFIG_KEY_1=credential.guiPrompt",
    "GIT_CONFIG_VALUE_1=false",
    "ORCA_TERMINAL_HANDLE=term_value",
    "ORCA_AGENT_TOKEN=pane-value",
    "CLAUDECODE=1",
    "CLAUDE_CODE_ENTRYPOINT=cli",
    "CLAUDE_CODE_MESSAGING_TOKEN=msg-value",
    "CLAUDE_CODE_SSE_PORT=50123",
    "ANTHROPIC_API_KEY=sk-ant-value",
  ];
  /** The kit's blanks as an agent shell has them: every name probe 13 fails on, set but empty. */
  const BLANKED_EMPTY = PATHS.blanked.map((n) => `${n}=`);
  test("N1 (R32): probe 13 passes in an Orca terminal running Claude Code — their own variables (Orca's, Claude Code's, GIT_CONFIG_KEY_n) are named in a note, never a failure, never valued", async () => {
    const out = await probe13In([...ORCA_CLAUDE_ENV, ...BLANKED_EMPTY]);
    expect(probeLines(out).get(13)).toEqual([{ exit: 0, sig: "unset" }]);
    expect(out).not.toContain("CREDENV");
    expect(out).toContain(
      "CREDNOTE ANTHROPIC_API_KEY CLAUDE_CODE_MESSAGING_TOKEN GIT_CONFIG_KEY_0 GIT_CONFIG_KEY_1 ORCA_AGENT_TOKEN",
    );
    expect(out).not.toContain("value");
  });
  test("N1 (R32): a non-empty GITHUB_TOKEN — or any variable the kit blanks, a user-level Claude env key included — fails probe 13, named, never valued; a credential-named variable the kit does not blank is only noted", async () => {
    const github = await probe13In([...ORCA_CLAUDE_ENV, ...BLANKED_EMPTY, "GITHUB_TOKEN=ghp_value"]);
    expect(probeLines(github).get(13)).toEqual([{ exit: 1, sig: "set" }]);
    expect(github).toContain("CREDENV GITHUB_TOKEN");
    expect(github).not.toContain("value");
    const user = await probe13In([
      "GH_TOKEN=",
      "LANGFUSE_SECRET_KEY=sk-lf-value",
      "GITHUB_PERSONAL_ACCESS_TOKEN=ghp_value",
      "langfuse_secret_key=sk-lf-value",
      "OPENAI_API_KEY=sk-value",
      "PATHLIKE=1",
    ]);
    expect(probeLines(user).get(13)).toEqual([{ exit: 1, sig: "set" }]);
    expect(user).toContain("CREDENV GITHUB_PERSONAL_ACCESS_TOKEN LANGFUSE_SECRET_KEY");
    expect(user).toContain("CREDNOTE OPENAI_API_KEY langfuse_secret_key");
    expect(user).not.toContain("value");
    const other = await probe13In(["OPENAI_API_KEY=sk-value", ...BLANKED_EMPTY]);
    expect(probeLines(other).get(13)).toEqual([{ exit: 0, sig: "unset" }]);
    expect(other).toContain("CREDNOTE OPENAI_API_KEY");
  });
  test("the token probe never echoes a token, and the credentials probe discards what it reads", () => {
    const token = PROBES.find((x) => x.name === "credential_env_empty");
    expect(token?.body).toContain("sed -n");
    expect(token?.body).not.toMatch(/echo "?\$\{?GITHUB_TOKEN/);
    expect(PROBES.find((x) => x.n === 1)?.body).toContain(">/dev/null");
    expect(PROBES.find((x) => x.n === 2)?.body).toContain("https://github.com/git/git.git"); // public: no auth needed
  });
});

interface Seen {
  argv: string[];
  opts: RunOptions;
  settings: {
    sandbox: {
      filesystem: { denyWrite: string[] };
      network: { allowedDomains: string[]; strictAllowlist: boolean };
    };
  };
}
/** `claude -p` simulated: `act` does what the agent's commands would have done (or not); the reply is stream-json. */
function fakeClaude(act: (cwd: string, kit: string) => Promise<string>, seen: Seen[]) {
  return fakeExec([
    {
      match: (a) => a[0] === "claude" && a.includes("-p"),
      reply: async (argv, opts) => {
        const settingsFile = argv[argv.indexOf("--settings") + 1] ?? "";
        seen.push({
          argv,
          opts,
          settings: JSON.parse(readFileSync(settingsFile, "utf8")) as Seen["settings"],
        });
        return ok(await act(opts.cwd ?? "", dirname(settingsFile)), "");
      },
    },
  ]);
}
const commit = async (cwd: string) => {
  const r = await gitIn(cwd, ["commit", "--allow-empty", "-q", "-m", "probe"]);
  if (r.code !== 0) throw new Error(`commit failed: ${r.stderr}`);
};

describe("claudeProbe (a real wm-doctor worktree; the agent simulated)", () => {
  test("a holding sandbox passes; argv, environment and settings are the kit's; everything the probe made is removed", async () => {
    const w = await world();
    const seen: Seen[] = [];
    const exec = fakeClaude(async (cwd, kit) => {
      expect(JSON.parse(readFileSync(join(cwd, ".wingmate", "launch.json"), "utf8")).spawnMode).toBe(
        "dispatcher",
      );
      await commit(cwd);
      return stream(lines(), { kit });
    }, seen);
    const r = await claudeProbe(w.ctx, { exec: exec.exec, cwd: "/wt/self" });
    expect(r).toMatchObject({ ok: true, orcaReachable: true });
    expect(r.detail).toContain("10 blocked, 7 allowed as required");
    const s = seen[0];
    if (!s) throw new Error("claude was not run");
    const wtPath = s.opts.cwd ?? "";
    expect(basename(wtPath)).toMatch(/^wm-doctor-[0-9a-z]{26}$/);
    expect(wtPath.startsWith(w.root)).toBe(true);
    const kit = join(w.dirs.kit, basename(wtPath));
    expect(s.argv).toEqual([
      "claude",
      "--settings",
      join(kit, "claude-settings.json"),
      "--permission-mode",
      "bypassPermissions",
      "--model",
      "claude-fable-5-1[1m]",
      "--strict-mcp-config",
      "--no-session-persistence",
      "-p",
      expect.stringContaining("dangerouslyDisableSandbox"),
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
    expect(s.opts.env).toMatchObject({
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
      WINGMATE_LINEAR_TOKEN: "", // F4: the bypassPermissions probe could print its environment
      GH_CONFIG_DIR: join(kit, "gh-empty"),
      GIT_CONFIG_GLOBAL: join(kit, "gitconfig"),
      WINGMATE_ROLE: "coordinator",
    });
    expect(s.settings.sandbox.network.strictAllowlist).toBe(true);
    expect(s.settings.sandbox.network.allowedDomains).toContain("registry.npmjs.org");
    expect(s.settings.sandbox.network.allowedDomains).not.toContain("pypi.org");
    expect(
      s.settings.sandbox.filesystem.denyWrite.some((p) => p.endsWith(`/worktrees/${basename(wtPath)}-decoy`)),
    ).toBe(true);
    // removed in finally: the worktree (through Orca), its kit, the decoy gitdir; the probe never touched an issue worktree
    const created = w.orca.calls.filter((c) => c.verb === "worktreeCreate");
    expect(created.length).toBe(1);
    expect(w.orca.removed).toEqual([`repo-self::${wtPath}`]);
    expect(existsSync(wtPath)).toBe(false);
    expect(existsSync(kit)).toBe(false);
    const common = join(w.root, "orca", "repos", "repo-self", ".git");
    const admin = join(common, "worktrees"); // git removes it with its last worktree
    expect(existsSync(admin) ? readdirSync(admin).filter((n) => n.includes("decoy")) : []).toEqual([]);
  });

  test("SEC-1: the probe's settings and launch environment blank the user-level Claude env's credential keys; a variable still visible fails, named", async () => {
    const w = await world();
    writeFileSync(
      join(w.root, ".claude", "settings.json"),
      JSON.stringify({ model: "claude-fable-5-1[1m]", env: { LANGFUSE_SECRET_KEY: "sk-lf-x", DEBUG: "1" } }),
    );
    const seen: Seen[] = [];
    let script13 = "";
    const exec = fakeClaude(async (cwd, kit) => {
      await commit(cwd);
      script13 = readFileSync(SCRIPT(13, kit), "utf8");
      const leak = { n: 13, text: "CREDENV LANGFUSE_SECRET_KEY \nPROBE 13 exit=1 sig=set" };
      return streamOf(
        callsExcept({ 13: leak }).map((c) => ({ ...c, command: `sh ${SCRIPT(c.n, kit)}` })),
        {},
      );
    }, seen);
    const r = await claudeProbe(w.ctx, { exec: exec.exec, cwd: "/wt/self" });
    const s = seen[0];
    if (!s) throw new Error("claude was not run");
    expect((s.settings as unknown as { env: Record<string, string> }).env).toMatchObject({
      LANGFUSE_SECRET_KEY: "",
      GITHUB_PERSONAL_ACCESS_TOKEN: "",
    });
    expect(s.opts.env).toMatchObject({ LANGFUSE_SECRET_KEY: "", GITHUB_PERSONAL_ACCESS_TOKEN: "" });
    // N1: probe 13 fails on exactly what the kit blanks — the user-level key included — and on nothing else
    expect(script13).toContain("LANGFUSE_SECRET_KEY");
    expect(script13).not.toContain("DEBUG");
    expect(r.ok).toBe(false);
    expect(r.detail).toContain(
      "credential_env_empty: still set for agents although the kit blanks them: LANGFUSE_SECRET_KEY",
    );
    expect(r.detail).not.toContain("sk-lf-x");
  });

  test("N1 (R32): credential-named variables the kit does not blank (Orca's, Claude Code's own) pass the probe and are named in its detail as a note", async () => {
    const w = await world();
    const exec = fakeClaude(async (cwd, kit) => {
      await commit(cwd);
      const noted = {
        n: 13,
        text: "CREDNOTE CLAUDE_CODE_MESSAGING_TOKEN GIT_CONFIG_KEY_0 \nPROBE 13 exit=0 sig=unset",
      };
      return streamOf(
        callsExcept({ 13: noted }).map((c) => ({ ...c, command: `sh ${SCRIPT(c.n, kit)}` })),
        {},
      );
    }, []);
    const r = await claudeProbe(w.ctx, { exec: exec.exec, cwd: "/wt/self" });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain(
      "note: credential-named variables agents can see, not blanked by the kit: CLAUDE_CODE_MESSAGING_TOKEN, GIT_CONFIG_KEY_0",
    );
  });

  test("R31: with no model in ~/.claude/settings.json the probe runs on the Claude CLI's own default — no --model — and says so", async () => {
    const w = await world();
    writeFileSync(
      join(w.root, ".claude", "settings.json"),
      JSON.stringify({ modelSettings: { "claude-fable-5-1": { effort: "high" } }, effortLevel: "high" }),
    );
    const seen: Seen[] = [];
    const exec = fakeClaude(async (cwd, kit) => {
      await commit(cwd);
      return stream(lines(), { kit });
    }, seen);
    const r = await claudeProbe(w.ctx, { exec: exec.exec, cwd: "/wt/self" });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("(CLI default model)");
    expect(seen[0]?.argv).not.toContain("--model");
    expect(seen[0]?.argv.slice(0, 5)).toEqual([
      "claude",
      "--settings",
      expect.stringContaining("claude-settings.json"),
      "--permission-mode",
      "bypassPermissions",
    ]);
  });

  test("a broken sandbox fails on the lines and on disk, and the files its writes created are removed", async () => {
    const w = await world();
    const seen: Seen[] = [];
    const exec = fakeClaude(async (cwd, kit) => {
      await commit(cwd);
      // no sandbox: the write probes run for real and succeed
      const outs: string[] = [];
      for (const n of [4, 5, 6, 8])
        outs.push((await run(["sh", join(kit, "probe", `${n}.sh`)], {})).stdout.trim());
      const own = Object.fromEntries(
        outs.map((l) => [Number(/PROBE (\d+)/.exec(l)?.[1]), l.replace(/^PROBE \d+ exit=/, "")]),
      );
      return stream(lines(own), { kit });
    }, seen);
    const r = await claudeProbe(w.ctx, { exec: exec.exec, cwd: "/wt/self" });
    expect(r.ok).toBe(false);
    for (const name of [
      "hook_write: ALLOWED",
      "sibling_gitdir_write: ALLOWED",
      "index_lock_write: ALLOWED",
      "unsandboxed_bash: ALLOWED",
    ])
      expect(r.detail).toContain(name);
    expect(r.detail).toContain("written outside the sandbox policy");
    expect(r.detail).toContain("sibling_gitdir_write: the decoy gitdir's HEAD changed");
    const common = join(w.root, "orca", "repos", "repo-self", ".git");
    expect(existsSync(join(common, "index.lock"))).toBe(false); // the owner's main checkout is usable again
    expect(existsSync(join(common, "hooks", "pre-commit"))).toBe(false);
    expect(readdirSync(w.root).filter((n) => n.endsWith("-escape"))).toEqual([]);
  });

  test("no output at all fails every required probe, and the worktree is still removed", async () => {
    const w = await world();
    const exec = fakeClaude(async () => "", []);
    const r = await claudeProbe(w.ctx, { exec: exec.exec, cwd: "/wt/self" });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("credentials_read: no PROBE line");
    expect(r.orcaReachable).toBeNull();
    expect(w.orca.removed.length).toBe(1);
  });

  test("F3/F4: tool results count only for the kit's own scripts; a reply that claims every result, or command 8 run sandboxed, fails", async () => {
    const w = await world();
    // the model ran nothing and typed the expected lines (including a refused command 8) into its reply
    const replyOnly = fakeClaude(async (cwd) => {
      await commit(cwd);
      return streamOf([], { final: lines({ 8: "refused sig=refused" }) });
    }, []);
    const r = await claudeProbe(w.ctx, { exec: replyOnly.exec, cwd: "/wt/self" });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("credentials_read: no PROBE line");
    expect(r.detail).toContain("unsandboxed_bash: not exercised");
    // calls that ran scripts of another directory (not this probe's kit) are not this probe's results
    const elsewhere = fakeClaude(async (cwd) => {
      await commit(cwd);
      return stream(lines(), { kit: "/somewhere/else" });
    }, []);
    expect((await claudeProbe(w.ctx, { exec: elsewhere.exec, cwd: "/wt/self" })).detail).toContain(
      "credentials_read: no PROBE line",
    );
    const sandboxed8 = fakeClaude(async (cwd, kit) => {
      await commit(cwd);
      return stream(lines(), { kit, noEscape: true });
    }, []);
    const s8 = await claudeProbe(w.ctx, { exec: sandboxed8.exec, cwd: "/wt/self" });
    expect(s8.ok).toBe(false);
    expect(s8.detail).toBe(
      "unsandboxed_bash: not exercised (no Bash call ran command 8 with dangerouslyDisableSandbox: true)",
    );
  });

  test("a reported commit whose HEAD did not move fails; a crash still removes the worktree", async () => {
    const w = await world();
    const exec = fakeClaude(async (_cwd, kit) => stream(lines(), { kit }), []);
    const r = await claudeProbe(w.ctx, { exec: exec.exec, cwd: "/wt/self" });
    expect(r.detail).toContain("git_commit: reported success but HEAD did not move");
    const w2 = await world();
    const crash = fakeExec([
      {
        match: (a) => a[0] === "claude",
        reply: () => {
          throw new Error("spawn failed");
        },
      },
    ]);
    await expect(claudeProbe(w2.ctx, { exec: crash.exec, cwd: "/wt/self" })).rejects.toThrow(/spawn failed/);
    expect(w2.orca.removed.length).toBe(1);
  });
});

describe("claudeProbe commit identity", () => {
  test("the probe commits as the kit does: a reserved .invalid address no GitHub account can claim", async () => {
    const w = await world();
    let gitconfig = "";
    const exec = fakeClaude(async (cwd, kit) => {
      gitconfig = readFileSync(join(kit, "gitconfig"), "utf8");
      await commit(cwd);
      return stream(lines(), { kit });
    }, []);
    expect(await claudeProbe(w.ctx, { exec: exec.exec, cwd: "/wt/self" })).toMatchObject({ ok: true });
    expect(gitconfig).toContain("[user]\n\tname = Wingmate Probe\n\temail = wingmate@noreply.invalid\n");
    expect(gitconfig).not.toContain("users.noreply.github.com");
  });
});

describe("claudeProbe setup (R34: its first live run met a repository without origin/main)", () => {
  test("the scratch worktree starts at the commit Orca reports for doctor's checkout; origin/main only when none is reported", async () => {
    const sha = "ddfb2bf3a729d18115b278435a578c12f4e49136";
    for (const [head, base] of [
      [sha, sha],
      [null, "origin/main"],
    ] as const) {
      const w = await world();
      w.orca.current = { ...w.orca.current, head };
      const seen: Seen[] = [];
      const exec = fakeClaude(async (cwd, kit) => {
        await commit(cwd);
        return stream(lines(), { kit });
      }, seen);
      expect(await claudeProbe(w.ctx, { exec: exec.exec, cwd: "/wt/self" })).toMatchObject({ ok: true });
      const bases = w.orca.calls
        .filter((c) => c.verb === "worktreeCreate")
        .map((c) => (c.args as { baseBranch: string }).baseBranch);
      expect(bases).toEqual([base]);
      // the kit still denies the base branch's ref by name, whatever commit the worktree started at
      expect(
        seen[0]?.settings.sandbox.filesystem.denyWrite.some((p) => p.endsWith("/refs/heads/main*")),
      ).toBe(true);
    }
  });

  test("a setup step Orca refuses is a failed result naming the step and the code, never a throw; claude never runs", async () => {
    const w = await world();
    w.orca.onCall = (verb) => {
      if (verb === "worktreeCreate")
        throw new OrcaError("runtime_error", "fatal: invalid reference: origin/main");
    };
    const exec = fakeClaude(async () => "", []);
    const created = await claudeProbe(w.ctx, { exec: exec.exec, cwd: "/wt/self" });
    expect(created).toMatchObject({ ok: false, orcaReachable: null });
    expect(created.detail).toContain(
      "could not create the scratch worktree from origin/main (runtime_error)",
    );
    expect(created.detail).not.toContain("fatal:"); // the code and the step, never Orca's raw message
    expect(exec.calls.length).toBe(0);
    expect(w.orca.removed).toEqual([]);

    const w2 = await world();
    w2.orca.failNext = "worktreeCurrent";
    const exec2 = fakeClaude(async () => "", []);
    const current = await claudeProbe(w2.ctx, { exec: exec2.exec, cwd: "/wt/self" });
    expect(current).toMatchObject({ ok: false, orcaReachable: null });
    expect(current.detail).toContain("`orca worktree current` failed in /wt/self (orca_unreachable)");
    expect(exec2.calls.length).toBe(0);
    expect(w2.orca.calls.some((c) => c.verb === "worktreeCreate")).toBe(false);
  });

  test("never from a pilot repository or an issue's wm- worktree: an agent writes their content and refs, which the probe would load", async () => {
    const w = await world();
    const pilot = Object.values(w.cfg.projects).flatMap((p) => Object.values(p.repos))[0];
    if (!pilot) throw new Error("the test config has no pilot repository");
    for (const [current, why] of [
      [{ ...w.orca.current, repoId: pilot.orcaRepo }, "a pilot repository"],
      [{ ...w.orca.current, path: "/wt/wm-jrf-402" }, "an issue's wm- worktree"],
    ] as const) {
      w.orca.calls.length = 0;
      w.orca.current = current;
      const exec = fakeClaude(async () => "", []);
      const r = await claudeProbe(w.ctx, { exec: exec.exec, cwd: "/wt/self" });
      expect(r).toMatchObject({ ok: false, orcaReachable: null });
      expect(r.detail).toContain(`probe not run: /wt/self is in ${why}`);
      expect(r.detail).toContain("wingmate-dispatcher");
      expect(exec.calls.length).toBe(0);
      expect(w.orca.calls.some((c) => c.verb === "worktreeCreate")).toBe(false);
    }
  });

  test("a create that fails after Orca made the worktree still removes it, found by its name, and no other worktree", async () => {
    const w = await world();
    const create = w.orca.worktreeCreate.bind(w.orca);
    // the operator's own checkout of the same repository: the cleanup must match the scratch worktree's name, never the repo alone
    const sibling = await create({
      repoId: w.orca.current.repoId,
      name: "wingmate-dispatcher",
      baseBranch: "origin/main",
      linearIssue: "",
      comment: "",
    });
    w.orca.worktreeCreate = async (a) => {
      await create(a); // Orca made it, then the reply timed out
      throw new OrcaError("orca_timeout", "no reply in 120 s");
    };
    const exec = fakeClaude(async () => "", []);
    const r = await claudeProbe(w.ctx, { exec: exec.exec, cwd: "/wt/self" });
    expect(r).toMatchObject({ ok: false, orcaReachable: null });
    expect(r.detail).toContain("(orca_timeout)");
    expect(exec.calls.length).toBe(0);
    expect(w.orca.removed.length).toBe(1);
    expect(basename(w.orca.removed[0] ?? "")).toMatch(/^wm-doctor-[0-9a-z]{26}$/);
    expect(w.orca.removed).not.toContain(sibling.id);
    expect(existsSync(sibling.path)).toBe(true);
  });
});

describe("codexProbe (R8)", () => {
  test("network blocked and reads reported; the argv is codex exec with -c approval_policy=never, never --ask-for-approval", async () => {
    const w = await world();
    const seen: string[][] = [];
    const exec = fakeExec([
      {
        match: (a) => a[0] === "codex",
        reply: (argv) => {
          seen.push(argv);
          return ok(
            "PROBE 1 exit=6 sig=net\nPROBE 2 exit=0 sig=none\n",
            "user\nRun these two shell commands",
          );
        },
      },
    ]);
    const r = await codexProbe(w.ctx, { exec: exec.exec });
    expect(r).toMatchObject({ ok: true, readsBlocked: false });
    expect(r.detail).toContain("NOT blocked (D14)");
    expect(seen[0]?.slice(0, 10)).toEqual([
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
    ]);
    expect(seen[0]).not.toContain("--ask-for-approval");
  });
  test("F4: codex exec starts without the owner's personal Linear key, even when the doctor's shell exports it (Codex reads are unrestricted)", async () => {
    const w = await world();
    const saved = process.env[TOKEN_ENV];
    process.env[TOKEN_ENV] = "lin_api_probe_test";
    try {
      const envs: Record<string, string>[] = [];
      const exec = fakeExec([
        {
          match: (a) => a[0] === "codex",
          reply: (_argv, opts) => {
            envs.push(childEnv(opts.env)); // what run() hands the process
            return ok("PROBE 1 exit=6 sig=net\nPROBE 2 exit=1 sig=eperm\n");
          },
        },
      ]);
      await codexProbe(w.ctx, { exec: exec.exec });
      expect(envs).toHaveLength(1);
      expect(envs[0]?.[TOKEN_ENV]).toBeUndefined();
      expect(JSON.stringify(envs)).not.toContain("lin_api_probe_test");
    } finally {
      if (saved === undefined) delete process.env[TOKEN_ENV];
      else process.env[TOKEN_ENV] = saved;
    }
  });
  test("network reachable, a non-network failure, missing or conflicting lines: not proven blocked", async () => {
    const w = await world();
    for (const [out, readsBlocked] of [
      ["PROBE 1 exit=0 sig=none\nPROBE 2 exit=1 sig=eperm\n", true],
      ["PROBE 1 exit=127 sig=other\n", null],
      ["", null],
      ["PROBE 1 exit=6 sig=net\nPROBE 1 exit=0 sig=none\n", null],
    ] as const) {
      const exec = fakeExec([{ match: (a) => a[0] === "codex", reply: () => ok(out) }]);
      const r = await codexProbe(w.ctx, { exec: exec.exec });
      expect(r.ok).toBe(false);
      expect(r.readsBlocked).toBe(readsBlocked);
    }
  });
});

describe("the canary credentials file", () => {
  test("created 0600 only when absent and removed afterwards; a real credentials file is never written or removed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wm-canary-"));
    const file = join(dir, "wingmate", "credentials.json");
    let during = "";
    await withCanary(file, async () => {
      during = readFileSync(file, "utf8");
      expect(statSync(file).mode & 0o777).toBe(0o600);
    });
    expect(during).toContain("wingmate-doctor-");
    expect(existsSync(file)).toBe(false);
    await expect(
      withCanary(file, async () => {
        throw new Error("probe crashed");
      }),
    ).rejects.toThrow(/probe crashed/);
    expect(existsSync(file)).toBe(false);
    writeFileSync(file, '{"clientId":"real","clientSecret":"real-secret"}');
    await withCanary(file, async () => undefined);
    expect(readFileSync(file, "utf8")).toBe('{"clientId":"real","clientSecret":"real-secret"}');
  });
});

describe("sandbox_settings (R12: parse the output, never the exit code)", () => {
  const INVALID =
    "Diagnostics\n\nInvalid settings\n - /k/claude-settings.json › sandbox.network.strictAllowlist: Expected boolean, but received string\n   Suggested fix: Use true or false without quotes.\n\nUpdates\n";
  test("the Invalid settings section and the status JSON are parsed from the text", () => {
    expect(invalidSettings(INVALID)).toEqual(["sandbox.network.strictAllowlist"]);
    expect(invalidSettings("Diagnostics\n └ Currently running: native\n")).toBeNull();
    expect(invalidSettings("\u001b[1mInvalid settings\u001b[0m\n - x\n")).toEqual([]);
    expect(sandboxStatus(`${SANDBOX_STATUS_OK}\n`)).toMatchObject({
      enabled: true,
      strictMode: true,
      enabledSource: "policy",
    });
    expect(sandboxStatus("no json here")).toBeNull();
  });
  const posture = async (doctorOut: { code: number; stdout: string }, status: string) => {
    const w = await world();
    const exec = fakeExec([
      { match: (a) => a[3] === "doctor", reply: () => ({ ...doctorOut, stderr: "" }) },
      { match: (a) => a[3] === "sandbox", reply: () => ok(status) },
    ]);
    return { r: await settingsPosture(w.ctx, exec.exec), calls: exec.calls, w };
  };
  test("an Invalid settings section fails although claude doctor exits 0; a clean doctor that exits 1 still passes", async () => {
    expect((await posture({ code: 0, stdout: INVALID }, SANDBOX_STATUS_OK)).r).toMatchObject({
      ok: false,
      detail: expect.stringContaining("sandbox.network.strictAllowlist"),
    });
    expect((await posture({ code: 1, stdout: "Diagnostics\n" }, SANDBOX_STATUS_OK)).r.ok).toBe(true);
  });
  test("a dropped sandbox block, strict mode off, a status from another source, or no status JSON each fail", async () => {
    const st = (o: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(SANDBOX_STATUS_OK), ...o });
    for (const status of [
      st({ enabled: false, enabledSource: "off" }),
      st({ strictMode: false }),
      st({ enabledSource: "user", strictModeSource: "user" }),
      "sandbox: unknown command",
    ])
      expect((await posture({ code: 0, stdout: "Diagnostics\n" }, status)).r.ok).toBe(false);
  });
  test("the file it checks is written as the kit writes it: strict allowlist, denied GitHub hosts, unsandboxed commands off", async () => {
    const { calls, w } = await posture({ code: 0, stdout: "" }, SANDBOX_STATUS_OK);
    const file = calls[0]?.argv[2] ?? "";
    expect(file).toBe(join(w.dirs.kit, "_doctor", "claude-settings.json"));
    const s = JSON.parse(readFileSync(file, "utf8")) as {
      sandbox: {
        allowUnsandboxedCommands: boolean;
        network: { strictAllowlist: boolean; deniedDomains: string[] };
      };
    };
    expect(s.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(s.sandbox.network.strictAllowlist).toBe(true);
    expect(s.sandbox.network.deniedDomains).toContain("github.com");
    expect(calls.map((c) => c.argv.slice(3))).toEqual([["doctor"], ["sandbox", "status"]]);
  });
});
