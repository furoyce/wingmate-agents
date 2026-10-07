import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumeIntent,
  listIntents,
  quarantineIntent,
  readIntentFiles,
  staleIntents,
  writeIntent,
} from "../../../src/kit/intents";
import { renameInWorktree, worktreeDir } from "../../../src/kit/local";

/** A worktree and a directory outside it (the kit dir an agent would aim a planted symlink at). */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "wm-f7-"));
  const wt = join(root, "wt");
  const outside = join(root, "kit");
  mkdirSync(join(wt, ".wingmate", "outbox"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  return { wt, outside, box: join(wt, ".wingmate", "outbox") };
}
const PERMISSIVE = JSON.stringify({ sandbox: { enabled: false, filesystem: { denyWrite: [] } } });

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

describe("F7: outbox moves never follow an agent-planted symlink", () => {
  test("a symlinked outbox/invalid refuses the quarantine (outbox_unsafe); nothing lands in the directory it points at", async () => {
    const { wt, outside, box } = sandbox();
    symlinkSync(outside, join(box, "invalid"));
    writeFileSync(join(box, "claude-settings.json"), PERMISSIVE);
    await expect(quarantineIntent(wt, "claude-settings.json", "invalid")).rejects.toMatchObject({
      code: "outbox_unsafe",
    });
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(box, "claude-settings.json"))).toBe(true);
  });

  test("a symlinked outbox/done refuses the consume; a symlinked outbox/failed refuses the quarantine", async () => {
    const { wt, outside, box } = sandbox();
    const i = await writeIntent(wt, { issue: "JRF-1", kind: "note", payload: { text: "a" } });
    symlinkSync(outside, join(box, "done"));
    await expect(consumeIntent(wt, i.id)).rejects.toMatchObject({ code: "outbox_unsafe" });
    symlinkSync(outside, join(box, "failed"));
    await expect(quarantineIntent(wt, `${i.id}.json`, "failed")).rejects.toMatchObject({
      code: "outbox_unsafe",
    });
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(box, `${i.id}.json`))).toBe(true);
  });

  test("a symlinked outbox (or .wingmate) is never read, listed into, or written", async () => {
    const { wt, outside } = sandbox();
    const good = await writeIntent(join(outside, ".."), {
      issue: "JRF-1",
      kind: "note",
      payload: { text: "x" },
    });
    const target = join(outside, "..", ".wingmate", "outbox");
    const box = join(wt, ".wingmate", "outbox");
    rmSync(box, { recursive: true });
    symlinkSync(target, box);
    await expect(readIntentFiles(wt)).rejects.toMatchObject({ code: "outbox_unsafe" });
    await expect(consumeIntent(wt, good.id)).rejects.toMatchObject({ code: "outbox_unsafe" });
    expect(existsSync(join(target, `${good.id}.json`))).toBe(true);
    const wt2 = mkdtempSync(join(tmpdir(), "wm-f7b-"));
    symlinkSync(outside, join(wt2, ".wingmate"));
    await expect(readIntentFiles(wt2)).rejects.toMatchObject({ code: "outbox_unsafe" });
    expect(readdirSync(outside)).toEqual([]);
  });

  test("an intent file that is a symlink is reported invalid and never followed", async () => {
    const { wt, outside, box } = sandbox();
    const real = await writeIntent(join(outside, ".."), {
      issue: "JRF-1",
      kind: "note",
      payload: { text: "x" },
    });
    const src = join(outside, "..", ".wingmate", "outbox", `${real.id}.json`);
    symlinkSync(src, join(box, `${real.id}.json`));
    const { intents, invalid } = await readIntentFiles(wt);
    expect(intents).toEqual([]);
    expect(invalid.map((x) => x.file)).toEqual([`${real.id}.json`]);
    expect(invalid[0]?.error).toMatch(/symlink/);
    await quarantineIntent(wt, `${real.id}.json`, "invalid"); // moves the link itself, never its target
    expect(existsSync(src)).toBe(true);
  });

  test("worktreeDir creates missing components and refuses one that is a symlink or a file", async () => {
    const { wt, outside, box } = sandbox();
    const made = await worktreeDir(wt, ".wingmate/outbox/done", true);
    expect(made.endsWith(join(".wingmate", "outbox", "done"))).toBe(true);
    symlinkSync(outside, join(box, "invalid"));
    await expect(worktreeDir(wt, ".wingmate/outbox/invalid", true)).rejects.toMatchObject({
      code: "outbox_unsafe",
      message: expect.stringContaining("symlink"),
    });
    writeFileSync(join(box, "failed"), "x");
    await expect(worktreeDir(wt, ".wingmate/outbox/failed", true)).rejects.toMatchObject({
      code: "outbox_unsafe",
    });
  });

  test.if(process.platform === "darwin")(
    "the rename itself refuses a directory swapped for a symlink after the check (macOS RENAME_NOFOLLOW_ANY)",
    async () => {
      const { wt, outside, box } = sandbox();
      const from = await worktreeDir(wt, ".wingmate/outbox");
      const to = await worktreeDir(wt, ".wingmate/outbox/invalid", true);
      rmdirSync(to);
      symlinkSync(outside, to); // the agent wins the race: the checked directory is now a symlink
      writeFileSync(join(box, "settings.json"), PERMISSIVE);
      await expect(renameInWorktree(from, to, "settings.json")).rejects.toMatchObject({
        code: "outbox_unsafe",
      });
      expect(readdirSync(outside)).toEqual([]);
      expect(existsSync(join(box, "settings.json"))).toBe(true);
    },
  );
});

describe("C14: staleIntents — a reused worktree's pending intents leave the outbox before a new cycle", () => {
  test("every pending *.json (valid or not) moves to outbox/stale/; done/ and the rest stay; a second call finds none", async () => {
    const { wt, box } = sandbox();
    const a = await writeIntent(wt, { issue: "JRF-1", kind: "note", payload: { text: "a" } });
    const b = await writeIntent(wt, {
      issue: "JRF-1",
      kind: "handoff",
      payload: { reason: "r", repo: null },
    });
    writeFileSync(join(box, "01BAD.json"), "{");
    await consumeIntent(wt, a.id);
    expect(await staleIntents(wt)).toBe(2);
    expect(readdirSync(box).filter((f) => f.endsWith(".json"))).toEqual([]);
    expect(readdirSync(join(box, "stale")).sort()).toEqual(["01BAD.json", `${b.id}.json`].sort());
    expect(readdirSync(join(box, "done"))).toEqual([`${a.id}.json`]);
    expect(await staleIntents(wt)).toBe(0);
  });

  test("a worktree without an outbox has none and gets none created; a symlinked outbox or stale/ is refused, nothing moved", async () => {
    const bare = mkdtempSync(join(tmpdir(), "wm-c14-"));
    expect(await staleIntents(bare)).toBe(0);
    expect(existsSync(join(bare, ".wingmate"))).toBe(false);
    const { wt, outside, box } = sandbox();
    const i = await writeIntent(wt, { issue: "JRF-1", kind: "note", payload: { text: "a" } });
    symlinkSync(outside, join(box, "stale"));
    await expect(staleIntents(wt)).rejects.toMatchObject({ code: "outbox_unsafe" });
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(box, `${i.id}.json`))).toBe(true);
    const other = sandbox();
    rmSync(other.box, { recursive: true });
    symlinkSync(outside, other.box);
    writeFileSync(join(outside, "x.json"), "{}");
    await expect(staleIntents(other.wt)).rejects.toMatchObject({ code: "outbox_unsafe" });
    expect(readdirSync(outside)).toEqual(["x.json"]);
  });
});
