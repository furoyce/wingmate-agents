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
  test("times out on process tree quickly with no orphans", async () => {
    const start = Date.now();
    const r = await run(["sh", "-c", "sleep 3; echo done"], { timeoutMs: 200 });
    const elapsed = Date.now() - start;
    expect(r.timedOut).toBe(true);
    expect(r.code).toBe(124);
    expect(elapsed).toBeLessThan(1000);
  });
  test("normal exit returns stdout and code", async () => {
    const r = await run(["sh", "-c", "printf test; exit 0"]);
    expect(r.stdout).toBe("test");
    expect(r.code).toBe(0);
    expect(r.timedOut).toBe(false);
  });
});
