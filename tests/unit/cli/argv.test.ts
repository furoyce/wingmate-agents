import { describe, expect, test } from "bun:test";
import { configCommand } from "../../../src/cli/commands/config";
import { parseArgv } from "../../../src/cli/index";

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
