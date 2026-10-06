// tests/unit/linear/graphql.test.ts
import { describe, expect, test } from "bun:test";
import { GraphQL } from "../../../src/linear/graphql";

const tokens = { getToken: async () => "t", invalidate: async () => undefined };

describe("GraphQL", () => {
  test("sends bearer token and returns data", async () => {
    const g = new GraphQL(tokens, (async (_u: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer t");
      return new Response(JSON.stringify({ data: { viewer: { id: "v" } } }));
    }) as unknown as typeof fetch);
    expect(await g.query<{ viewer: { id: string } }>("query { viewer { id } }", {})).toEqual({
      viewer: { id: "v" },
    });
  });
  test("retries 429 with backoff then succeeds", async () => {
    let n = 0;
    const g = new GraphQL(
      tokens,
      (async () => {
        n++;
        return n < 3
          ? new Response("rate", { status: 429, headers: { "Retry-After": "0" } })
          : new Response(JSON.stringify({ data: { ok: true } }));
      }) as unknown as typeof fetch,
      { baseDelayMs: 1 },
    );
    expect(await g.query<{ ok: boolean }>("q", {})).toEqual({ ok: true });
    expect(n).toBe(3);
  });
  test("401 invalidates the token once and retries", async () => {
    let n = 0;
    let invalidated = 0;
    const g = new GraphQL(
      {
        getToken: async () => "t",
        invalidate: async () => {
          invalidated++;
        },
      },
      (async () => {
        n++;
        return n === 1
          ? new Response("unauth", { status: 401 })
          : new Response(JSON.stringify({ data: { ok: 1 } }));
      }) as unknown as typeof fetch,
      { baseDelayMs: 1 },
    );
    expect(await g.query<{ ok: number }>("q", {})).toEqual({ ok: 1 });
    expect(invalidated).toBe(1);
  });
  test("GraphQL errors become linear_graphql errors with the first message", async () => {
    const g = new GraphQL(
      tokens,
      (async () =>
        new Response(
          JSON.stringify({ errors: [{ message: "Argument Validation Error" }] }),
        )) as unknown as typeof fetch,
    );
    await expect(g.query("q", {})).rejects.toMatchObject({ code: "linear_graphql" });
  });
});
