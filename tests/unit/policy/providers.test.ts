import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextInCascade, resolveTier } from "../../../src/policy/providers";

describe("providers", () => {
  test("tier best reads the CLI defaults verbatim and applies max effort", async () => {
    const home = mkdtempSync(join(tmpdir(), "wm-home-"));
    mkdirSync(join(home, ".claude"));
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: "claude-fable-5-1[1m]" }));
    writeFileSync(
      join(home, ".codex", "config.toml"),
      'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "xhigh"\n',
    );
    expect(await resolveTier("claude", { home })).toEqual({ model: "claude-fable-5-1[1m]", effort: "max" });
    expect(await resolveTier("codex", { home })).toEqual({ model: "gpt-6.1-sol", effort: "xhigh" });
  });
  test("codex effort defaults to xhigh when the config omits it", async () => {
    const home = mkdtempSync(join(tmpdir(), "wm-home3-"));
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), '# comment\nmodel = "gpt-6.1-sol"\n');
    expect(await resolveTier("codex", { home })).toEqual({ model: "gpt-6.1-sol", effort: "xhigh" });
  });
  test("R31: Claude without a configured model runs on the CLI's own default (model null, effort max); Codex without one is model_unresolved; tiers.yaml override wins", async () => {
    const home = mkdtempSync(join(tmpdir(), "wm-home2-"));
    expect(await resolveTier("claude", { home })).toEqual({ model: null, effort: "max" }); // no settings.json at all
    expect(await resolveTier("codex", { home })).toBeNull();
    expect(
      await resolveTier("claude", { home, override: { best: { claude: { model: "x", effort: "max" } } } }),
    ).toEqual({
      model: "x",
      effort: "max",
    });
  });
  test("R31: the settings shape Claude Code writes now — per-model settings under modelSettings, no top-level model — is the CLI default; a model that is no non-empty string too", async () => {
    const home = mkdtempSync(join(tmpdir(), "wm-home4-"));
    mkdirSync(join(home, ".claude"));
    const settings = join(home, ".claude", "settings.json");
    writeFileSync(
      settings,
      JSON.stringify({
        modelSettings: { "claude-fable-5-1": { effort: "high" } },
        effortLevel: "high",
        env: {},
      }),
    );
    expect(await resolveTier("claude", { home })).toEqual({ model: null, effort: "max" });
    for (const model of [42, "", null]) {
      writeFileSync(settings, JSON.stringify({ model }));
      expect(await resolveTier("claude", { home })).toEqual({ model: null, effort: "max" });
    }
    writeFileSync(settings, JSON.stringify({ model: "claude-fable-5-1[1m]", modelSettings: {} }));
    expect(await resolveTier("claude", { home })).toEqual({ model: "claude-fable-5-1[1m]", effort: "max" });
  });
  test("R31: a settings.json that does not parse (or is no object) says nothing about the model the owner set: model_unresolved", async () => {
    const home = mkdtempSync(join(tmpdir(), "wm-home5-"));
    mkdirSync(join(home, ".claude"));
    for (const text of ["{ not json", "[]", "null", '"x"']) {
      writeFileSync(join(home, ".claude", "settings.json"), text);
      expect(await resolveTier("claude", { home })).toBeNull();
    }
  });
  test("cascade skips tried and unavailable providers", () => {
    expect(nextInCascade(["claude", "codex"], ["claude"], () => true)).toBe("codex");
    expect(nextInCascade(["claude", "codex"], ["claude"], (p) => p !== "codex")).toBeNull();
    expect(nextInCascade(["claude", "codex"], [], () => true)).toBe("claude");
  });
});
