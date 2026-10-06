// src/linear/graphql.ts — raw GraphQL over fetch: bearer token, 429/5xx backoff, one 401 refresh, errors with context.
import { WingmateError } from "../shared/errors";
import type { Tokens } from "./auth";

const GRAPHQL_URL = "https://api.linear.app/graphql";

export class GraphQL {
  constructor(
    private tokens: Tokens,
    private fetchImpl: typeof fetch = fetch,
    private opts: { baseDelayMs?: number; maxRetries?: number } = {},
  ) {}

  async query<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const max = this.opts.maxRetries ?? 4;
    const base = this.opts.baseDelayMs ?? 500;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.tokens.getToken();
      const res = await this.fetchImpl(GRAPHQL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ query, variables }),
      });
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.tokens.invalidate();
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < max) {
        const ra = Number(res.headers.get("Retry-After") ?? "0");
        await Bun.sleep(ra > 0 ? ra * 1000 : base * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new WingmateError("linear_http", `Linear HTTP ${res.status}`);
      const j = (await res.json()) as { data?: T; errors?: { message: string }[] };
      if (j.errors?.length)
        throw new WingmateError("linear_graphql", j.errors[0]?.message ?? "GraphQL error");
      if (j.data === undefined) throw new WingmateError("linear_graphql", "no data");
      return j.data;
    }
  }
}
