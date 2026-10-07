// tests/unit/linear/graphql.test.ts
import { describe, expect, test } from "bun:test";
import { GraphQL } from "../../../src/linear/graphql";

const tokens = {
  getToken: async () => "t",
  authorization: async () => "Bearer t",
  invalidate: async () => undefined,
};

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
  test("F6: the Authorization header is exactly what the token source gives — a personal API key goes bare, never as Bearer", async () => {
    const seen: (string | null)[] = [];
    const g = new GraphQL(
      { getToken: async () => "k", authorization: async () => "k-bare", invalidate: async () => undefined },
      (async (_u: string | URL | Request, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get("authorization"));
        return new Response(JSON.stringify({ data: { ok: true } }));
      }) as unknown as typeof fetch,
    );
    await g.query("q", {});
    expect(seen).toEqual(["k-bare"]);
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
        authorization: async () => "Bearer t",
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

describe("GraphQL — fix round 1", () => {
  test("a hung request is bounded by timeoutMs, retried like a 5xx, then fails with linear_timeout", async () => {
    let n = 0;
    const g = new GraphQL(
      tokens,
      (async (_u: string | URL | Request, init?: RequestInit) => {
        n++;
        // Never resolves unless the signal aborts (a well-behaved fetch rejects on abort).
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }) as unknown as typeof fetch,
      { baseDelayMs: 1, maxRetries: 1, timeoutMs: 50 },
    );
    const started = Date.now();
    await expect(g.query("q", {})).rejects.toMatchObject({ code: "linear_timeout" });
    expect(n).toBe(2);
    expect(Date.now() - started).toBeLessThan(1500);
  });
  test("a fetch that ignores the abort signal is still bounded", async () => {
    const g = new GraphQL(
      tokens,
      (async () => new Promise<Response>(() => undefined)) as unknown as typeof fetch,
      { baseDelayMs: 1, maxRetries: 0, timeoutMs: 50 },
    );
    await expect(g.query("q", {})).rejects.toMatchObject({ code: "linear_timeout" });
  });
  test("a non-JSON body and a non-envelope body are errors with context, never data", async () => {
    const bad = new GraphQL(tokens, (async () => new Response("<html>")) as unknown as typeof fetch);
    await expect(bad.query("q", {})).rejects.toMatchObject({ code: "linear_graphql" });
    const shape = new GraphQL(
      tokens,
      (async () => new Response(JSON.stringify({ errors: "nope" }))) as unknown as typeof fetch,
    );
    await expect(shape.query("q", {})).rejects.toMatchObject({ code: "linear_shape" });
  });
});

describe("REL-5: Retry-After is honored only within 30 s and what is left of the tick", () => {
  /** A fetch that answers `first` once, then data; `n` counts the requests. */
  function once(first: Response) {
    const seen = { n: 0 };
    const f = (async () => {
      seen.n++;
      return seen.n === 1 ? first : new Response(JSON.stringify({ data: { ok: true } }));
    }) as unknown as typeof fetch;
    return { f, seen };
  }
  const rate = (status: number, retryAfter: string | null) =>
    new Response("rate", { status, headers: retryAfter === null ? {} : { "Retry-After": retryAfter } });

  test("a Retry-After within 30 s and the tick's time is waited, then the request retried", async () => {
    const slept: number[] = [];
    const { f, seen } = once(rate(429, "20"));
    const g = new GraphQL(tokens, f, {
      maxRetries: 1,
      remainingMs: () => 60_000,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(await g.query<{ ok: boolean }>("q", {})).toEqual({ ok: true });
    expect(slept).toEqual([20_000]);
    expect(seen.n).toBe(2);
  });

  test("a Retry-After over 30 s fails the request linear_rate_limited at once, never slept (the next tick retries)", async () => {
    const slept: number[] = [];
    const { f, seen } = once(rate(429, "31"));
    const g = new GraphQL(tokens, f, {
      maxRetries: 1,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    const started = Date.now();
    await expect(g.query("q", {})).rejects.toMatchObject({ code: "linear_rate_limited" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(slept).toEqual([]);
    expect(seen.n).toBe(1);
  });

  test("a Retry-After over what is left of the tick fails linear_rate_limited too, 5xx included; a backoff without one is cut to the tick's time", async () => {
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
    };
    const short = once(rate(429, "3"));
    const g = new GraphQL(tokens, short.f, { maxRetries: 1, remainingMs: () => 2_000, sleep });
    await expect(g.query("q", {})).rejects.toMatchObject({ code: "linear_rate_limited" });
    const busy = once(rate(503, "3"));
    const g5 = new GraphQL(tokens, busy.f, { maxRetries: 1, remainingMs: () => 2_000, sleep });
    await expect(g5.query("q", {})).rejects.toMatchObject({ code: "linear_rate_limited" });
    expect(slept).toEqual([]);
    const plain = once(rate(503, null));
    const gb = new GraphQL(tokens, plain.f, {
      maxRetries: 1,
      baseDelayMs: 500,
      remainingMs: () => 120,
      sleep,
    });
    expect(await gb.query<{ ok: boolean }>("q", {})).toEqual({ ok: true });
    expect(slept).toEqual([120]);
  });
});
