// tests/unit/linear/client.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { LinearClient } from "../../../src/linear/client";
import { GraphQL } from "../../../src/linear/graphql";

const read = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));
const tokens = {
  getToken: async () => "t",
  authorization: async () => "Bearer t",
  invalidate: async () => undefined,
};

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

const respond = (body: unknown) => new Response(JSON.stringify(body));
const page = (key: string, nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => ({
  data: { [key]: { nodes, pageInfo: { hasNextPage, endCursor } } },
});

describe("LinearClient — fix round 1", () => {
  test("issueHistory normalizes descending pages to oldest first after filtering", async () => {
    const seen: (string | null)[] = [];
    const h = (id: string, createdAt: string) => ({ ...historyNode, id, createdAt });
    const g = new GraphQL(tokens, (async (_u: string | URL | Request, init?: RequestInit) => {
      const after = JSON.parse(String(init?.body)).variables.after as string | null;
      seen.push(after);
      return respond({
        data: {
          issue: {
            history: {
              nodes: after
                ? [h("h2", "2026-10-03T00:00:00.000Z"), h("h1", "2026-10-02T00:00:00.000Z")]
                : [h("h4", "2026-10-06T00:00:00.000Z"), h("h3", "2026-10-05T00:00:00.000Z")],
              pageInfo: { hasNextPage: after === null, endCursor: after ? null : "older" },
            },
          },
        },
      });
    }) as unknown as typeof fetch);
    const out = await new LinearClient(g).issueHistory("i1", "2026-10-02T00:00:00.000Z");
    expect(seen).toEqual([null, "older"]);
    expect(out.map((e) => e.id)).toEqual(["h2", "h3", "h4"]);
  });

  test("issueHistory pages with a cursor until hasNextPage is false and filters by since", async () => {
    const seen: (string | null)[] = [];
    const h = (id: string, createdAt: string) => ({
      id,
      createdAt,
      actor: { id: "u" },
      botActor: null,
      addedLabelIds: [],
      removedLabelIds: [],
      fromStateId: null,
      toStateId: null,
    });
    const g = new GraphQL(tokens, (async (_u: string | URL | Request, init?: RequestInit) => {
      const vars = JSON.parse(String(init?.body)).variables as { after: string | null };
      seen.push(vars.after);
      const nodes = vars.after
        ? [h("h3", "2026-10-06T12:00:00.000Z")]
        : [h("h1", "2026-10-01T00:00:00.000Z"), h("h2", "2026-10-05T00:00:00.000Z")];
      return respond({
        data: {
          issue: {
            history: {
              nodes,
              pageInfo: { hasNextPage: !vars.after, endCursor: vars.after ? null : "h-cur" },
            },
          },
        },
      });
    }) as unknown as typeof fetch);
    const out = await new LinearClient(g).issueHistory("i1", "2026-10-02T00:00:00.000Z");
    expect(seen).toEqual([null, "h-cur"]);
    expect(out.map((e) => e.id)).toEqual(["h2", "h3"]);
  });
  test("missing identity fields raise linear_shape naming the query and path", async () => {
    const issueNode = JSON.parse(readFileSync("tests/fixtures/linear/graphql-issues-page.json", "utf8")).data
      .issues.nodes[0] as Record<string, unknown>;
    const { identifier: _dropped, ...noIdentifier } = issueNode;
    const cases: [string, unknown, () => Promise<unknown>][] = [
      [
        "issues",
        page("issues", [noIdentifier]),
        () => client(page("issues", [noIdentifier])).getIssues(["i-404"]),
      ],
      [
        "comments",
        null,
        () =>
          client(
            page("comments", [{ id: "c1", body: "x", createdAt: "2026-10-06T00:00:00.000Z", issue: {} }]),
          ).listComments(["i1"], "2026-01-01T00:00:00.000Z"),
      ],
      [
        "history",
        null,
        () =>
          client({
            data: {
              issue: {
                history: {
                  nodes: [{ createdAt: "2026-10-06T00:00:00.000Z" }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          }).issueHistory("i1", "2026-01-01T00:00:00.000Z"),
      ],
      [
        "teamMeta",
        null,
        () =>
          client({
            data: {
              teams: {
                nodes: [{ states: { nodes: [{ name: "Todo", type: "unstarted" }] }, labels: { nodes: [] } }],
              },
              issueLabels: { nodes: [] },
            },
          }).teamMeta("JRF"),
      ],
      [
        "commentCreate",
        null,
        () =>
          client({ data: { commentCreate: { success: true, comment: {} } } }).createComment("i1", "b", {
            id: "x",
          }),
      ],
      [
        "issueCreate",
        null,
        () =>
          client({ data: { issueCreate: { success: true, issue: { id: "n1" } } } }).createIssue({
            id: "n1",
            teamId: "t",
            projectId: null,
            parentId: "p",
            title: "t",
            description: "d",
            stateId: "s",
          }),
      ],
    ];
    for (const [name, , run] of cases) {
      const err = await run().then(
        () => null,
        (e: unknown) => e as { code: string; message: string },
      );
      expect(err?.code, name).toBe("linear_shape");
      expect(err?.message, name).toContain(name);
    }
  });
});

function client(body: unknown): LinearClient {
  return new LinearClient(new GraphQL(tokens, (async () => respond(body)) as unknown as typeof fetch));
}

const historyNode = {
  id: "h1",
  createdAt: "2026-10-06T09:50:00.000Z",
  actor: { id: "owner" },
  botActor: null,
  addedLabelIds: [],
  removedLabelIds: [],
  fromStateId: "started",
  toStateId: "done",
};
const historyPage = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => ({
  data: { issue: { history: { nodes, pageInfo: { hasNextPage, endCursor } } } },
});

describe("AUTH-1: complete history evidence", () => {
  for (const key of ["actor", "botActor", "addedLabelIds", "removedLabelIds", "fromStateId", "toStateId"]) {
    test(`omitted ${key} is not normalized into authorizing evidence`, async () => {
      const partial: Record<string, unknown> = { ...historyNode };
      delete partial[key];
      await expect(client(historyPage([partial])).issueHistory("i1", "1970-01-01")).rejects.toMatchObject({
        code: "linear_shape",
        message: expect.stringContaining(key),
      });
    });
  }

  test("an explicitly null bot still maps to a human; unknown bot type retains the bot identity", async () => {
    const out = await client(
      historyPage([historyNode, { ...historyNode, id: "h2", botActor: { id: "integration" } }]),
    ).issueHistory("i1", "1970-01-01");
    expect(out[0]).toMatchObject({ actorId: "owner", botActorId: null, botActorType: null });
    expect(out[1]).toMatchObject({ actorId: "owner", botActorId: "integration", botActorType: null });
  });

  for (const cursor of [null, "", "repeated"]) {
    test(`incomplete pagination (${JSON.stringify(cursor)}) never returns partial history`, async () => {
      await expect(
        client(historyPage([historyNode], true, cursor)).issueHistory("i1", "1970-01-01"),
      ).rejects.toMatchObject({ code: "linear_shape", message: expect.stringContaining("cursor") });
    });
  }

  for (const failure of ["partial data with errors", "transport failure", "missing bot metadata"]) {
    test(`a later-page ${failure} discards the earlier human entry`, async () => {
      let calls = 0;
      const g = new GraphQL(
        tokens,
        (async () => {
          if (++calls === 1) return respond(historyPage([historyNode], true, "next"));
          if (failure === "transport failure") throw new Error("offline");
          if (failure === "missing bot metadata") {
            const { botActor: _bot, ...partial } = historyNode;
            return respond(historyPage([partial]));
          }
          return respond({ ...historyPage([historyNode]), errors: [{ message: "history unavailable" }] });
        }) as unknown as typeof fetch,
        { maxRetries: 0 },
      );
      await expect(new LinearClient(g).issueHistory("i1", "1970-01-01")).rejects.toMatchObject({
        code:
          failure === "transport failure"
            ? "linear_unreachable"
            : failure === "missing bot metadata"
              ? "linear_shape"
              : "linear_graphql",
      });
      expect(calls).toBe(2);
    });
  }
});

describe("LinearClient — Task 12", () => {
  test("issueByIdentifier filters by team key and number, and returns null for a malformed or unknown identifier", async () => {
    const seen: Record<string, unknown>[] = [];
    const g = new GraphQL(tokens, (async (_u: string | URL | Request, init?: RequestInit) => {
      const vars = JSON.parse(String(init?.body)).variables as {
        filter: Record<string, unknown>;
        after: string | null;
      };
      if (vars.after) return respond(page("issues", [])); // the fixture page says hasNextPage: true
      seen.push(vars.filter);
      return respond(read("tests/fixtures/linear/graphql-issues-page.json"));
    }) as unknown as typeof fetch);
    const c = new LinearClient(g);
    expect((await c.issueByIdentifier("JRF-404"))?.identifier).toBe("JRF-404");
    expect(seen[0]).toEqual({ team: { key: { eq: "JRF" } }, number: { eq: 404 } });
    expect(await c.issueByIdentifier("JRF-999")).toBeNull(); // the page holds no JRF-999
    expect(await c.issueByIdentifier("not an id")).toBeNull();
    expect(seen.length).toBe(2); // the malformed identifier never reached Linear
  });
});
