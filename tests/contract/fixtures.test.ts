// tests/contract/fixtures.test.ts — the fixtures are scrubbed captures; these tests pin the shapes the machine relies on
// and prove that nothing sensitive survives and that the scrubber is idempotent.
import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMAIL_RE, SECRET_PATTERNS, scrubDirs, truncateText } from "../../scripts/scrub-fixtures";

const read = (p: string): Record<string, unknown> =>
  JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
const result = (p: string): Record<string, unknown> => read(p).result as Record<string, unknown>;
const DIRS = ["tests/fixtures/orca", "tests/fixtures/linear"];
const files = (dir: string): string[] =>
  readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .map((n) => join(dir, n));

// Hand-authored GraphQL response fixtures (Task 6) are `{ data }` documents, not Orca envelopes.
const isGraphqlFixture = (f: string): boolean => f.split("/").pop()?.startsWith("graphql-") === true;

describe("fixtures", () => {
  test("every capture is an envelope with ok=true and a result; GraphQL fixtures carry data", () => {
    for (const dir of DIRS)
      for (const f of files(dir)) {
        const j = read(f);
        if (isGraphqlFixture(f)) {
          expect(j.data).toBeDefined();
          continue;
        }
        expect(j.ok).toBe(true);
        expect(j.result).toBeDefined();
      }
    expect(files("tests/fixtures/orca").length).toBe(11);
    expect(files("tests/fixtures/linear").length).toBe(5);
    expect(files("tests/fixtures/linear").filter(isGraphqlFixture).length).toBe(2);
  });

  test("worktree ps rows expose the fields the machine relies on", () => {
    const r = result("tests/fixtures/orca/worktree-ps.json");
    const rows = r.worktrees as Record<string, unknown>[];
    const row = rows[0];
    expect(row).toBeDefined();
    for (const k of [
      "worktreeId",
      "repoId",
      "path",
      "branch",
      "linkedLinearIssue",
      "status",
      "agents",
      "liveTerminalCount",
    ])
      expect(row).toHaveProperty(k);
    const withAgent = rows.find((w) => (w.agents as unknown[]).length > 0);
    expect(withAgent).toBeDefined();
    const agent = (withAgent?.agents as Record<string, unknown>[])[0];
    expect(agent).toHaveProperty("paneKey");
    expect(agent).toHaveProperty("state");
    expect(r.totalCount).toBe(rows.length);
  });

  test("terminal list rows expose handle, tabId, leafId, lastOutputAt, worktreeId and join agents by paneKey", () => {
    const r = result("tests/fixtures/orca/terminal-list-sample.json");
    const row = (r.terminals as Record<string, unknown>[])[0];
    expect(row).toBeDefined();
    for (const k of ["handle", "tabId", "leafId", "lastOutputAt", "worktreeId"])
      expect(row).toHaveProperty(k);
    const terms = result("tests/fixtures/orca/terminal-list-working.json").terminals as Record<
      string,
      unknown
    >[];
    const ps = result("tests/fixtures/orca/worktree-ps-working.json").worktrees as Record<string, unknown>[];
    const paneKeys = new Set(terms.map((t) => `${String(t.tabId)}:${String(t.leafId)}`));
    const agents = (ps[0]?.agents ?? []) as Record<string, unknown>[];
    expect(agents.length).toBeGreaterThan(0);
    for (const a of agents) expect(paneKeys.has(String(a.paneKey))).toBe(true);
  });

  test("linear fixtures keep the orca linear envelope shape", () => {
    const issue = result("tests/fixtures/linear/issue-JRF-402.json").issue as Record<string, unknown>;
    expect(issue.identifier).toBe("JRF-402");
    expect(issue).toHaveProperty("state");
    expect(issue).toHaveProperty("labels");
    const list = result("tests/fixtures/linear/list-issues-bouncr.json");
    const issues = list.issues as Record<string, unknown>[];
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.length).toBeLessThanOrEqual(15);
    expect((list.meta as Record<string, unknown>).returned).toBe(issues.length);
    expect(
      issues.some(
        (i) => (i.project as Record<string, unknown> | null)?.id === "0ca67822-6416-447b-b7b2-08ab2a7346dd",
      ),
    ).toBe(true);
  });

  test("no secrets, e-mail addresses, home paths or user@host values survive scrubbing", () => {
    for (const dir of DIRS)
      for (const f of files(dir)) {
        const text = readFileSync(f, "utf8");
        for (const re of SECRET_PATTERNS) expect(text).not.toMatch(new RegExp(re.source));
        const emails = text.match(EMAIL_RE) ?? [];
        expect(emails.filter((e) => !e.endsWith(".invalid"))).toEqual([]);
        expect(text).not.toMatch(/\/Users\/(?!owner\/)/);
        expect(text).not.toMatch(/jujufugh/i);
        expect(text).not.toMatch(/"nextCursor":\s*"(?!\[scrubbed\]")/);
      }
  });

  test("long free text is truncated to 80 characters plus an ellipsis", () => {
    expect(truncateText("x".repeat(80))).toBe("x".repeat(80));
    expect(truncateText("x".repeat(81))).toBe(`${"x".repeat(80)}…`);
    expect(truncateText(truncateText("x".repeat(200)))).toBe(`${"x".repeat(80)}…`);
    for (const dir of DIRS)
      for (const f of files(dir)) {
        const text = readFileSync(f, "utf8");
        for (const m of text.matchAll(
          /"(prompt|lastAssistantMessage|preview|description|body)":\s*"((?:[^"\\]|\\.)*)"/g,
        )) {
          const value = JSON.parse(`"${m[2] ?? ""}"`) as string;
          expect(value.length).toBeLessThanOrEqual(81);
        }
      }
  });

  test("the scrubber is idempotent on the committed fixtures", () => {
    const tmp = mkdtempSync(join(tmpdir(), "wm-fixtures-"));
    for (const dir of DIRS) cpSync(dir, join(tmp, dir), { recursive: true });
    const changed = scrubDirs(DIRS.map((d) => join(tmp, d)));
    expect(changed).toEqual([]);
    for (const dir of DIRS)
      for (const f of files(dir)) expect(readFileSync(join(tmp, f), "utf8")).toBe(readFileSync(f, "utf8"));
  });
});
