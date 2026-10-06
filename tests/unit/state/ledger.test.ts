// tests/unit/state/ledger.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeDirs } from "../../../src/shared/paths";
import { Ledger } from "../../../src/state/ledger";
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wm-l-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe("Ledger", () => {
  test("appends one JSON line per event to the issue and global files", async () => {
    const l = new Ledger(homeDirs({ WINGMATE_HOME: root, WINGMATE_CONFIG_HOME: root, HOME: root }));
    await l.append({
      at: "2026-10-06T10:00:00.000Z",
      issue: "JRF-404",
      type: "transition",
      data: { from: "claimed", to: "working" },
    });
    await l.append({
      at: "2026-10-06T10:01:00.000Z",
      issue: "JRF-404",
      type: "gate",
      data: { stage: "plan", verdict: "PASS" },
    });
    const rows = await l.readIssue("JRF-404");
    expect(rows.length).toBe(2);
    expect(rows[1]?.type).toBe("gate");
    expect((await Bun.file(join(root, "ledger", "global.jsonl")).text()).trim().split("\n").length).toBe(2);
  });
});
