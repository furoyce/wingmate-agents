// tests/unit/machine/save.test.ts — F1: tick record writes are compare-and-write under a short-lived record lock
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isRecordAbort, isTickAbort } from "../../../src/machine/guard";
import { readTracked, saveRecord, trackRecord } from "../../../src/machine/save";
import { newRecord, readRecord, writeRecord } from "../../../src/state/records";
import { makeWorld } from "../../fakes/world";

const fresh = (now: string) =>
  newRecord({
    identifier: "JRF-501",
    linearId: "i1",
    project: "bouncr",
    repo: "api",
    provider: "claude",
    autonomy: "ask-first",
    now,
  });

describe("saveRecord / readTracked (F1, §6.0)", () => {
  test("a tracked record is written while the file holds the version it last read or wrote, and the lock is released", async () => {
    const w = await makeWorld();
    await writeRecord(w.dirs, fresh(w.ctx.now()));
    const r = await readTracked(w.ctx, "JRF-501");
    if (!r) throw new Error("record missing");
    r.attention.push("first");
    await saveRecord(w.ctx, r);
    r.attention.push("second");
    await saveRecord(w.ctx, r); // its own previous write is the version it compares with
    expect((await readRecord(w.dirs, "JRF-501"))?.attention).toEqual(["first", "second"]);
    expect(existsSync(join(w.dirs.records, "JRF-501.lock"))).toBe(false);
  });

  test("another writer's change is never overwritten: record_changed, a RecordAbort the tick's abort catches let through", async () => {
    const w = await makeWorld();
    await writeRecord(w.dirs, fresh(w.ctx.now()));
    const r = await readTracked(w.ctx, "JRF-501");
    if (!r) throw new Error("record missing");
    const other = await readRecord(w.dirs, "JRF-501");
    if (!other) throw new Error("record missing");
    other.stage = "blocked";
    await writeRecord(w.dirs, other); // `wingmate stop`, a Console action
    r.attention.push("stale");
    const err = await saveRecord(w.ctx, r).catch((e: unknown) => e);
    expect(isRecordAbort(err) && err.code).toBe("record_changed");
    expect(isTickAbort(err)).toBe(true);
    expect(await readRecord(w.dirs, "JRF-501")).toMatchObject({ stage: "blocked", attention: [] });
  });

  test("readTracked refuses a record that is no longer the version reconcile saw; an untracked record is written as is", async () => {
    const w = await makeWorld();
    const seen = fresh(w.ctx.now());
    await writeRecord(w.dirs, seen);
    const changed = structuredClone(seen);
    changed.paused = true;
    await writeRecord(w.dirs, changed);
    expect(await readTracked(w.ctx, "JRF-501", seen)).toBeNull();
    const plain = fresh(w.ctx.now());
    plain.attention.push("direct");
    await saveRecord(w.ctx, plain);
    expect((await readRecord(w.dirs, "JRF-501"))?.attention).toEqual(["direct"]);
    trackRecord(plain);
    await saveRecord(w.ctx, plain);
  });
});
