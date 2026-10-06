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
  // detached: true creates a process group so timeout can kill the entire tree, not just the direct child.
  // Detached children do not receive the terminal's Ctrl-C (acceptable: run() is used by the dispatcher
  // and by issue verbs, not by interactive humans).
  const spawnOpts: Parameters<typeof Bun.spawn>[1] = {
    env: { ...process.env, ...(opts.env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  };
  if (opts.cwd !== undefined) spawnOpts.cwd = opts.cwd;
  if (opts.stdin !== undefined) spawnOpts.stdin = new TextEncoder().encode(opts.stdin);
  const proc = Bun.spawn(argv, spawnOpts);
  let timedOut = false;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let graceSettled: ((output: [string, string]) => void) | null = null;
  const gracePromise = new Promise<[string, string]>((resolve) => {
    graceSettled = resolve;
  });
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          proc.kill("SIGKILL");
        }
        // Start the grace timer after the kill: race the drain against 2s grace period
        graceTimer = setTimeout(() => {
          if (graceSettled) graceSettled(["", ""]);
        }, 2000);
      }, opts.timeoutMs)
    : null;
  try {
    const out = collect(proc.stdout as unknown as ReadableStream<Uint8Array>);
    const err = collect(proc.stderr as unknown as ReadableStream<Uint8Array>);
    const drain = Promise.all([out.done, err.done]);
    const resultPromise = opts.timeoutMs ? Promise.race([drain, gracePromise]) : drain;
    const code = await Promise.race([resultPromise.then(() => proc.exited), proc.exited]);
    if (timedOut) {
      out.cancel();
      err.cancel();
    }
    return { code: timedOut ? 124 : code, stdout: out.text(), stderr: err.text(), timedOut };
  } finally {
    if (timer) clearTimeout(timer);
    if (graceTimer) clearTimeout(graceTimer);
  }
}
