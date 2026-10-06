// tests/unit/linear/client.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { LinearClient } from "../../../src/linear/client";
import { GraphQL } from "../../../src/linear/graphql";

const read = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));
const tokens = { getToken: async () => "t", invalidate: async () => undefined };

describe("LinearClient", () => {
  test("listCandidates pages until hasNextPage is false and maps DTOs", async () => {
    const pages = [
      read("tests/fixtures/linear/graphql-issues-page.json"),
      { data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
    ];
    const g = new GraphQL(tokens, (async (_u: string | URL | Request, init?: RequestInit) => {
      const vars = JSON.parse(String(init?.body)).variables as { after: string | null };
      if (vars.after) return new Response(JSON.stringify(pages[1]));
      return new Response(JSON.stringify(pages[0]));
    }) as unknown as typeof fetch);
    const c = new LinearClient(g);
    const issues = await c.listCandidates(
      ["0ca67822-6416-447b-b7b2-08ab2a7346dd"],
      ["agent-ready", "claude", "codex"],
    );
    expect(issues.length).toBe(2);
    expect(issues[0]?.identifier).toBe("JRF-404");
    expect(issues[0]?.labels.map((l) => l.name)).toContain("agent-ready");
    expect(issues[0]?.prerequisites).toEqual([]);
    expect(issues[1]?.children[0]?.stateType).toBe("completed");
  });
  test("listComments maps bot and external actors", async () => {
    const g = new GraphQL(
      tokens,
      (async () =>
        new Response(
          JSON.stringify(read("tests/fixtures/linear/graphql-comments.json")),
        )) as unknown as typeof fetch,
    );
    const cs = await new LinearClient(g).listComments(["i1"], "2026-10-01T00:00:00.000Z");
    expect(cs.find((c) => c.id === "c-app")?.botActorId).toBe("app-1");
    expect(cs.find((c) => c.id === "c-human")?.userId).toBe("71aef180-1742-4a76-8d49-51f14e8ada1e");
  });
  test("updateIssue sends only provided fields", async () => {
    let seen: Record<string, unknown> = {};
    const g = new GraphQL(tokens, (async (_u: string | URL | Request, init?: RequestInit) => {
      seen = JSON.parse(String(init?.body)).variables as Record<string, unknown>;
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }));
    }) as unknown as typeof fetch);
    await new LinearClient(g).updateIssue("i1", { labelIds: ["l1"] });
    expect(seen).toEqual({ id: "i1", input: { labelIds: ["l1"] } });
  });
});
