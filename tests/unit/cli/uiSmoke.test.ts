import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RecipeSchema,
  missingVerb,
  profileArgv,
  requiredVerbs,
  stepArgv,
  tabCreateArgv,
  uiSmoke,
  viewportArgv,
} from "../../../src/cli/commands/issue/uiSmoke";
import { OrcaError } from "../../../src/orca/cli";

/** The pinned verbs as `orca agent-context --json` (Orca 1.4.220) lists them, minus the global flags. */
const CONTEXT = {
  schemaVersion: 1,
  commands: [
    { command: "browser identity get", flags: ["page"] },
    { command: "find", flags: ["locator", "value", "action", "text", "worktree", "page"] },
    { command: "goto", flags: ["url", "worktree", "page"] },
    { command: "screenshot", flags: ["format", "worktree", "page"] },
    { command: "tab close", flags: ["index", "worktree", "page"] },
    { command: "tab create", flags: ["url", "worktree", "profile"] },
    { command: "tab profile create", flags: ["label", "scope"] },
    { command: "tab profile delete", flags: ["profile"] },
    { command: "viewport", flags: ["width", "height", "scale", "mobile", "worktree", "page"] },
    {
      command: "wait",
      flags: ["selector", "timeout", "text", "url", "load", "fn", "state", "worktree", "page"],
    },
  ],
};
const without = (command: string) => ({ commands: CONTEXT.commands.filter((c) => c.command !== command) });
const capture = () => {
  const lines: unknown[] = [];
  const out = (o: unknown) => {
    lines.push(o);
  };
  const refuse = (code: string, message: string, nextStep?: string) => {
    lines.push({ ok: false, code, message, nextStep: nextStep ?? null });
    return 2;
  };
  return { lines, out, refuse };
};
const worktree = (recipe: unknown) => {
  const wt = mkdtempSync(join(tmpdir(), "wm-ui-"));
  mkdirSync(join(wt, ".wingmate"), { recursive: true });
  writeFileSync(join(wt, ".wingmate", "recipe.json"), JSON.stringify(recipe));
  return wt;
};
const clean = { identity: { state: "missing", appliedMode: "clean", configuredMode: "clean" } };

