import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectCleanupProcesses } from "../../../src/machine/cleanupProcesses";
import { fakeExec } from "../../fakes/fakeExec";

test("process cleanup evidence is read-only and rejects failed, truncated, timed-out, malformed and empty scans", async () => {
  const root = await mkdtemp(join(tmpdir(), "wm-process-proof-"));
  try {
    for (const variant of [
      "complete",
      "live",
      "failed",
      "truncated",
      "timeout",
      "stderr",
      "empty",
      "malformed",
    ]) {
      const exec = fakeExec([
        {
          match: () => true,
          reply: (argv) => {
            if (argv.includes("-axww")) return { stdout: `123 ${process.getuid?.()} unrelated-command\n` };
            return {
              stdout:
                variant === "empty"
                  ? ""
                  : variant === "malformed"
                    ? "bad output"
                    : `p123\nn${variant === "live" ? root : "/unrelated"}/file\n`,
              code: variant === "failed" ? 1 : 0,
              truncated: variant === "truncated",
              timedOut: variant === "timeout",
              stderr: variant === "stderr" ? "could not stat" : "",
            };
          },
        },
      ]);
      const result = await inspectCleanupProcesses(root, exec.exec);
      expect(result.complete).toBe(["complete", "live"].includes(variant));
      expect(result.pids).toEqual(variant === "live" ? [123] : []);
      expect(exec.calls).toHaveLength(2);
      expect(exec.calls.some((call) => call.argv.includes("kill"))).toBe(false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
