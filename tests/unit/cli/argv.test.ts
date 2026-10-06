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
});
