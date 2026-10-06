import { describe, expect, test } from "bun:test";
import { OrcaError, orca } from "../../../src/orca/cli";

const bin = `${import.meta.dir}/../../fakes/orcaBin.sh`;

describe("orca()", () => {
  test("returns result for an ok envelope", async () => {
    const r = (await orca(["status"], { bin })) as { app: { running: boolean } };
    expect(r.app.running).toBe(true);
  });
  test("throws OrcaError with the error code for ok=false", async () => {
    await expect(orca(["orchestration", "task-list"], { bin })).rejects.toBeInstanceOf(OrcaError);
    await expect(orca(["orchestration", "task-list"], { bin })).rejects.toMatchObject({
      code: "run_required",
    });
  });
  test("throws orca_unreachable on a non-JSON failure", async () => {
    await expect(orca(["explode"], { bin })).rejects.toMatchObject({ code: "orca_unreachable" });
  });
  test("throws orca_timeout when the command hangs", async () => {
    const started = Date.now();
    await expect(orca(["hang"], { bin, timeoutMs: 200 })).rejects.toMatchObject({ code: "orca_timeout" });
    expect(Date.now() - started).toBeLessThan(3000);
  });
  test("keeps the envelope on an error so callers can inspect it", async () => {
    try {
      await orca(["orchestration", "task-list"], { bin });
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(OrcaError);
      const err = e as OrcaError;
      expect(err.message).toBe("No Run is bound.");
      expect((err.envelope as { error: { code: string } }).error.code).toBe("run_required");
    }
  });
});
