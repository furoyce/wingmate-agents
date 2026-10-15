// tests/unit/config/load.test.ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, selectedConfigPath } from "../../../src/config/load";
describe("loadConfig", () => {
  test("selected config captures a canonical file from a relative selection and rejects missing/non-file/control paths", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "wm-config-source-")));
    const selected = join(dir, "selected.yaml");
    writeFileSync(selected, "synthetic config fixture");
    symlinkSync(selected, join(dir, "alias.yaml"));
    expect(await selectedConfigPath("./alias.yaml", dir)).toBe(selected);
    mkdirSync(join(dir, "directory"));
    for (const path of ["missing.yaml", "directory"])
      await expect(selectedConfigPath(path, dir)).rejects.toMatchObject({ code: "config_missing" });
    for (const path of ["", "selected.yaml\n", "selected\0.yaml", "selected\t.yaml"])
      await expect(selectedConfigPath(path, dir)).rejects.toMatchObject({ code: "config_path_invalid" });
  });
  test("loads the committed pilot config with configured projects", async () => {
    const cfg = await loadConfig("config/projects.yaml");
    expect(Object.keys(cfg.projects).sort()).toEqual([
      "bouncr",
      "jr-learning-plus",
      "jr-travel-atlas",
      "smart-dispatcher",
      "wingmate-agents",
    ]);
    expect(cfg.projects.bouncr?.routing.default).toBe("api");
    expect(cfg.projects.bouncr?.repos.api?.setup).toEqual([
      ["npm", "ci", "--prefix", "api"],
      ["npm", "ci", "--prefix", "mobile"],
    ]);
    expect(cfg.projects.bouncr?.repos.api?.gates).toContainEqual([
      "npm",
      "--prefix",
      "api",
      "run",
      "typecheck",
    ]);
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
  test("C32: agents reach the JavaScript package registries (the pilots are JavaScript repos) and no GitHub host; the comment says more hosts are the owner's call", async () => {
    const cfg = await loadConfig("config/projects.yaml");
    expect(cfg.defaults.sandbox.allowedDomains).toEqual(["registry.npmjs.org", "registry.yarnpkg.com"]);
    const every = [
      ...cfg.defaults.sandbox.allowedDomains,
      ...Object.values(cfg.projects).flatMap((p) =>
        Object.values(p.repos).flatMap((r) => r.sandbox.allowedDomains),
      ),
    ];
    for (const host of every) expect(host).not.toMatch(/github/i);
    const yaml = await Bun.file("config/projects.yaml").text();
    const comment = /((?:^[ \t]*#.*\n)+)[ \t]*sandbox:/m.exec(yaml)?.[1] ?? "";
    expect(comment).toContain("owner");
    expect(comment).toContain("GitHub");
  });
});
