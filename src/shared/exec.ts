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
    const drainPromise = Promise.all([
      new Response(proc.stdout as unknown as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as unknown as ReadableStream<Uint8Array>).text(),
    ]);
    const resultPromise = opts.timeoutMs ? Promise.race([drainPromise, gracePromise]) : drainPromise;
    drainPromise.then(
      (result) => {
        if (graceSettled) graceSettled(result);
      },
      () => {
        if (graceSettled) graceSettled(["", ""]);
      },
    );
    const [stdout, stderr] = await resultPromise;
    const code = await proc.exited;
    return { code: timedOut ? 124 : code, stdout, stderr, timedOut };
  } finally {
    if (timer) clearTimeout(timer);
    if (graceTimer) clearTimeout(graceTimer);
  }
}
