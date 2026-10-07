import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../../../src/shared/logger";

describe("logger", () => {
  const testDir = `/tmp/wingmate-logger-test-${Date.now()}`;

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("redacts secrets at top level", () => {
    const log = logger(testDir, true);
    log.info({ token: "secret123", secret: "secret456", message: "test" });
    const content = readFileSync(join(testDir, "wingmate.log"), "utf8");
    expect(content).not.toContain("secret123");
    expect(content).not.toContain("secret456");
    expect(content).toContain("[redacted]");
  });

  test("redacts secrets one level deep", () => {
    const log = logger(testDir, true);
    log.info({ cfg: { token: "secret789", accessToken: "secret012" }, message: "test" });
    const content = readFileSync(join(testDir, "wingmate.log"), "utf8");
    expect(content).not.toContain("secret789");
    expect(content).not.toContain("secret012");
    expect(content).toContain("[redacted]");
  });

  test("redacts secrets two levels deep", () => {
    const log = logger(testDir, true);
    log.info({ cfg: { linear: { token: "secret345", clientSecret: "secret678" } }, message: "test" });
    const content = readFileSync(join(testDir, "wingmate.log"), "utf8");
    expect(content).not.toContain("secret345");
    expect(content).not.toContain("secret678");
    expect(content).toContain("[redacted]");
  });

  test("redacts webhook secret nested", () => {
    const log = logger(testDir, true);
    log.info({ webhook: { secret: "webhook-secret-key", token: "webhook-token-key" }, message: "test" });
    const content = readFileSync(join(testDir, "wingmate.log"), "utf8");
    expect(content).not.toContain("webhook-secret-key");
    expect(content).not.toContain("webhook-token-key");
    expect(content).toContain("[redacted]");
  });

  test("preserves non-secret values", () => {
    const log = logger(testDir, true);
    log.info({ user: "alice", message: "test data", count: 42 });
    const content = readFileSync(join(testDir, "wingmate.log"), "utf8");
    expect(content).toContain("alice");
    expect(content).toContain("test data");
    expect(content).toContain("42");
  });
});
