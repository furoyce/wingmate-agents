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
  };
  if (opts.cwd !== undefined) spawnOpts.cwd = opts.cwd;
  if (opts.stdin !== undefined) spawnOpts.stdin = new TextEncoder().encode(opts.stdin);
  const proc = Bun.spawn(argv, spawnOpts);
  let timedOut = false;
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, opts.timeoutMs)
    : null;
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout as unknown as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as unknown as ReadableStream<Uint8Array>).text(),
  ]);
  const code = await proc.exited;
  if (timer) clearTimeout(timer);
  return { code: timedOut ? 124 : code, stdout, stderr, timedOut };
}
