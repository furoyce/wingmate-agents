import { link, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { newUlid } from "../shared/ids";
import type { Dirs } from "../shared/paths";
import type { Clock } from "../shared/time";
import { iso, minutesBetween } from "../shared/time";
import { createExclusive, writeAtomic } from "./fs";

interface LockFile {
  pid: number;
  startedAt: string;
  token: string;
  heartbeatAt: string;
}
const STALE_MIN = 15;
const HEARTBEAT_MS = 30_000;

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

export interface AcquiredLock {
  kind: "acquired" | "reclaimed";
  /**
   * R16: true once a heartbeat found another holder's token on disk (or no lock file at all) — the lock was reclaimed while this
   * process was frozen. The holder then stops heartbeating and never writes the file again; the tick checks this before every
   * external action and aborts with outcome `lock_lost`.
   */
  lost(): boolean;
  /** Synchronous callers must not wait for the heartbeat to discover a replaced lock. */
  verify(): Promise<boolean>;
  release(): Promise<void>;
}
export interface AcquireOptions {
  /** Heartbeat period; tests shorten it, production keeps HEARTBEAT_MS. */
  heartbeatMs?: number;
}
export type AcquireResult = AcquiredLock | { kind: "held" };

type LockRead = { kind: "ok"; lock: LockFile } | { kind: "missing" } | { kind: "garbage" };
async function readLock(path: string): Promise<LockRead> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw e;
  }
  try {
    const lock = JSON.parse(text) as Partial<LockFile> | null;
    if (!lock || typeof lock.pid !== "number" || typeof lock.token !== "string") return { kind: "garbage" };
    return { kind: "ok", lock: lock as LockFile };
  } catch {
    return { kind: "garbage" };
  }
}

/**
 * The single tick lock (§6.0). Creation is atomic with its content (temp file + hard link), so a lock file is
 * never observable empty. A stale lock (dead pid, or a heartbeat older than STALE_MIN minutes) is reclaimed by an
 * election: the stale file is renamed away — exactly one caller succeeds — and only that caller creates the new
 * lock; a caller that finds it moved a lock other than the stale one it judged puts it back and yields. An
 * unparseable lock file is treated as held (after one short re-read), never as stale.
 */
export const TickLock = {
  path: (dirs: Dirs) => join(dirs.state, "tick.lock"),
  async acquire(dirs: Dirs, clock: Clock, opts: AcquireOptions = {}): Promise<AcquireResult> {
    const path = TickLock.path(dirs);
    const mine: LockFile = {
      pid: process.pid,
      startedAt: iso(clock.now()),
      token: newUlid(),
      heartbeatAt: iso(clock.now()),
    };
    const body = JSON.stringify(mine);
    let kind: "acquired" | "reclaimed" = "acquired";
    let created = await createExclusive(path, body);
    for (let attempt = 0; !created && attempt < 3; attempt++) {
      let cur = await readLock(path);
      if (cur.kind === "garbage") {
        await Bun.sleep(50);
        cur = await readLock(path);
        if (cur.kind === "garbage") return { kind: "held" };
      }
      if (cur.kind === "missing") {
        // released, or renamed away by a reclaimer that is about to create its own lock: give that election a
        // moment to finish, and create only if the lock is still absent (a genuine release)
        await Bun.sleep(25);
        if ((await readLock(path)).kind !== "missing") continue;
        created = await createExclusive(path, body);
        continue;
      }
      const stale =
        !pidAlive(cur.lock.pid) || minutesBetween(cur.lock.heartbeatAt, iso(clock.now())) > STALE_MIN;
      if (!stale) return { kind: "held" };
      const moved = `${path}.stale-${mine.token}`;
      try {
        await rename(path, moved);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "held" }; // lost the election
        throw e;
      }
      const movedRead = await readLock(moved);
      if (movedRead.kind !== "ok" || movedRead.lock.token !== cur.lock.token) {
        // a winner already re-created the lock and we moved that one: restore it and yield
        await link(moved, path).catch(() => undefined);
        await unlink(moved).catch(() => undefined);
        return { kind: "held" };
      }
      created = await createExclusive(path, body);
      await unlink(moved).catch(() => undefined);
      if (!created) return { kind: "held" };
      kind = "reclaimed";
    }
    if (!created) return { kind: "held" };
    let lost = false;
    let beating = false;
    // R16: compare the on-disk token before every heartbeat write; a different (or missing) token means another tick reclaimed
    // the lock while this one was frozen, so stop for good and never overwrite it. A failed write is retried by the next beat: a
    // missed heartbeat only ages the lock, and the 15-minute staleness rule tolerates many of those.
    const beat = async () => {
      if (lost || beating) return;
      beating = true;
      try {
        const cur = await readLock(path).catch((): LockRead => ({ kind: "garbage" }));
        if (cur.kind !== "ok" || cur.lock.token !== mine.token) {
          lost = true;
          clearInterval(timer);
          return;
        }
        await writeAtomic(path, JSON.stringify({ ...mine, heartbeatAt: iso(clock.now()) }));
      } catch {
        /* retried by the next beat (see above) */
      } finally {
        beating = false;
      }
    };
    const timer = setInterval(() => {
      void beat();
    }, opts.heartbeatMs ?? HEARTBEAT_MS);
    timer.unref();
    return {
      kind,
      lost: () => lost,
      verify: async () => {
        const cur = await readLock(path);
        if (cur.kind !== "ok" || cur.lock.token !== mine.token) lost = true;
        return !lost;
      },
      release: async () => {
        clearInterval(timer);
        try {
          const cur = JSON.parse(await readFile(path, "utf8")) as LockFile;
          if (cur.token === mine.token) await unlink(path);
        } catch {
          /* already gone */
        }
      },
    };
  },
};

/** Same-process callers queue in call order per identifier; the file lock below still protects across processes. */
const inProcessChains = new Map<string, Promise<unknown>>();

/** Per-record mutex (§6.0): an O_EXCL lock file next to the record; stale (dead pid or > 60 s) locks are broken. */
export async function withRecordLock<T>(
  dirs: Dirs,
  identifier: string,
  fn: () => Promise<T>,
  waitMs = 10_000,
): Promise<T> {
  const prev = inProcessChains.get(identifier) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(() => withFileLock(dirs, identifier, fn, waitMs));
  inProcessChains.set(identifier, run);
  try {
    return await run;
  } finally {
    if (inProcessChains.get(identifier) === run) inProcessChains.delete(identifier);
  }
}

async function withFileLock<T>(
  dirs: Dirs,
  identifier: string,
  fn: () => Promise<T>,
  waitMs: number,
): Promise<T> {
  const path = join(dirs.records, `${identifier}.lock`);
  const started = Date.now();
  for (;;) {
    if (await createExclusive(path, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })))
      break;
    try {
      const cur = JSON.parse(await readFile(path, "utf8")) as { pid: number; at: string };
      if (!pidAlive(cur.pid) || Date.now() - Date.parse(cur.at) > 60_000) {
        await unlink(path).catch(() => undefined);
        continue;
      }
    } catch {
      await unlink(path).catch(() => undefined);
      continue;
    }
    if (Date.now() - started > waitMs) throw new Error(`record lock timeout for ${identifier}`);
    await Bun.sleep(25);
  }
  try {
    return await fn();
  } finally {
    await unlink(path).catch(() => undefined);
  }
}
