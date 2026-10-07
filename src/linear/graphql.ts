// src/linear/graphql.ts — raw GraphQL over fetch: the token source's Authorization header (F6), bounded requests, 429/5xx/timeout
// backoff, one 401 refresh, Zod-validated envelope, errors with context.
import { z } from "zod";
import { WingmateError } from "../shared/errors";
import type { Tokens } from "./auth";

const GRAPHQL_URL = "https://api.linear.app/graphql";
const DEFAULT_TIMEOUT_MS = 30_000;

/** Thrown by `fetchWithTimeout` when the deadline passes; callers decide whether to retry. */
export class FetchTimeout extends Error {
  constructor(public readonly ms: number) {
    super(`request timed out after ${ms} ms`);
    this.name = "FetchTimeout";
  }
}

/**
 * `fetch` with a hard deadline: the request is aborted through an AbortController (so a real fetch releases the
 * socket) AND raced against a timer (so a fetch that ignores the signal still cannot hang the caller).
 */
export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const t = new FetchTimeout(timeoutMs);
      ac.abort(t);
      reject(t);
    }, timeoutMs);
  });
  try {
    return await Promise.race([fetchImpl(url, { ...init, signal: ac.signal }), deadline]);
  } catch (e) {
    if (e instanceof FetchTimeout || ac.signal.aborted) throw new FetchTimeout(timeoutMs);
    if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError"))
      throw new FetchTimeout(timeoutMs);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const Envelope = z
  .object({
    data: z.unknown().optional(),
    errors: z.array(z.object({ message: z.string() }).passthrough()).optional(),
  })
  .passthrough();

export interface GraphQLOptions {
  baseDelayMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
  /** REL-5: what is left of the tick's time in ms (`tick`'s deadline); absent outside a tick, where only the 30 s cap applies. */
  remainingMs?: () => number;
  /** How a retry waits (default `Bun.sleep`; tests record the waits instead). */
  sleep?: (ms: number) => Promise<void>;
}

/** REL-5: the longest one retry waits, a Retry-After included; Linear asking for longer fails the request (`linear_rate_limited`). */
const MAX_RETRY_WAIT_MS = 30_000;

/** A Retry-After in delay-seconds, as ms; null when absent, zero or not a number (the backoff applies, as before REL-5). */
function retryAfterMs(header: string | null): number | null {
  const s = Number(header ?? "");
  return Number.isFinite(s) && s > 0 ? s * 1000 : null;
}

export class GraphQL {
  constructor(
    private tokens: Tokens,
    private fetchImpl: typeof fetch = fetch,
    private opts: GraphQLOptions = {},
  ) {}

  /** REL-5: what one retry may wait — 30 s, and never past the tick's deadline when one is known. */
  private retryCapMs(): number {
    const left = this.opts.remainingMs?.() ?? Number.POSITIVE_INFINITY;
    return Math.max(0, Math.min(MAX_RETRY_WAIT_MS, left));
  }

  async query<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const max = this.opts.maxRetries ?? 4;
    const base = this.opts.baseDelayMs ?? 500;
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const sleep = this.opts.sleep ?? ((ms: number) => Bun.sleep(ms));
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      // F6: the token's source spells the header (`Bearer <token>` for the app, a personal API key bare)
      const authorization = await this.tokens.authorization();
      let res: Response;
      try {
        res = await fetchWithTimeout(
          this.fetchImpl,
          GRAPHQL_URL,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authorization },
            body: JSON.stringify({ query, variables }),
          },
          timeoutMs,
        );
      } catch (e) {
        // A timeout or a transport failure is retried like a 5xx; the last failure is reported with context.
        if (attempt < max) {
          await sleep(Math.min(base * 2 ** attempt, this.retryCapMs()));
          continue;
        }
        if (e instanceof FetchTimeout)
          throw new WingmateError(
            "linear_timeout",
            `Linear request timed out after ${timeoutMs} ms (${attempt + 1} attempts)`,
          );
        throw new WingmateError("linear_unreachable", e instanceof Error ? e.message : String(e));
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.tokens.invalidate();
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < max) {
        const asked = retryAfterMs(res.headers.get("Retry-After"));
        const cap = this.retryCapMs();
        // REL-5: a longer wait than 30 s or the tick has left is never slept through (Orca would kill the precheck mid-sleep): the
        // request fails now, the tick ends `linear_error` with its heartbeat, and the next tick retries
        if (asked !== null && asked > cap)
          throw new WingmateError(
            "linear_rate_limited",
            `Linear HTTP ${res.status} asked for a retry after ${Math.ceil(asked / 1000)} s, more than this request may wait (${Math.floor(cap / 1000)} s); the next tick retries`,
          );
        await sleep(asked ?? Math.min(base * 2 ** attempt, cap));
        continue;
      }
      if (!res.ok) throw new WingmateError("linear_http", `Linear HTTP ${res.status}`);
      let raw: unknown;
      try {
        raw = await res.json();
      } catch {
        throw new WingmateError("linear_graphql", "response body is not JSON");
      }
      const env = Envelope.safeParse(raw);
      if (!env.success) {
        const i = env.error.issues[0];
        throw new WingmateError(
          "linear_shape",
          `graphql: ${i?.path.join(".") || "(root)"} ${i?.message ?? "invalid"}`,
        );
      }
      if (env.data.errors?.length)
        throw new WingmateError("linear_graphql", env.data.errors[0]?.message ?? "GraphQL error");
      if (env.data.data === undefined) throw new WingmateError("linear_graphql", "no data");
      return env.data.data as T;
    }
  }
}
