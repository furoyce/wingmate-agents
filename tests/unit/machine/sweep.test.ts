// tests/unit/machine/sweep.test.ts — the §13.3(i) process sweep against real child processes of this test
import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweep } from "../../../src/machine/sweep";
import { run } from "../../../src/shared/exec";
import { newUuid } from "../../../src/shared/ids";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "wm-sweep-")));
const sleeper = (cwd: string, secs: number) =>
  Bun.spawn(["sleep", String(secs)], { cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore" });

describe("sweep (§13.3 i)", () => {
  test("kills this user's processes whose cwd is under the path and leaves the others", async () => {
    const dir = tempDir();
    const inside = sleeper(dir, 60);
    const outside = sleeper(tmpdir(), 61);
    try {
      await Bun.sleep(150);
      const res = await sweep([dir]);
      expect(res.killed).toContain(String(inside.pid));
      expect(res.killed).not.toContain(String(outside.pid));
      expect(res.commands).toContain("sleep");
      await inside.exited;
      expect(alive(outside.pid)).toBe(true);
    } finally {
      inside.kill();
      outside.kill();
    }
  }, 30_000);

  test("spare: the process whose command line carries the marker and its ancestors survive; its descendants do not", async () => {
    const dir = tempDir();
    const marker = `wm-spare-${newUuid()}`;
    // `; true` keeps the shell alive as the sleep's parent (no exec optimization)
    const shell = Bun.spawn(["/bin/sh", "-c", "sleep 63; true", marker], {
      cwd: dir,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      await Bun.sleep(200);
      const child = Number((await run(["pgrep", "-P", String(shell.pid)])).stdout.trim().split("\n")[0]);
      expect(child).toBeGreaterThan(0);
      const res = await sweep([dir], { spare: marker });
      expect(res.killed).toContain(String(child));
      expect(res.killed).not.toContain(String(shell.pid));
      expect(res.killed).not.toContain(String(process.pid));
    } finally {
      shell.kill();
    }
  }, 30_000);

  test("no paths: nothing is listed or killed", async () => {
    expect(await sweep([])).toEqual({ killed: [], commands: [] });
  });
});
