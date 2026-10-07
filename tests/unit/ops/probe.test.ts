// tests/unit/ops/probe.test.ts — doctor's live probes, without a model: the PROBE-line rules, the shell classifier run by real `sh`,
// the Claude probe end to end against a real temp worktree (a simulated agent stands in for `claude -p`), the Codex probe, the
// canary, and the quota-free posture check. No test starts claude, codex, orca or touches the network or the real home.
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  CLASSIFY,
  PROBE_ID,
  claudeProbe,
  claudeProbes,
  codexProbe,
  invalidSettings,
  judge,
  probeLines,
  probeScript,
  sandboxStatus,
  settingsPosture,
  streamTexts,
  withCanary,
} from "../../../src/ops/probe";
import type { RunOptions } from "../../../src/shared/exec";
import { run } from "../../../src/shared/exec";
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
  13: "exit=0 sig=set",
  14: "exit=0 sig=reachable",
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
/** Claude's stream-json: one tool_use/tool_result pair per line of `tools` (network probes carry their violation), then the result. */
function stream(
  tools: string,
  final: string,
  violations: Record<number, string> = { 2: "github.com", 7: "pypi.org" },
): string {
  const out = [JSON.stringify({ type: "system", subtype: "init", model: "claude-fable-5-1" })];
  tools
    .split("\n")
    .filter(Boolean)
    .forEach((l, i) => {
      out.push(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: `t${i}`, name: "Bash", input: { command: `sh /k/probe/${i + 1}.sh` } },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: `t${i}`,
                content: [{ type: "text", text: `${l}\n${violationFor(l, violations)}` }],
              },
            ],
          },
        }),
      );
    });
  out.push(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: final }));
  return `${out.join("\n")}\n`;
}

describe("PROBE lines (inverted or missing lines fail the probe)", () => {
  test("a holding sandbox passes every probe", () => {
    const { tools, final } = streamTexts(stream(lines(), lines()));
    expect(judge(PROBES, tools, final).failures).toEqual([]);
  });
  test("a missing line fails; an inverted must-fail or must-succeed result fails", () => {
    const missing = streamTexts(stream(lines({ 4: null }), lines({ 4: null })));
    expect(judge(PROBES, missing.tools, missing.final).failures).toEqual(["hook_write: no PROBE line"]);
    const inverted = streamTexts(stream(lines({ 1: "0 sig=none", 10: "1 sig=eperm" }), lines()));
    expect(judge(PROBES, inverted.tools, inverted.final).failures).toEqual([
      "credentials_read: ALLOWED (exit=0 sig=none)",
      "git_commit: failed (exit=1 sig=eperm)",
    ]);
  });
  test("a private-repo style auth failure is not accepted as network proof", () => {
    const auth = streamTexts(stream(lines({ 2: "128 sig=auth" }), lines()));
    const f = judge(PROBES, auth.tools, auth.final).failures;
    expect(f.length).toBe(1);
    expect(f[0]).toContain("github_ls_remote");
    expect(f[0]).toContain("an auth failure proves no network block");
    const other = streamTexts(stream(lines({ 7: "6 sig=other", 1: "1 sig=enoent" }), lines()));
    expect(judge(PROBES, other.tools, other.final).failures.map((x) => x.split(":")[0])).toEqual([
      "credentials_read",
      "unlisted_host",
    ]);
  });
  test("a network block must be the sandbox's: without its network-outbound violation for the host, net is not proof", () => {
    const noViolation = streamTexts(stream(lines(), lines(), { 7: "pypi.org" }));
    expect(judge(PROBES, noViolation.tools, noViolation.final).failures).toEqual([
      "github_ls_remote: blocked, but no sandbox violation for github.com in the tool results (a DNS or firewall failure proves nothing about the sandbox)",
    ]);
    const wrongHost = streamTexts(stream(lines(), lines(), { 2: "example.com", 7: "pypi.org" }));
    expect(judge(PROBES, wrongHost.tools, wrongHost.final).failures.length).toBe(1);
  });
  test("the tool results win over the model's reply; the reply counts only where no tool result carries the line", () => {
    const lied = streamTexts(stream(lines({ 2: "0 sig=none" }), lines()));
    expect(judge(PROBES, lied.tools, lied.final).failures).toEqual([
      "github_ls_remote: ALLOWED (exit=0 sig=none)",
    ]);
    // the reply alone settles every probe except the network ones, whose proof is the sandbox's own report in a tool result
    const textOnly = streamTexts(stream("", lines()));
    expect(judge(PROBES, textOnly.tools, textOnly.final).failures.map((f) => f.split(":")[0])).toEqual([
      "github_ls_remote",
      "unlisted_host",
    ]);
    const notJson = streamTexts(lines());
    expect(notJson.tools).toBe("");
    expect(judge(PROBES, notJson.tools, notJson.final).failures.length).toBe(2);
  });
  test("two different lines for one probe conflict; refused counts only for the unsandboxed Bash call", () => {
    const dup = streamTexts(stream(`${lines()}\nPROBE 6 exit=0 sig=none`, lines()));
    expect(judge(PROBES, dup.tools, dup.final).failures[0]).toContain(
      "index_lock_write: conflicting results",
    );
    const refused8 = streamTexts(stream(lines({ 8: null }), lines({ 8: "refused sig=refused" })));
    expect(judge(PROBES, refused8.tools, refused8.final).failures).toEqual([]);
    const refused1 = streamTexts(stream(lines({ 1: null }), lines({ 1: "refused sig=refused" })));
    expect(judge(PROBES, refused1.tools, refused1.final).failures).toEqual([
      "credentials_read: refused is not a result for this probe",
    ]);
  });
  test("a registry reply must be an HTTP success; a missing report line (orca) is no failure; literal script text never parses", () => {
    const http = streamTexts(stream(lines({ 9: "0 sig=http403" }), lines()));
    expect(judge(PROBES, http.tools, http.final).failures).toEqual([
      "allowlisted_registry: unexpected result (exit=0 sig=http403)",
    ]);
    const noOrca = streamTexts(stream(lines({ 14: null }), lines({ 14: null })));
    expect(judge(PROBES, noOrca.tools, noOrca.final).failures).toEqual([]);
    expect(probeLines('echo "PROBE 2 exit=$c sig=$(classify "$o")"').size).toBe(0);
    for (const p of PROBES) expect(probeLines(probeScript(p)).size).toBe(0); // the script's own echo line has `$c`
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
  test("the token probe never echoes a token, and the credentials probe discards what it reads", () => {
    const token = PROBES.find((x) => x.name === "github_token_empty");
    expect(token?.body).toContain("test -z");
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
    const exec = fakeClaude(async (cwd) => {
      await commit(cwd);
      return stream(lines(), lines());
    }, seen);
    const r = await claudeProbe(w.ctx, { exec: exec.exec, cwd: "/wt/self" });
    expect(r).toMatchObject({ ok: true, orcaReachable: true });
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
      return stream(lines(own), lines(own));
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

  test("a reported commit whose HEAD did not move fails; a crash still removes the worktree", async () => {
    const w = await world();
    const exec = fakeClaude(async () => stream(lines(), lines()), []);
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
