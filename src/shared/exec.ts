export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  stdin?: string;
}

const MAX_CAPTURE = 8 * 1024 * 1024;
/** After a timeout kill, how long to keep waiting for the pipes to reach EOF before cancelling the readers. */
const GRACE_MS = 2000;

/** Chunk-wise capture: partial output survives a timeout, reads continue past the cap so the child never blocks, and the reader can be cancelled. */
function collect(stream: ReadableStream<Uint8Array> | null) {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = stream?.getReader() ?? null;
  const done = (async () => {
    if (!reader) return;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && bytes < MAX_CAPTURE) {
          chunks.push(value);
          bytes += value.byteLength;
        }
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
    env: { ...process.env, ...(opts.env ?? {}) },
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
    return { code: timedOut ? 124 : code, stdout: out.text(), stderr: err.text(), timedOut };
  } finally {
    if (timer) clearTimeout(timer);
    if (graceTimer) clearTimeout(graceTimer);
  }
}
