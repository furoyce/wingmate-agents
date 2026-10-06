import { describe, expect, test } from "bun:test";
import { run } from "../../../src/shared/exec";
describe("exec.run", () => {
  test("captures stdout and exit code", async () => {
    const r = await run(["sh", "-c", "printf hello; exit 3"]);
    expect(r.stdout).toBe("hello");
    expect(r.code).toBe(3);
    expect(r.timedOut).toBe(false);
  });
  test("times out and reports it", async () => {
    const r = await run(["sleep", "5"], { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
  });
});
