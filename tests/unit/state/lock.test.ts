// tests/unit/state/lock.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeDirs } from "../../../src/shared/paths";
import { FixedClock } from "../../../src/shared/time";
import { TickLock, withRecordLock } from "../../../src/state/lock";
let root: string;
let dirs: ReturnType<typeof homeDirs>;
const clock = new FixedClock(new Date("2026-10-06T10:00:00Z"));
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wm-lock-"));
  dirs = homeDirs({ WINGMATE_HOME: root, WINGMATE_CONFIG_HOME: root, HOME: root });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe("TickLock", () => {
  test("acquires, then reports held to a second acquirer, then releases", async () => {
    const a = await TickLock.acquire(dirs, clock);
    expect(a.kind).toBe("acquired");
    const b = await TickLock.acquire(dirs, clock);
    expect(b.kind).toBe("held");
    if (a.kind !== "held") await a.release();
    const c = await TickLock.acquire(dirs, clock);
    expect(c.kind).toBe("acquired");
    if (c.kind !== "held") await c.release();
  });
  test("reclaims a lock whose pid is dead", async () => {
    writeFileSync(
      join(root, "tick.lock"),
      JSON.stringify({
        pid: 999999,
        startedAt: "2026-10-06T09:00:00Z",
        token: "old",
        heartbeatAt: "2026-10-06T09:59:00Z",
      }),
    );
    const a = await TickLock.acquire(dirs, clock);
    expect(a.kind).toBe("reclaimed");
    if (a.kind !== "held") await a.release();
  });
  test("reclaims a live-pid lock whose heartbeat is older than 15 minutes", async () => {
    writeFileSync(
      join(root, "tick.lock"),
      JSON.stringify({
        pid: process.pid,
        startedAt: "2026-10-06T09:00:00Z",
        token: "old",
        heartbeatAt: "2026-10-06T09:40:00Z",
      }),
    );
    const a = await TickLock.acquire(dirs, clock);
    expect(a.kind).toBe("reclaimed");
    if (a.kind !== "held") await a.release();
  });
  test("does not reclaim a live-pid lock with a fresh heartbeat", async () => {
    writeFileSync(
      join(root, "tick.lock"),
      JSON.stringify({
        pid: process.pid,
        startedAt: "2026-10-06T09:59:00Z",
        token: "old",
        heartbeatAt: "2026-10-06T09:59:30Z",
      }),
    );
    const a = await TickLock.acquire(dirs, clock);
    expect(a.kind).toBe("held");
  });
});
describe("withRecordLock", () => {
  test("serializes two writers", async () => {
    const order: string[] = [];
    await Promise.all([
      withRecordLock(dirs, "JRF-1", async () => {
        order.push("a-start");
        await Bun.sleep(50);
        order.push("a-end");
      }),
      withRecordLock(dirs, "JRF-1", async () => {
        order.push("b-start");
        order.push("b-end");
      }),
    ]);
    expect(order.indexOf("a-end")).toBeLessThan(order.indexOf("b-start"));
  });
});
