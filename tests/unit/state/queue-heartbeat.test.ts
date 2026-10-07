// tests/unit/state/queue-heartbeat.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeDirs } from "../../../src/shared/paths";
import {
  clearStop,
  readHeartbeat,
  readLastTick,
  releaseStop,
  requestStop,
  stopRequested,
  writeHeartbeat,
} from "../../../src/state/heartbeat";
import { readQueue, writeQueue } from "../../../src/state/queue";
let root: string;
let dirs: ReturnType<typeof homeDirs>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wm-q-"));
  dirs = homeDirs({ WINGMATE_HOME: root, WINGMATE_CONFIG_HOME: root, HOME: root });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe("queue + heartbeat", () => {
  test("queue round-trips with skip reasons", async () => {
    await writeQueue(dirs, {
      at: "2026-10-06T10:00:00.000Z",
      items: [
        {
          identifier: "JRF-16",
          project: "bouncr",
          status: "skipped",
          reason: "cap_project",
          detail: "JRF-404",
          nextEvalAt: null,
        },
      ],
    });
    expect((await readQueue(dirs))?.items[0]?.reason).toBe("cap_project");
  });
  test("heartbeat round-trips and stop flag is scoped", async () => {
    await writeHeartbeat(dirs, {
      kind: "tick",
      at: "2026-10-06T10:00:00.000Z",
      exitCode: 1,
      outcome: "idle",
      reason: null,
      durationMs: 1200,
      pausedScopes: [],
      linearAuth: { ok: true, expiresAt: null },
      orcaReachable: true,
      counts: {},
    });
    expect((await readHeartbeat(dirs))?.outcome).toBe("idle");
    // R16: a tick whose lock was reclaimed while it was frozen records lock_lost
    await writeHeartbeat(dirs, {
      kind: "tick",
      at: "2026-10-06T10:05:00.000Z",
      exitCode: 1,
      outcome: "lock_lost",
      reason: "lock_lost",
      durationMs: 900,
      pausedScopes: [],
      linearAuth: { ok: true, expiresAt: null },
      orcaReachable: true,
      counts: {},
    });
    expect((await readHeartbeat(dirs))?.outcome).toBe("lock_lost");
    expect(await stopRequested(dirs, "bouncr")).toBe(false);
    await requestStop(dirs, { scope: "project", key: "bouncr", at: "2026-10-06T10:01:00.000Z" });
    expect(await stopRequested(dirs, "bouncr")).toBe(true);
    expect(await stopRequested(dirs, "smart-dispatcher")).toBe(false);
    await clearStop(dirs);
    expect(await stopRequested(dirs, "bouncr")).toBe(false);
  });
  test("C17: the last tick's heartbeat survives a later scan heartbeat (§6.7 measures the gap from the tick)", async () => {
    const beat = (kind: "tick" | "scan", at: string) =>
      writeHeartbeat(dirs, {
        kind,
        at,
        exitCode: 1,
        outcome: "idle",
        reason: null,
        durationMs: 10,
        pausedScopes: [],
        linearAuth: { ok: true, expiresAt: null },
        orcaReachable: true,
        counts: {},
      });
    expect(await readLastTick(dirs)).toBeNull();
    await beat("scan", "2026-10-06T09:00:00.000Z");
    expect(await readLastTick(dirs)).toBeNull(); // a scan is never a tick
    await beat("tick", "2026-10-06T10:00:00.000Z");
    await beat("scan", "2026-10-06T10:20:00.000Z");
    expect((await readHeartbeat(dirs))?.kind).toBe("scan"); // §6.5: heartbeat.json is the latest of either
    expect(await readLastTick(dirs)).toMatchObject({ kind: "tick", at: "2026-10-06T10:00:00.000Z" });
  });
});

describe("releaseStop (Task 12)", () => {
  test("removes only the entry one stop wrote; the file goes once no entry is left", async () => {
    const all = { scope: "all" as const, at: "2026-10-06T10:00:00.000Z" };
    const one = { scope: "issue" as const, key: "JRF-1", at: "2026-10-06T10:01:00.000Z" };
    await requestStop(dirs, all);
    await requestStop(dirs, one);
    await releaseStop(dirs, one);
    expect(await stopRequested(dirs)).toBe(true);
    expect(await stopRequested(dirs, "bouncr", "JRF-2")).toBe(true); // `all` still covers everything
    await releaseStop(dirs, { scope: "issue", key: "JRF-1", at: "2026-10-06T10:01:00.000Z" }); // already gone: no-op
    await releaseStop(dirs, all);
    expect(await stopRequested(dirs)).toBe(false);
    expect(existsSync(join(dirs.state, "stop-requested.json"))).toBe(false);
  });
});
