// src/machine/sweep.ts — §13.3(i) process sweep: kill every process of this user rooted in the given paths (cwd, executable or an
// open file under a path per `lsof`, or the path on its command line), SIGTERM, up to 5 s, then SIGKILL.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { run } from "../shared/exec";

export interface SweepOptions {
  /**
   * Spare the process whose command line contains this text, and its ancestors. Parking (§7.1) keeps the coordinator session open
   * — idle at zero cost and resumed by a plain `terminal send` — while every other process of the issue is swept; the coordinator's
   * command line carries its own `--settings <kit>/claude-settings.json`, which no other process has.
   */
  spare?: string;
}
export interface SweepResult {
  killed: string[];
  /** Process names (never full command lines, which can carry secrets), for the ledger's proof. */
  commands: string[];
}

interface Proc {
  pid: number;
  ppid: number;
  uid: number;
  command: string;
}

const TERM_WAIT_MS = 5000;
const POLL_MS = 100;
const under = (name: string, roots: string[]) => roots.some((r) => name === r || name.startsWith(`${r}/`));
/** Whether a command line names the root itself or a path under it (`/wt/wm-jrf-5` never matches `/wt/wm-jrf-50`). */
function mentions(command: string, root: string): boolean {
  for (let i = command.indexOf(root); i >= 0; i = command.indexOf(root, i + 1)) {
    const next = command[i + root.length];
    if (next === undefined || !/[A-Za-z0-9._-]/.test(next)) return true;
  }
  return false;
}

/** The process table (`ps -axww`): pid, ppid, uid and the full command line. */
async function processTable(): Promise<Proc[]> {
  const ps = await run([Bun.which("ps") ?? "/bin/ps", "-axww", "-o", "pid=,ppid=,uid=,command="], {
    timeoutMs: 20_000,
  });
  const out: Proc[] = [];
  for (const line of ps.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), command: m[4] ?? "" });
  }
  return out;
}

/** Adds to `hits` the pids of an `lsof -F pcn` listing holding a file under one of the roots, with their process names. */
function collect(stdout: string, roots: string[], hits: Map<number, string>): void {
  let pid = 0;
  let name = "";
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
      name = "";
    } else if (line.startsWith("c")) name = line.slice(1);
    else if (line.startsWith("n") && pid > 0 && under(line.slice(1), roots)) hits.set(pid, name);
  }
}

/**
 * Pids of this user's processes with their cwd, executable or an open file under one of the roots. The cwd-only listing is small
 * and always complete; the full listing (several MB on a busy machine, capped by `run`) adds executables and other open files.
 */
async function openFiles(uid: number, roots: string[]): Promise<Map<number, string>> {
  const lsof = Bun.which("lsof") ?? "/usr/sbin/lsof";
  const base = [lsof, "-n", "-P", "-w"];
  const hits = new Map<number, string>();
  const cwd = await run([...base, "-a", "-u", String(uid), "-d", "cwd", "-F", "pcn"], { timeoutMs: 30_000 });
  collect(cwd.stdout, roots, hits);
  const all = await run([...base, "-u", String(uid), "-F", "pcn"], { timeoutMs: 30_000 });
  collect(all.stdout, roots, hits);
  return hits;
}

/** Real paths, so they compare with what `lsof` reports (`/var` is `/private/var` on macOS). */
const realRoot = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

function ancestors(pid: number, byPid: Map<number, Proc>): number[] {
  const out: number[] = [];
  let cur = byPid.get(pid);
  while (cur && cur.ppid > 1 && !out.includes(cur.ppid)) {
    out.push(cur.ppid);
    cur = byPid.get(cur.ppid);
  }
  return out;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export async function sweep(paths: string[], opts: SweepOptions = {}): Promise<SweepResult> {
  const roots = [...new Set(paths.filter(Boolean).flatMap((p) => [resolve(p), realRoot(p)]))];
  if (!roots.length) return { killed: [], commands: [] };
  const uid = process.getuid?.() ?? -1;
  const table = (await processTable()).filter((p) => p.uid === uid);
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const targets = await openFiles(uid, roots);
  for (const p of table)
    if (!targets.has(p.pid) && roots.some((r) => mentions(p.command, r))) targets.set(p.pid, "");
  // never this process or its ancestors (a tick started from inside a worktree), never the spared session or its ancestors
  const keep = new Set([process.pid, ...ancestors(process.pid, byPid), 1]);
  if (opts.spare)
    for (const p of table)
      if (p.command.includes(opts.spare)) for (const k of [p.pid, ...ancestors(p.pid, byPid)]) keep.add(k);
  const pids = [...targets.keys()].filter((p) => !keep.has(p));
  const killed: string[] = [];
  const commands: string[] = [];
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      killed.push(String(pid));
      commands.push(targets.get(pid) || (byPid.get(pid)?.command.split(" ")[0]?.split("/").pop() ?? ""));
    } catch {
      /* already gone */
    }
  }
  for (let waited = 0; waited < TERM_WAIT_MS && killed.some((p) => alive(Number(p))); waited += POLL_MS)
    await Bun.sleep(POLL_MS);
  for (const pid of killed) {
    try {
      if (alive(Number(pid))) process.kill(Number(pid), "SIGKILL");
    } catch {
      /* exited between the check and the kill */
    }
  }
  return { killed, commands };
}
