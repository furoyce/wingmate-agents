// tests/unit/config/load.test.ts
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../../src/config/load";
describe("loadConfig", () => {
  test("loads the committed pilot config with four projects", async () => {
    const cfg = await loadConfig("config/projects.yaml");
    expect(Object.keys(cfg.projects).sort()).toEqual([
      "bouncr",
      "jr-learning-plus",
      "jr-travel-atlas",
      "smart-dispatcher",
    ]);
    expect(cfg.projects.bouncr?.routing.default).toBe("api");
    expect(cfg.projects["smart-dispatcher"]?.repos.main?.requiredCheck).toBe("Smoke (typecheck + lint)");
  });
});
