import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { Runner } from "../git/cli";
import { run } from "../shared/exec";

/** Unlike sweep's best-effort kill receipt, this read fails closed on any incomplete observation. */
export async function inspectCleanupProcesses(
  path: string,
  exec: Runner = run,
): Promise<{ complete: boolean; pids: number[] }> {
  const roots = [...new Set([resolve(path), await realpath(path)])];
  const uid = process.getuid?.();
  if (uid === undefined) return { complete: false, pids: [] };
  const ps = await exec([Bun.which("ps") ?? "/bin/ps", "-axww", "-o", "pid=,uid=,command="], {
    timeoutMs: 20_000,
  });
  const files = await exec(
    [Bun.which("lsof") ?? "/usr/sbin/lsof", "-n", "-P", "-u", String(uid), "-F", "pn"],
    { timeoutMs: 30_000 },
  );
  if ([ps, files].some((r) => r.code !== 0 || r.timedOut || r.truncated || r.stderr.trim()))
    return { complete: false, pids: [] };
  const hits = new Set<number>();
  for (const line of ps.stdout.split("\n").filter(Boolean)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) return { complete: false, pids: [] };
    // Command lines only veto cleanup; they never establish ownership or authority to signal a process.
    if (Number(m[2]) === uid && roots.some((root) => m[3]?.includes(root))) hits.add(Number(m[1]));
  }
  let pid: number | null = null;
  for (const line of files.stdout.split("\n").filter(Boolean)) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== null) {
      if (roots.some((root) => line.slice(1) === root || line.slice(1).startsWith(`${root}/`))) hits.add(pid);
    } else return { complete: false, pids: [] };
  }
  // Empty successful output is not a credible full inventory of this running user's processes.
  return { complete: ps.stdout.trim().length > 0 && pid !== null, pids: [...hits] };
}
