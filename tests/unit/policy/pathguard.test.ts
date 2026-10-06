import { describe, expect, test } from "bun:test";
import { globMatch, violations } from "../../../src/policy/pathguard";

describe("pathguard", () => {
  test("glob semantics", () => {
    expect(globMatch(".github/workflows/ci.yml", ".github/**")).toBe(true);
    expect(globMatch("apps/web/.env.local", "**/.env*")).toBe(true);
    expect(globMatch(".env", "**/.env*")).toBe(true);
    expect(globMatch("Dockerfile.prod", "Dockerfile*")).toBe(true);
    expect(globMatch("src/env.ts", "**/.env*")).toBe(false);
    expect(globMatch("CLAUDE.md", "CLAUDE.md")).toBe(true);
    expect(globMatch("docs/CLAUDE.md", "CLAUDE.md")).toBe(false);
    expect(globMatch("supabase/migrations/0001.sql", "supabase/migrations/**")).toBe(true);
    expect(globMatch("scripts/agent-fix/run.sh", "scripts/agent-*/**")).toBe(true);
    expect(globMatch("scripts/agentless/run.sh", "scripts/agent-*/**")).toBe(false);
    expect(globMatch("./.npmrc", ".npmrc")).toBe(true);
    expect(globMatch("src/a+b.ts", "src/a+b.ts")).toBe(true);
    expect(globMatch("src/axb.ts", "src/a+b.ts")).toBe(false);
  });
  test("reports every violating path with its pattern", () => {
    expect(
      violations(["src/a.ts", ".github/workflows/x.yml", "infra/main.tf"], [".github/**", "infra/**"]),
    ).toEqual([
      { path: ".github/workflows/x.yml", pattern: ".github/**" },
      { path: "infra/main.tf", pattern: "infra/**" },
    ]);
  });
  test("no patterns means no violations", () => {
    expect(violations(["anything"], [])).toEqual([]);
  });
});
