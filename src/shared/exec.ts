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
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          proc.kill("SIGKILL");
        }
      }, opts.timeoutMs)
    : null;
  try {
    const drainPromise = Promise.all([
      new Response(proc.stdout as unknown as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as unknown as ReadableStream<Uint8Array>).text(),
    ]);
    const graceTimer = timedOut
      ? new Promise<[string, string]>((resolve) => {
          const grace = setTimeout(() => {
            resolve(["", ""]);
          }, 2000);
          drainPromise.then(
            (result) => {
              clearTimeout(grace);
              resolve(result);
            },
            () => {
              clearTimeout(grace);
              resolve(["", ""]);
            },
          );
        })
      : drainPromise;
    const [stdout, stderr] = await graceTimer;
    const code = await proc.exited;
    return { code: timedOut ? 124 : code, stdout, stderr, timedOut };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
