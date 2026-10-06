import { describe, expect, test } from "bun:test";
import { depsChanged, depsPolicy } from "../../../src/policy/deps";

describe("deps", () => {
  test("detects manifests and lockfiles anywhere in the tree", () => {
    expect(
      depsChanged(["api/package.json", "pnpm-lock.yaml", "mobile/src/a.ts", "bun.lock", "requirements.txt"]),
    ).toEqual(["api/package.json", "pnpm-lock.yaml", "bun.lock", "requirements.txt"]);
    expect(
      depsChanged([
        "mobile/ios/Podfile.lock",
        "Cargo.toml",
        "pyproject.toml",
        "go.sum",
        "docs/package.json.md",
      ]),
    ).toEqual(["mobile/ios/Podfile.lock", "Cargo.toml", "pyproject.toml", "go.sum"]);
  });
  test("policy fails without allow-deps and passes with it", () => {
    expect(depsPolicy(["package.json"], false)).toEqual({
      ok: false,
      reason: "dependency_change_without_allow_deps",
    });
    expect(depsPolicy(["package.json"], true)).toEqual({ ok: true, reason: null });
    expect(depsPolicy(["src/a.ts"], false)).toEqual({ ok: true, reason: null });
  });
});
