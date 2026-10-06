import { describe, expect, test } from "bun:test";
import { run } from "../../../src/shared/exec";
describe("exec.run", () => {
  test("captures stdout and exit code", async () => {
    const r = await run(["sh", "-c", "printf hello; exit 3"]);
    expect(r.stdout).toBe("hello");
    expect(r.code).toBe(3);
    expect(r.timedOut).toBe(false);
  });
  test("times out on leaf process quickly", async () => {
    const start = Date.now();
    const r = await run(["sleep", "5"], { timeoutMs: 200 });
    const elapsed = Date.now() - start;
    expect(r.timedOut).toBe(true);
    expect(r.code).toBe(124);
    expect(elapsed).toBeLessThan(1000);
  });
  test("times out on process tree quickly", async () => {
    const start = Date.now();
    const r = await run(["sh", "-c", "sleep 3; echo done"], { timeoutMs: 200 });
    const elapsed = Date.now() - start;
    expect(r.timedOut).toBe(true);
    expect(r.code).toBe(124);
    // Wall-clock timeout enforced despite child process tree
    expect(elapsed).toBeLessThan(1000);
  });
  test("times out on escaped grandchild holding pipes", async () => {
    const start = Date.now();
    // Attempt using setsid to escape process group; fall back to perl/python if unavailable
    let cmd: string[];
    try {
      await run(["setsid", "sleep", "1"], { timeoutMs: 50 });
      cmd = ["sh", "-c", "setsid sleep 6 >/dev/null 2>&1 & sleep 6"];
    } catch {
      // setsid not available; try perl or python
      cmd = ["perl", "-e", "use POSIX; setsid(); exec 'sleep', '6'"];
    }
    const r = await run(cmd, { timeoutMs: 200 });
    const elapsed = Date.now() - start;
    expect(r.timedOut).toBe(true);
    expect(r.code).toBe(124);
    // Grace period bounds wall-clock time even with escaped children
    expect(elapsed).toBeLessThan(3000);
  });
  test("normal exit returns stdout and code", async () => {
    const r = await run(["sh", "-c", "printf test; exit 0"]);
    expect(r.stdout).toBe("test");
    expect(r.code).toBe(0);
    expect(r.timedOut).toBe(false);
  });
});
