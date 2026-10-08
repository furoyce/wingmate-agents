import { describe, expect, test } from "bun:test";
import { configCommand } from "../../../src/cli/commands/config";
import { main, parseArgv } from "../../../src/cli/index";

describe("help before dispatch", () => {
  test("raw --help never loads even an otherwise actionable command", async () => {
    let loads = 0;
    const output: string[] = [];
    const errors: string[] = [];
    const commands = [
      ["config", "validate"],
      ["issue", "JRF-404", "finish", "--summary-file=.wingmate/summary.md"],
      ["issue", "JRF-404", "gate", "ui", "--verdict=PASS"],
      ["issue", "JRF-404", "spawn", "--role=worker"],
      ["tick", "--precheck"],
      ["scan"],
      ["install", "--enable"],
      ["doctor", "--rotate"],
      ["stop", "--all"],
      ["pause"],
      ["resume"],
      ["status"],
    ];
    const handlers = Object.fromEntries(
      commands.map(([name]) => [
        name,
        async () => {
          loads++;
          throw new Error("help must not load a handler");
        },
      ]),
    );
    const deps = {
      handlers,
      out: (s: string) => output.push(s),
      err: (s: string) => errors.push(s),
    };
    for (const args of [
      ["--help"],
      ["--help", "tick"],
      ["tick", "--help", "--help"],
      ...commands.map((args) => [...args, "--help"]),
    ]) {
      expect(await main(args, deps)).toBe(0);
    }
    expect(loads).toBe(0);
    expect(errors).toEqual([]);
    expect(output.every((s) => s.includes("wingmate tick [--precheck] [--dry-run] [--json]"))).toBe(true);
  });

  test("valued help and unsupported terminators refuse before dispatch without echoing values", async () => {
    let loads = 0;
    const output: string[] = [];
    const errors: string[] = [];
    const deps = {
      handlers: {
        tick: async () => {
          loads++;
          throw new Error("invalid help must not load a handler");
        },
      },
      out: (s: string) => output.push(s),
      err: (s: string) => errors.push(s),
    };
    for (const args of [
      ["tick", "--help=private-value"],
      ["tick", "--help", "--help=false"],
      ["tick", "--", "--help"],
      ["tick", "--", "x"],
    ]) {
      expect(await main(args, deps)).toBe(2);
    }
    expect(loads).toBe(0);
    expect(output).toEqual([]);
    expect(errors).toHaveLength(4);
    expect(errors.join("")).not.toContain("private-value");
  });

  test("help inside a value stays data and ordinary dispatch is preserved", async () => {
    const seen: unknown[] = [];
    const handlers = {
      issue: async () => async (argv: ReturnType<typeof parseArgv>) => {
        seen.push(argv);
        return 37;
      },
    };
    for (const args of [
      ["issue", "JRF-1", "ask", "--title=--help"],
      ["issue", "JRF-1", "ask", "--text", "run --help"],
    ]) {
      expect(await main(args, { handlers })).toBe(37);
      expect(seen.at(-1)).toEqual(parseArgv(args));
    }
    expect(seen).toHaveLength(2);
  });
});

describe("parseArgv", () => {
  test("positional words, boolean flags and valued flags", () => {
    expect(parseArgv(["issue", "JRF-1", "note", "hi", "--draft", "--title", "T"])).toEqual({
      cmd: ["issue", "JRF-1", "note", "hi"],
      flags: { draft: true, title: "T" },
    });
  });
  test("--flag=value keeps everything after the first '='", () => {
    expect(parseArgv(["ask", "--text=a=b", "--url=https://x.test/?q=1&r=2"]).flags).toEqual({
      text: "a=b",
      url: "https://x.test/?q=1&r=2",
    });
  });
  test("a flag before another flag is boolean; a dash-prefixed value needs '='", () => {
    expect(parseArgv(["x", "--a", "--b", "v"]).flags).toEqual({ a: true, b: "v" });
    expect(parseArgv(["x", "--note=-1"]).flags).toEqual({ note: "-1" });
  });
  test("F16: a repeated flag accumulates its values in order instead of keeping only the last", () => {
    expect(parseArgv(["finish", "--repo", "a", "--repo", "b,c", "--repo=d", "--draft"]).flags).toEqual({
      repo: ["a", "b,c", "d"],
      draft: true,
    });
    expect(parseArgv(["x", "--repo", "a"]).flags).toEqual({ repo: "a" }); // a single value stays a string
    expect(parseArgv(["x", "--draft", "--draft"]).flags).toEqual({ draft: true });
    // a valueless occurrence of a valued flag is malformed: the flag becomes `true`, which the verbs refuse
    expect(parseArgv(["x", "--repo", "a", "--repo"]).flags).toEqual({ repo: true });
    expect(parseArgv(["x", "--repo", "--repo", "a"]).flags).toEqual({ repo: true });
  });
  test("C7: flags named like Object.prototype members are ordinary own flags (no inherited value, no prototype change)", () => {
    const { flags } = parseArgv([
      "x",
      "--constructor",
      "a",
      "--__proto__",
      "b",
      "--hasOwnProperty",
      "c",
      "--toString=d",
      "--valueOf",
    ]);
    expect(Object.keys(flags)).toEqual(["constructor", "__proto__", "hasOwnProperty", "toString", "valueOf"]);
    expect(Object.values(flags)).toEqual(["a", "b", "c", "d", true]);
    expect(Object.getPrototypeOf(flags)).toBeNull();
    // given twice, they accumulate like any other flag
    expect(Object.values(parseArgv(["x", "--constructor", "a", "--constructor", "b"]).flags)).toEqual([
      ["a", "b"],
    ]);
    expect(parseArgv(["x", "--title", "T"]).flags.constructor).toBeUndefined();
  });
});

describe("config command", () => {
  test("a repeated --file is refused before any file is read (F16, C7)", async () => {
    const err: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => {
      err.push(String(s));
      return true;
    }) as typeof process.stderr.write;
    let code: number;
    try {
      code = await configCommand(parseArgv(["config", "validate", "--file", "a.yaml", "--file", "b.yaml"]));
    } finally {
      process.stderr.write = orig;
    }
    expect(code).toBe(2);
    expect(err.join("")).toBe("usage: --file may be given only once\n");
  });
});
