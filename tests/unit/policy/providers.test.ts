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
  test("missing default → null (model_unresolved); tiers.yaml override wins", async () => {
    const home = mkdtempSync(join(tmpdir(), "wm-home2-"));
    expect(await resolveTier("claude", { home })).toBeNull();
    expect(await resolveTier("codex", { home })).toBeNull();
    expect(
      await resolveTier("claude", { home, override: { best: { claude: { model: "x", effort: "max" } } } }),
    ).toEqual({
      model: "x",
      effort: "max",
    });
  });
  test("a settings file without a model string resolves to null", async () => {
    const home = mkdtempSync(join(tmpdir(), "wm-home4-"));
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: 42 }));
    expect(await resolveTier("claude", { home })).toBeNull();
  });
  test("cascade skips tried and unavailable providers", () => {
    expect(nextInCascade(["claude", "codex"], ["claude"], () => true)).toBe("codex");
    expect(nextInCascade(["claude", "codex"], ["claude"], (p) => p !== "codex")).toBeNull();
    expect(nextInCascade(["claude", "codex"], [], () => true)).toBe("claude");
  });
});
