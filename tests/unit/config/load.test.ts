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
  test("C3: the pilot keeps Codex to verifier and reviewer roles (§13.3 c, D14 extension pending)", async () => {
    const cfg = await loadConfig("config/projects.yaml");
    expect(cfg.defaults.providers.coordinatorCascade).toEqual(["claude"]);
    expect(cfg.defaults.providers.workers).toEqual(["claude"]);
    expect(cfg.defaults.providers.verifyCross).toBe(true); // Codex still verifies and reviews across providers
    // the comment above `providers:` says why, so the list is not widened without the owner's decision
    const yaml = await Bun.file("config/projects.yaml").text();
    const comment = /((?:^[ \t]*#.*\n)+)[ \t]*providers:/m.exec(yaml)?.[1] ?? "";
    expect(comment).toContain("D14 extension");
    expect(comment).toContain("workers");
  });
});
