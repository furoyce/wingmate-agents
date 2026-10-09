import { describe, expect, test } from "bun:test";
import { defaultLauncher } from "../../../src/server/actions";

describe("Console opener uses the scrubbed bounded runner", () => {
  test("the personal Linear token cannot reach a harmless child", async () => {
    const saved = process.env.WINGMATE_LINEAR_TOKEN;
    process.env.WINGMATE_LINEAR_TOKEN = "lin_api_console_fixture";
    try {
      const result = await defaultLauncher("/bin/sh", ["-c", 'test "${WINGMATE_LINEAR_TOKEN+x}" != x']);
      expect(result).toEqual({ code: 0, error: null });
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, "WINGMATE_LINEAR_TOKEN");
      else process.env.WINGMATE_LINEAR_TOKEN = saved;
    }
  });

  test("missing and nonzero executables produce truthful failures", async () => {
    expect(await defaultLauncher(`/nonexistent-console-opener-${process.pid}`, [])).toMatchObject({
      code: null,
      missing: true,
    });
    expect(await defaultLauncher("/bin/sh", ["-c", "exit 3"])).toEqual({ code: 3, error: "exit 3" });
  });

  test("a harmless stub ignoring SIGTERM is killed and reports bounded failure", async () => {
    const start = performance.now();
    const result = await defaultLauncher("/bin/sh", ["-c", "trap '' TERM; sleep 30"]);
    expect(result).toEqual({ code: 124, error: "timed out" });
    expect(performance.now() - start).toBeLessThan(14_000);
  }, 15_000);
});
