// src/machine/save.ts — §6.0 record writes during a tick (F1): the record lock is held for one read-compare-write (< 1 s), never
// across Orca waits, the setup command or Linear calls, and a record another process changed meanwhile is never overwritten.
import { withRecordLock } from "../state/lock";
import { type WRecord, readRecord, recordText, writeRecord } from "../state/records";
import type { Ctx } from "./context";
import { RecordAbort } from "./guard";

/** The version (record text) the tick last read or wrote, per record object it is advancing, claiming or cleaning up. */
const versions = new WeakMap<WRecord, string>();

/** Starts tracking `r` as the version on disk now; every later `saveRecord` of this object is a compare-and-write. */
export function trackRecord(r: WRecord): void {
  versions.set(r, recordText(r));
}

/**
 * Reads the record under its lock (held for this read only) and tracks it; null when it is gone or no longer the version `seen`
 * (another process wrote it since reconcile read it).
 */
export async function readTracked(ctx: Ctx, identifier: string, seen?: WRecord): Promise<WRecord | null> {
  return withRecordLock(ctx.dirs, identifier, async () => {
    const r = await readRecord(ctx.dirs, identifier);
    if (!r || (seen && recordText(r) !== recordText(seen))) return null;
    trackRecord(r);
    return r;
  });
}

/**
 * Writes the record. A tracked record is written only when the file still holds the version this tick last read or wrote — checked
 * and written under the record lock — and otherwise the record's processing stops with `record_changed` (the newer write stands,
 * the next tick re-derives from it). An untracked record (a direct caller outside the tick) is written as it is.
 */
export async function saveRecord(ctx: Ctx, r: WRecord): Promise<void> {
  const expected = versions.get(r);
  if (expected === undefined) return writeRecord(ctx.dirs, r);
  await withRecordLock(ctx.dirs, r.identifier, async () => {
    const disk = await readRecord(ctx.dirs, r.identifier);
    if (!disk || recordText(disk) !== expected) throw new RecordAbort("record_changed", r.identifier);
    await writeRecord(ctx.dirs, r);
  });
  versions.set(r, recordText(r));
}
