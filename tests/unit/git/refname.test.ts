// tests/unit/git/refname.test.ts — the only branch names Wingmate pushes to or names on a command line (§13.3 d, h)
import { describe, expect, test } from "bun:test";
import { isBranchName, qualifiedBase } from "../../../src/git/refname";

describe("isBranchName (git check-ref-format --branch)", () => {
  test("ordinary branch names pass", () => {
    for (const n of [
      "main",
      "furoyce/wm-jrf-601",
      "wm-jrf-601-api",
      "feature/a.b",
      "release/1.2.3",
      "user@host",
    ])
      expect({ n, ok: isBranchName(n) }).toEqual({ n, ok: true });
  });
  test("names git refuses, and names that would read as an option or a refspec, fail", () => {
    const bad = [
      "",
      "-x",
      "--upload-pack=x",
      "+main",
      "a:b",
      "a..b",
      "a b",
      "a~1",
      "a^",
      "a?",
      "a*",
      "a[b",
      "a\\b",
      "/a",
      "a/",
      "a//b",
      "a.",
      ".a",
      "a/.b",
      "a.lock",
      "a.lock/b",
      "a@{1}",
      "@",
      "HEAD",
      "a\tb",
      "a\u007fb",
    ];
    for (const n of bad) expect({ n, ok: isBranchName(n) }).toEqual({ n, ok: false });
  });
});

describe("qualifiedBase (F7)", () => {
  test("the configured base names exactly one ref: origin/<b> is refs/remotes/origin/<b>, a full ref stays, a bare name is a local branch", () => {
    expect(qualifiedBase("origin/main")).toBe("refs/remotes/origin/main");
    expect(qualifiedBase("upstream/release/1.2")).toBe("refs/remotes/upstream/release/1.2");
    expect(qualifiedBase("refs/heads/main")).toBe("refs/heads/main");
    expect(qualifiedBase("main")).toBe("refs/heads/main");
  });
});
