import { describe, expect, test } from "bun:test";
import { TOKEN_ENV } from "../../../src/linear/envToken";
import { WITHHELD_ENV, childEnv, run } from "../../../src/shared/exec";

const hasPerl = Bun.which("perl") !== null;
const hasProcTools = Bun.which("pgrep") !== null && Bun.which("pkill") !== null;
// pgrep/pkill -f match machine-wide, so every pattern carries a pid-derived duration unique to this test process.
const treeSleep = (3 + (process.pid % 97) / 1000).toFixed(3);
const escapeSleep = (6 + (process.pid % 89) / 1000).toFixed(3);
const stillRunning = (pattern: string) =>
  Bun.spawnSync(["pgrep", "-f", pattern]).stdout.toString().trim() !== "";

describe("exec.run", () => {
  test("trusted host helpers can use an explicit environment without inheriting arbitrary parent values", async () => {
    const previous = process.env.WM_NATIVE_PARENT_FIXTURE;
    process.env.WM_NATIVE_PARENT_FIXTURE = "owner-only-fixture";
    try {
      const argv = [
        "/bin/sh",
        "-c",
        'printf "%s|%s" "${WM_NATIVE_PARENT_FIXTURE-absent}" "$WM_NATIVE_CHILD_FIXTURE"',
      ];
      const isolated = await run(argv, { inheritEnv: false, env: { WM_NATIVE_CHILD_FIXTURE: "test-child" } });
      expect(isolated.code).toBe(0);
      expect(isolated.stdout).toBe("absent|test-child");
      const existing = await run(argv, { env: { WM_NATIVE_CHILD_FIXTURE: "test-child" } });
      expect(existing.stdout).toBe("owner-only-fixture|test-child");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "WM_NATIVE_PARENT_FIXTURE");
      else process.env.WM_NATIVE_PARENT_FIXTURE = previous;
    }
  });
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

  test("keeps the output written before a plain timeout", async () => {
    const r = await run(["sh", "-c", "echo partial; sleep 5"], { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBe(124);
    expect(r.stdout).toBe("partial\n");
  });

  test.skipIf(!hasProcTools)(
    "times out on a process tree quickly and leaves no orphan (requires pgrep)",
    async () => {
      const start = Date.now();
      const r = await run(["sh", "-c", `sleep ${treeSleep}; echo done`], { timeoutMs: 200 });
      const elapsed = Date.now() - start;
      expect(r.timedOut).toBe(true);
      expect(r.code).toBe(124);
      expect(elapsed).toBeLessThan(1000);
      // The whole group was killed: the grandchild sleep must be gone, not merely detached.
      expect(stillRunning(`sleep ${treeSleep}`)).toBe(false);
    },
  );

  test.skipIf(!hasPerl || !hasProcTools)(
    "bounds the wait with the grace when an escaped grandchild holds the pipes, keeping partial output (requires perl, pgrep and pkill)",
    async () => {
      const start = Date.now();
      try {
        // The perl child starts a new session (escapes the process group) while INHERITING stdout/stderr,
        // so it survives the group kill and keeps both pipes open; the leader also sleeps.
        const r = await run(
          [
            "sh",
            "-c",
            `echo partial-out; echo partial-err 1>&2; perl -e 'use POSIX; POSIX::setsid(); exec "sleep", "${escapeSleep}"' & sleep ${escapeSleep}`,
          ],
          { timeoutMs: 200 },
        );
        const elapsed = Date.now() - start;
        expect(r.timedOut).toBe(true);
        expect(r.code).toBe(124);
        expect(r.stdout).toContain("partial-out");
        expect(r.stderr).toContain("partial-err");
        // The grace (2 s after the kill), not the escapee's sleep, must bound the call.
        expect(elapsed).toBeGreaterThanOrEqual(1900);
        expect(elapsed).toBeLessThanOrEqual(3500);
      } finally {
        Bun.spawnSync(["pkill", "-f", `sleep ${escapeSleep}`]);
      }
    },
    10_000,
  );

  test("without a timeout, waits for EOF so a backgrounded late writer is captured", async () => {
    const r = await run(["sh", "-c", "(sleep 0.5; echo late) & echo early"]);
    expect(r.stdout).toBe("early\nlate\n");
    expect(r.code).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  test("normal exit returns stdout and code", async () => {
    const r = await run(["sh", "-c", "printf test; exit 0"]);
    expect(r.stdout).toBe("test");
    expect(r.code).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.truncated).toBe(false);
  });

  test("C25: output past the 8 MiB capture cap is reported as truncated (stdout or stderr); the text kept is a prefix", async () => {
    const nine = 9 * 1024 * 1024;
    const out = await run(["sh", "-c", `head -c ${nine} /dev/zero`]);
    expect(out.code).toBe(0);
    expect(out.truncated).toBe(true);
    expect(out.stdout.length).toBeGreaterThanOrEqual(8 * 1024 * 1024);
    expect(out.stdout.length).toBeLessThan(nine);
    const err = await run(["sh", "-c", `head -c ${nine} /dev/zero >&2`]);
    expect(err.truncated).toBe(true);
    const exact = await run(["sh", "-c", `head -c ${8 * 1024 * 1024 - 1} /dev/zero`]);
    expect(exact.truncated).toBe(false);
    expect(exact.stdout.length).toBe(8 * 1024 * 1024 - 1);
  });

  test("F4: the owner's personal Linear key, exported in the dispatcher's shell, never reaches a child process; the rest of the environment does", async () => {
    const saved = { key: process.env[TOKEN_ENV], other: process.env.WM_EXEC_TEST };
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    process.env[TOKEN_ENV] = "lin_api_exec_test";
    process.env.WM_EXEC_TEST = "passed-on";
    try {
      expect(WITHHELD_ENV).toContain(TOKEN_ENV);
      const r = await run(["sh", "-c", `printf '%s|%s' "\${${TOKEN_ENV}-absent}" "$WM_EXEC_TEST"`]);
      expect(r.stdout).toBe("absent|passed-on");
      // an explicit value still arrives as given (the agent environment passes it blank)
      const blank = await run(["sh", "-c", `printf '[%s]' "\${${TOKEN_ENV}-absent}"`], {
        env: { [TOKEN_ENV]: "" },
      });
      expect(blank.stdout).toBe("[]");
      expect(childEnv()[TOKEN_ENV]).toBeUndefined();
      expect(childEnv({ A: "b" })).toMatchObject({ A: "b", WM_EXEC_TEST: "passed-on" });
    } finally {
      restore(TOKEN_ENV, saved.key);
      restore("WM_EXEC_TEST", saved.other);
    }
  });
});
