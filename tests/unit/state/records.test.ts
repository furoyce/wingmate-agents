// tests/unit/state/records.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeDirs } from "../../../src/shared/paths";
import {
  archiveRecord,
  createRecordExclusive,
  listRecords,
  newRecord,
  readRecord,
  writeRecord,
} from "../../../src/state/records";
let root: string;
let dirs: ReturnType<typeof homeDirs>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wm-rec-"));
  dirs = homeDirs({ WINGMATE_HOME: root, WINGMATE_CONFIG_HOME: root, HOME: root });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe("records", () => {
  test("exclusive create succeeds once and fails the second time with record_exists", async () => {
    const r = newRecord({
      identifier: "JRF-404",
      linearId: "lin-404",
      project: "bouncr",
      repo: "api",
      provider: "claude",
      autonomy: "ask-first",
      now: "2026-10-06T10:00:00.000Z",
    });
    await createRecordExclusive(dirs, r);
    await expect(createRecordExclusive(dirs, r)).rejects.toMatchObject({ code: "record_exists" });
    const back = await readRecord(dirs, "JRF-404");
    expect(back?.stage).toBe("claimed");
    expect(back?.cycle).toBe(1);
    expect(back?.schemaVersion).toBe(1);
  });
  test("write is atomic and round-trips through the schema", async () => {
    const r = newRecord({
      identifier: "JRF-1",
      linearId: "l1",
      project: "bouncr",
      repo: "api",
      provider: "codex",
      autonomy: "balanced",
      now: "2026-10-06T10:00:00.000Z",
    });
    await createRecordExclusive(dirs, r);
    r.stage = "working";
    r.coordinator.terminalHandle = "term_abc";
    await writeRecord(dirs, r);
    expect((await readRecord(dirs, "JRF-1"))?.coordinator.terminalHandle).toBe("term_abc");
    // temp names are `<path>.<pid>.<ts>.tmp`; none may survive the rename
    expect(
      readdirSync(dirs.records).filter((n) => n.startsWith("JRF-1.json.") && n.endsWith(".tmp")),
    ).toEqual([]);
  });
  test("archive moves the file under archive/<id>.<cycle>.json and frees the slot", async () => {
    const r = newRecord({
      identifier: "JRF-2",
      linearId: "l2",
      project: "bouncr",
      repo: "api",
      provider: "claude",
      autonomy: "ask-first",
      now: "2026-10-06T10:00:00.000Z",
    });
    await createRecordExclusive(dirs, r);
    await archiveRecord(dirs, "JRF-2");
    expect(await readRecord(dirs, "JRF-2")).toBeNull();
    expect(existsSync(join(dirs.archive, "JRF-2.1.json"))).toBe(true);
    expect((await listRecords(dirs)).length).toBe(0);
  });
  test("rejects a corrupt record with record_invalid", async () => {
    await Bun.write(join(dirs.records, "JRF-9.json"), '{"schemaVersion":1}');
    await expect(readRecord(dirs, "JRF-9")).rejects.toMatchObject({ code: "record_invalid" });
  });
  test("rejects a non-JSON record file with record_invalid (not a raw SyntaxError)", async () => {
    await Bun.write(join(dirs.records, "JRF-8.json"), "{not json");
    await expect(readRecord(dirs, "JRF-8")).rejects.toMatchObject({ code: "record_invalid" });
  });
});
