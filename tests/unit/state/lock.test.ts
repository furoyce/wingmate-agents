// tests/unit/state/lock.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
describe("TickLock heartbeat (R16)", () => {
  const read = () =>
    JSON.parse(readFileSync(join(root, "tick.lock"), "utf8")) as { token: string; heartbeatAt: string };
  test("refreshes heartbeatAt while the on-disk token is its own, and is never lost", async () => {
    const c = new FixedClock(new Date("2026-10-06T10:00:00Z"));
    const a = await TickLock.acquire(dirs, c, { heartbeatMs: 10 });
    if (a.kind === "held") throw new Error("expected the lock");
    c.advance(60_000);
    await Bun.sleep(60);
    expect(read().heartbeatAt).toBe("2026-10-06T10:01:00.000Z");
    expect(a.lost()).toBe(false);
    await a.release();
  });
  test("a heartbeat that finds another holder's token flips lost(), stops beating and never overwrites the new lock", async () => {
    const a = await TickLock.acquire(dirs, clock, { heartbeatMs: 10 });
    if (a.kind === "held") throw new Error("expected the lock");
    const foreign = JSON.stringify({
      pid: process.pid,
      startedAt: "2026-10-06T10:20:00Z",
      token: "theirs",
      heartbeatAt: "2026-10-06T10:20:00Z",
    });
    writeFileSync(join(root, "tick.lock"), foreign);
    await Bun.sleep(60);
    expect(a.lost()).toBe(true);
    expect(readFileSync(join(root, "tick.lock"), "utf8")).toBe(foreign);
    await Bun.sleep(40);
    expect(readFileSync(join(root, "tick.lock"), "utf8")).toBe(foreign);
    await a.release(); // releasing a lost lock leaves the new holder's file alone
    expect(read().token).toBe("theirs");
  });
  test("a lock file removed under the holder counts as lost (it is never re-created by a heartbeat)", async () => {
    const a = await TickLock.acquire(dirs, clock, { heartbeatMs: 10 });
    if (a.kind === "held") throw new Error("expected the lock");
    rmSync(join(root, "tick.lock"));
    await Bun.sleep(60);
    expect(a.lost()).toBe(true);
    expect(readdirSync(root).filter((n) => n.startsWith("tick.lock"))).toEqual([]);
    await a.release();
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
describe("TickLock races (regression: concurrent acquirers must never both succeed)", () => {
  type Result = Awaited<ReturnType<typeof TickLock.acquire>>;
  const kinds = (xs: Result[]) => xs.map((x) => x.kind).sort();
  const releaseAll = async (xs: Result[]) => {
    for (const x of xs) if (x.kind !== "held") await x.release();
  };
  test("two concurrent acquirers on a fresh dir: exactly one acquired, one held (30×)", async () => {
    for (let i = 0; i < 30; i++) {
      const d = homeDirs({ WINGMATE_HOME: join(root, `fresh-${i}`), WINGMATE_CONFIG_HOME: root, HOME: root });
      const res = await Promise.all([TickLock.acquire(d, clock), TickLock.acquire(d, clock)]);
      expect(kinds(res)).toEqual(["acquired", "held"]);
      await releaseAll(res);
    }
  });
  test("two concurrent reclaimers of a stale lock: exactly one reclaimed, one held (30×)", async () => {
    for (let i = 0; i < 30; i++) {
      const home = join(root, `stale-${i}`);
      mkdirSync(home, { recursive: true });
      writeFileSync(
        join(home, "tick.lock"),
        JSON.stringify({
          pid: 999999,
          startedAt: "2026-10-06T09:00:00Z",
          token: `old-${i}`,
          heartbeatAt: "2026-10-06T09:40:00Z",
        }),
      );
      const d = homeDirs({ WINGMATE_HOME: home, WINGMATE_CONFIG_HOME: root, HOME: root });
      const res = await Promise.all([TickLock.acquire(d, clock), TickLock.acquire(d, clock)]);
      expect(kinds(res)).toEqual(["held", "reclaimed"]);
      await releaseAll(res);
      expect(readdirSync(home).filter((n) => n.includes(".stale-"))).toEqual([]);
    }
  });
  test("a lock file containing garbage is held, never reclaimed", async () => {
    writeFileSync(join(root, "tick.lock"), "not json at all");
    const a = await TickLock.acquire(dirs, clock);
    expect(a.kind).toBe("held");
  });
});
