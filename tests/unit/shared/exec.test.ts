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
  test("times out on process tree quickly and kills all children", async () => {
    const start = Date.now();
    const r = await run(["sh", "-c", "sleep 3.141; echo done"], { timeoutMs: 200 });
    const elapsed = Date.now() - start;
    expect(r.timedOut).toBe(true);
    expect(r.code).toBe(124);
    expect(elapsed).toBeLessThan(1000);
    // Verify entire tree was killed (no orphans)
    const orphanCheck = Bun.spawnSync(["pgrep", "-f", "sleep 3.141"]);
    expect(orphanCheck.stdout.toString().trim()).toBe("");
  });
  test.skipIf(!Bun.which("perl"))(
    "times out on escaped grandchild inheriting pipes and returns partial output",
    async () => {
      const start = Date.now();
      // Perl child creates new session (escapes group) but inherits stdout/stderr; main process also sleeps
      const r = await run(
        [
          "sh",
          "-c",
          'echo partial-out; echo partial-err 1>&2; perl -e \'use POSIX; POSIX::setsid(); exec "sleep", "6.173"\' & sleep 6.173',
        ],
        { timeoutMs: 200 },
      );
      const elapsed = Date.now() - start;
      expect(r.timedOut).toBe(true);
      expect(r.code).toBe(124);
      expect(r.stdout).toContain("partial-out");
      expect(r.stderr).toContain("partial-err");
      // Grace period (2s) provides bound even when escaped child holds pipes
      expect(elapsed).toBeLessThan(3500);
      // Clean up escapee
      Bun.spawnSync(["pkill", "-f", "sleep 6.173"]);
    },
  );
  test("normal exit returns stdout and code", async () => {
    const r = await run(["sh", "-c", "printf test; exit 0"]);
    expect(r.stdout).toBe("test");
    expect(r.code).toBe(0);
    expect(r.timedOut).toBe(false);
  });
});
