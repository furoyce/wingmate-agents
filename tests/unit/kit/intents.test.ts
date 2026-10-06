import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeIntent, listIntents, writeIntent } from "../../../src/kit/intents";

describe("intents", () => {
  test("write → list (ordered) → consume moves to done/", async () => {
    const wt = mkdtempSync(join(tmpdir(), "wm-wt-"));
    const a = await writeIntent(wt, { issue: "JRF-1", kind: "note", payload: { text: "a" } });
    const b = await writeIntent(wt, {
      issue: "JRF-1",
      kind: "ask",
      payload: { questionFile: "q.md", options: ["x"], recommend: null },
    });
    expect((await listIntents(wt)).map((i) => i.id)).toEqual([a.id, b.id]);
    await consumeIntent(wt, a.id);
    expect((await listIntents(wt)).map((i) => i.id)).toEqual([b.id]);
    expect(await Bun.file(join(wt, ".wingmate", "outbox", "done", `${a.id}.json`)).exists()).toBe(true);
  });
  test("rejects malformed intents", async () => {
    const wt = mkdtempSync(join(tmpdir(), "wm-wt2-"));
    await Bun.write(join(wt, ".wingmate", "outbox", "01BAD.json"), '{"kind":"nope"}');
    await expect(listIntents(wt)).rejects.toThrow(/intent_invalid/);
    await expect(listIntents(wt)).rejects.toThrow(/01BAD\.json/); // names the file (Task 10 contract)
  });
  test("intents written in the same millisecond list in write order (monotonic ULIDs)", async () => {
    const wt = mkdtempSync(join(tmpdir(), "wm-wt3-"));
    const ids: string[] = [];
    for (let n = 0; n < 40; n++)
      ids.push((await writeIntent(wt, { issue: "JRF-1", kind: "note", payload: { text: `n${n}` } })).id);
    expect((await listIntents(wt)).map((i) => i.id)).toEqual(ids);
  });
  test("an intent whose id does not match its file name, or whose file path escapes the worktree, is invalid", async () => {
    const wt = mkdtempSync(join(tmpdir(), "wm-wt4-"));
    const good = await writeIntent(wt, { issue: "JRF-1", kind: "note", payload: { text: "a" } });
    await Bun.write(join(wt, ".wingmate", "outbox", "01ZZZZZZZZZZZZZZZZZZZZZZZZ.json"), JSON.stringify(good));
    await expect(listIntents(wt)).rejects.toThrow(/01ZZZZZZZZZZZZZZZZZZZZZZZZ\.json: id .* does not match/);
    const wt2 = mkdtempSync(join(tmpdir(), "wm-wt5-"));
    const evil = {
      id: "01J0000000000000000000ASK1",
      issue: "JRF-1",
      createdAt: "2026-10-06T10:00:00.000Z",
      kind: "ask",
      payload: { questionFile: "../../.config/wingmate/credentials.json", options: [], recommend: null },
    };
    await Bun.write(join(wt2, ".wingmate", "outbox", `${evil.id}.json`), JSON.stringify(evil));
    await expect(listIntents(wt2)).rejects.toThrow(
      /questionFile must be a relative path inside the worktree/,
    );
    await expect(
      writeIntent(wt2, {
        issue: "JRF-1",
        kind: "finish",
        payload: { summaryFile: "/etc/passwd", title: null, draft: false, repos: [] },
      }),
    ).rejects.toThrow(/intent_invalid/);
  });
  test("consume refuses an id that is not a bare intent id", async () => {
    const wt = mkdtempSync(join(tmpdir(), "wm-wt6-"));
    await expect(consumeIntent(wt, "../../etc/passwd")).rejects.toThrow(/intent_invalid/);
    expect(existsSync(join(wt, ".wingmate", "outbox", "done"))).toBe(false);
  });
});
