export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** C25: stdout or stderr went past the 8 MiB capture cap, so the text kept is only a prefix of what the command wrote. */
  truncated: boolean;
}
export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  /** Trusted native host helpers receive an explicit environment, never inherited credentials. */
  inheritEnv?: boolean;
  stdin?: string;
}

/**
 * F4 (§13.3 a): variables no child process inherits. The owner's personal Linear key (`WINGMATE_LINEAR_TOKEN`, Task 13) is read in
 * process by the dispatcher; no command it runs needs it — an agent, a doctor probe, a repo setup command, a build — and a shell that
 * exported it would otherwise hand it to every one of them.
 */
export const WITHHELD_ENV: readonly string[] = ["WINGMATE_LINEAR_TOKEN"];

/** This process's environment without the withheld variables, with `extra` over it: what a child process starts with. */
export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !WITHHELD_ENV.includes(k)) env[k] = v;
  return { ...env, ...extra };
}

const MAX_CAPTURE = 8 * 1024 * 1024;
/** After a timeout kill, how long to keep waiting for the pipes to reach EOF before cancelling the readers. */
const GRACE_MS = 2000;

/**
 * Chunk-wise capture: partial output survives a timeout, reads continue past the cap so the child never blocks (a chunk past the cap
 * is dropped and marks the capture truncated), and the reader can be cancelled.
 */
function collect(stream: ReadableStream<Uint8Array> | null) {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  const reader = stream?.getReader() ?? null;
  const done = (async () => {
    if (!reader) return;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (bytes < MAX_CAPTURE) {
          chunks.push(value);
          bytes += value.byteLength;
        } else if (value.byteLength) truncated = true;
      }
    } catch {
      // cancelled or closed
    }
  })();
  const text = () => {
    const all = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let o = 0;
    for (const c of chunks) {
      all.set(c, o);
      o += c.byteLength;
    }
    return new TextDecoder().decode(all);
  };
  return {
    done,
    text,
    truncated: () => truncated,
    cancel: () => {
      void reader?.cancel().catch(() => undefined);
    },
  };
}

export async function run(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  // detached: true puts the child in its own process group so a timeout can kill the whole tree,
  // not just the direct child. Detached children do not receive the terminal's Ctrl-C; that is
  // acceptable because run() serves the dispatcher and the `issue` verbs, not interactive humans.
  const proc = Bun.spawn(argv, {
    env: opts.inheritEnv === false ? (opts.env ?? {}) : childEnv(opts.env),
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.stdin !== undefined ? { stdin: new TextEncoder().encode(opts.stdin) } : {}),
  });
  let timedOut = false;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let settleGrace: (() => void) | null = null;
  const gracePromise = new Promise<void>((resolve) => {
    settleGrace = resolve;
  });
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          proc.kill("SIGKILL");
        }
        // The grace starts only after the kill: the pipes normally reach EOF at once, but a
        // descendant that left the process group (setsid) may still hold them open.
        graceTimer = setTimeout(() => settleGrace?.(), GRACE_MS);
      }, opts.timeoutMs)
    : null;
  const out = collect(proc.stdout);
  const err = collect(proc.stderr);
  try {
    // Without a timeout, wait for EOF on both pipes (a backgrounded late writer is still read).
    // With a timeout, wait for EOF or the post-kill grace, whichever comes first.
    const drain = Promise.all([out.done, err.done]).then(() => undefined);
    await (opts.timeoutMs ? Promise.race([drain, gracePromise]) : drain);
    if (timedOut) {
      // Grace won or EOF arrived after the kill: release the readers (and their fds) either way.
      out.cancel();
      err.cancel();
    }
    const code = await proc.exited;
    const truncated = out.truncated() || err.truncated();
    return { code: timedOut ? 124 : code, stdout: out.text(), stderr: err.text(), timedOut, truncated };
  } finally {
    if (timer) clearTimeout(timer);
    if (graceTimer) clearTimeout(graceTimer);
  }
}