describe("ui-smoke", () => {
  test("recipe parsing: defaults, loopback-only URLs, strict steps", () => {
    expect(RecipeSchema.parse({ url: "http://localhost:5173/" })).toEqual({
      url: "http://localhost:5173/",
      viewports: [],
      steps: [],
    });
    expect(
      RecipeSchema.parse({ url: "http://127.0.0.1:3000/x", steps: [{ goto: "http://[::1]:3000/" }] }).steps,
    ).toEqual([{ goto: "http://[::1]:3000/" }]);
    for (const bad of [
      { url: "nope" },
      { url: "https://example.com/" },
      { url: "file:///etc/passwd" },
      { url: "http://localhost/", steps: [{ hover: "#x" }] },
      { url: "http://localhost/", steps: [{ goto: "http://localhost/", click: "#x" }] },
      { url: "http://localhost/", steps: [{ goto: "https://evil.test/?q=1" }] },
      { url: "http://localhost/", viewports: [[0, 800]] },
      { url: "http://localhost/", step: [] },
    ])
      expect(() => RecipeSchema.parse(bad)).toThrow();
  });

  test("argv construction pinned from orca agent-context (Orca 1.4.220)", () => {
    expect(profileArgv("JRF-404")).toEqual([
      "tab",
      "profile",
      "create",
      "--label",
      "wingmate-JRF-404",
      "--scope",
      "isolated",
    ]);
    expect(tabCreateArgv("http://localhost:5173/", "p1")).toEqual([
      "tab",
      "create",
      "--url",
      "http://localhost:5173/",
      "--profile",
      "p1",
    ]);
    expect(viewportArgv(390, 844)).toEqual(["viewport", "--width", "390", "--height", "844"]);
    expect(stepArgv({ goto: "http://localhost/b" })).toEqual({
      name: "goto",
      argv: ["goto", "--url", "http://localhost/b"],
    });
    expect(stepArgv({ click: "#go" })).toEqual({
      name: "click",
      argv: ["find", "--locator", "first", "--value", "#go", "--action", "click"],
    });
    expect(stepArgv({ expectText: "Welcome" })).toEqual({
      name: "expectText",
      argv: ["wait", "--text", "Welcome", "--timeout", "10000"],
    });
    const full = RecipeSchema.parse({
      url: "http://localhost/",
      viewports: [[1280, 800]],
      steps: [{ goto: "http://localhost/a" }, { click: "#a" }, { expectText: "A" }],
    });
    expect(missingVerb(CONTEXT, requiredVerbs(full))).toBeNull();
    expect(missingVerb(without("viewport"), requiredVerbs(full))).toBe("viewport");
    expect(
      missingVerb(without("viewport"), requiredVerbs(RecipeSchema.parse({ url: "http://localhost/" }))),
    ).toBeNull();
    const noScope = {
      commands: CONTEXT.commands.map((c) =>
        c.command === "tab profile create" ? { ...c, flags: ["label"] } : c,
      ),
    };
    expect(missingVerb(noScope, requiredVerbs(full))).toBe("tab profile create --scope");
    expect(missingVerb({ version: 2 }, requiredVerbs(full))).toBe("agent-context (unexpected schema)");
  });

  test("drives every viewport through the injected runner, screenshots each step, records failures, cleans up", async () => {
    const wt = worktree({
      url: "http://localhost:5173/",
      viewports: [
        [1280, 800],
        [390, 844],
      ],
      steps: [{ goto: "http://localhost:5173/x" }, { click: "#go" }, { expectText: "Missing" }],
    });
    const png = join(wt, "shot.png");
    writeFileSync(png, "PNGDATA");
    const calls: string[][] = [];
    const exec = async (args: string[]): Promise<unknown> => {
      calls.push(args);
      if (args[0] === "browser") return clean;
      if (args[0] === "tab" && args[1] === "profile" && args[2] === "create")
        return { profile: { id: "p1" } };
      if (args[0] === "tab" && args[1] === "create") return { tab: { browserPageId: "pg1", index: 0 } };
      if (args[0] === "screenshot") return { path: png };
      if (args[0] === "wait") throw new OrcaError("browser_timeout", "text not found");
      return {};
    };
    const c = capture();
    expect(
      await uiSmoke(wt, "JRF-404", ".wingmate/recipe.json", c.out, c.refuse, exec, async () => CONTEXT),
    ).toBe(0);
    const res = c.lines[0] as {
      ok: boolean;
      evidenceDir: string;
      index: string;
      screenshots: string[];
      failures: { viewport: string; step: number; name: string; error: string }[];
      verdictHint: string;
    };
    expect(res.ok).toBe(true);
    expect(res.evidenceDir).toMatch(/^\.wingmate\/evidence\/ui\/[0-9A-Z]{26}$/);
    expect(res.failures).toEqual([
      { viewport: "1280x800", step: 3, name: "expectText", error: "text not found" },
      { viewport: "390x844", step: 3, name: "expectText", error: "text not found" },
    ]);
    expect(res.verdictHint).toBe("FAIL");
    expect(res.screenshots.length).toBe(8);
    for (const s of res.screenshots) {
      expect(s.startsWith(`${res.evidenceDir}/`)).toBe(true);
      expect(existsSync(join(wt, s))).toBe(true);
    }
    expect(existsSync(join(wt, res.index))).toBe(true);
    const shot = ["screenshot", "--format", "png", "--page", "pg1"];
    const pass = [
      shot,
      ["goto", "--url", "http://localhost:5173/x", "--page", "pg1"],
      shot,
      ["find", "--locator", "first", "--value", "#go", "--action", "click", "--page", "pg1"],
      shot,
      ["wait", "--text", "Missing", "--timeout", "10000", "--page", "pg1"],
      shot,
    ];
    expect(calls).toEqual([
      ["browser", "identity", "get"],
      ["tab", "profile", "create", "--label", "wingmate-JRF-404", "--scope", "isolated"],
      ["tab", "create", "--url", "http://localhost:5173/", "--profile", "p1"],
      ["viewport", "--width", "1280", "--height", "800", "--page", "pg1"],
      ...pass,
      ["viewport", "--width", "390", "--height", "844", "--page", "pg1"],
      ["goto", "--url", "http://localhost:5173/", "--page", "pg1"],
      ...pass,
      ["tab", "close", "--page", "pg1"],
      ["tab", "profile", "delete", "--profile", "p1"],
    ]);
  });

  test("refuses an invalid recipe, an unavailable verb (naming it), an unclean identity, and a failed setup", async () => {
    const bad = worktree({ url: "http://localhost/", steps: [{ hover: "#x" }] });
    const c = capture();
    const never = async (args: string[]): Promise<unknown> => {
      throw new Error(`unexpected orca ${args.join(" ")}`);
    };
    expect(
      await uiSmoke(bad, "JRF-404", ".wingmate/recipe.json", c.out, c.refuse, never, async () => CONTEXT),
    ).toBe(2);
    expect(c.lines[0]).toMatchObject({ ok: false, code: "ui_smoke_recipe_invalid" });

    const wt = worktree({ url: "http://localhost/", viewports: [[390, 844]] });
    const c2 = capture();
    expect(
      await uiSmoke(wt, "JRF-404", ".wingmate/recipe.json", c2.out, c2.refuse, never, async () =>
        without("viewport"),
      ),
    ).toBe(2);
    expect(c2.lines[0]).toMatchObject({ ok: false, code: "ui_smoke_unavailable" });
    expect((c2.lines[0] as { message: string }).message).toContain("orca viewport");

    const c3 = capture();
    const gone = async () => {
      throw new OrcaError("orca_unreachable", "exit 1");
    };
    expect(await uiSmoke(wt, "JRF-404", ".wingmate/recipe.json", c3.out, c3.refuse, never, gone)).toBe(2);
    expect((c3.lines[0] as { message: string }).message).toContain("orca agent-context");

    const c4 = capture();
    const native = async (args: string[]): Promise<unknown> => {
      if (args[0] === "browser") return { identity: { appliedMode: "native" } };
      throw new Error(`unexpected orca ${args.join(" ")}`);
    };
    expect(
      await uiSmoke(wt, "JRF-404", ".wingmate/recipe.json", c4.out, c4.refuse, native, async () => CONTEXT),
    ).toBe(2);
    expect(c4.lines[0]).toMatchObject({ code: "ui_smoke_unavailable" });
    expect((c4.lines[0] as { message: string }).message).toContain("native");

    const c5 = capture();
    const calls: string[][] = [];
    const broken = async (args: string[]): Promise<unknown> => {
      calls.push(args);
      if (args[0] === "browser") return clean;
      if (args[1] === "profile" && args[2] === "create") return { id: "p9" };
      if (args[0] === "tab" && args[1] === "create")
        throw new OrcaError("browser_host_unavailable", "desktop asleep");
      return {};
    };
    expect(
      await uiSmoke(wt, "JRF-404", ".wingmate/recipe.json", c5.out, c5.refuse, broken, async () => CONTEXT),
    ).toBe(2);
    expect(c5.lines[0]).toMatchObject({ code: "ui_smoke_failed" });
    expect(calls.at(-1)).toEqual(["tab", "profile", "delete", "--profile", "p9"]);
    expect(calls.some((c) => c[0] === "tab" && c[1] === "close")).toBe(false); // nothing was opened to close
  });
});
