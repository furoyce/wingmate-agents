// tests/fakes/fakeExec.ts — an injected command runner for doctor and probe tests: canned answers per argv, every call recorded.
// It never starts `claude`, `codex` or any other process unless a handler does so itself (the git helpers below run real git on
// temp repositories only).
import type { RunOptions, RunResult } from "../../src/shared/exec";
import { run } from "../../src/shared/exec";

export type Handler = (argv: string[], opts: RunOptions) => Promise<Partial<RunResult>> | Partial<RunResult>;

export const ok = (stdout = "", stderr = ""): Partial<RunResult> => ({ code: 0, stdout, stderr });

/** `claude --settings <file> sandbox status` as Claude Code 2.1.291 prints it for a valid kit file (spike §3.4b). */
export const SANDBOX_STATUS_OK = JSON.stringify({
  enabled: true,
  enabledSource: "policy",
  strictMode: true,
  strictModeSource: "policy",
  filesystemPolicy: "strict",
  autoAllowBashIfSandboxed: true,
  autoAllowBashIfSandboxedSource: "policy",
});

export interface FakeExec {
  exec: (argv: string[], opts?: RunOptions) => Promise<RunResult>;
  calls: { argv: string[]; opts: RunOptions }[];
}

/**
 * `handlers` is tried in order; the first whose `match` accepts the argv answers. Defaults: `claude --version`, `codex --version`,
 * a clean `claude --settings f doctor` and a valid `sandbox status`. An unmatched argv fails with exit 127, as a missing binary does.
 */
export function fakeExec(handlers: { match: (argv: string[]) => boolean; reply: Handler }[] = []): FakeExec {
  const calls: FakeExec["calls"] = [];
  const defaults: typeof handlers = [
    { match: (a) => a[0] === "claude" && a[1] === "--version", reply: () => ok("2.1.291 (Claude Code)\n") },
    { match: (a) => a[0] === "codex" && a[1] === "--version", reply: () => ok("codex-cli 0.160.1\n") },
    {
      match: (a) => a[0] === "claude" && a[1] === "--settings" && a[3] === "doctor",
      reply: () => ok("Diagnostics\n └ Currently running: native (2.1.291)\n"),
    },
    {
      match: (a) => a[0] === "claude" && a[1] === "--settings" && a[3] === "sandbox" && a[4] === "status",
      reply: () => ok(`${SANDBOX_STATUS_OK}\n`),
    },
  ];
  return {
    calls,
    exec: async (argv, opts = {}) => {
      calls.push({ argv, opts });
      const h = [...handlers, ...defaults].find((x) => x.match(argv));
      const r = h ? await h.reply(argv, opts) : { code: 127, stderr: `${argv[0]}: command not found` };
      return { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false, ...r };
    },
  };
}

/** Real git on a temp repository (no user or system config), for the probe's simulated agent. */
export async function gitIn(cwd: string, args: string[]): Promise<RunResult> {
  return run(["git", "-C", cwd, ...args], {
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
}
