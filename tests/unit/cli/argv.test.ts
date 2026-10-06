import { describe, expect, test } from "bun:test";
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
});
