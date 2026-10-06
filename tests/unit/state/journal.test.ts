// tests/unit/state/journal.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeDirs } from "../../../src/shared/paths";
import { FixedClock } from "../../../src/shared/time";
import { Journal } from "../../../src/state/journal";
let root: string;
const clock = new FixedClock(new Date("2026-10-06T10:00:00Z"));
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wm-j-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe("Journal", () => {
  test("intent → acted → confirmed lifecycle and pending listing", async () => {
    const j = new Journal(homeDirs({ WINGMATE_HOME: root, WINGMATE_CONFIG_HOME: root, HOME: root }), clock);
    const e = await j.intent({
      issue: "JRF-404",
      kind: "commentCreate",
      key: "uuid-1",
      input: { body: "hi" },
    });
    expect((await j.pending()).map((p) => p.id)).toEqual([e.id]);
    await j.acted(e.id, { commentId: "c1" });
    expect((await j.pending())[0]?.state).toBe("acted");
    await j.confirmed(e.id);
    expect(await j.pending()).toEqual([]);
  });
  test("three failures poison the entry", async () => {
    const j = new Journal(homeDirs({ WINGMATE_HOME: root, WINGMATE_CONFIG_HOME: root, HOME: root }), clock);
    const e = await j.intent({ issue: "JRF-404", kind: "issueUpdate", key: "k", input: {} });
    await j.failed(e.id, "boom");
    await j.failed(e.id, "boom");
    await j.failed(e.id, "boom");
    const got = (await j.all()).find((x) => x.id === e.id);
    expect(got?.state).toBe("poisoned");
    expect(got?.attempts).toBe(3);
    expect(await j.pending()).toEqual([]);
  });
});
