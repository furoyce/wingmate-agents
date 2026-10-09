// src/server/boundary.ts — Local request boundary for the Console: loopback Host/Origin allowlist, browser session, CSRF and
// strict JSON. Loopback binding alone is not authentication: every data read and action needs a server-issued session cookie,
// and every action also needs that session's CSRF token, which only a page served by this origin can read.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Clock } from "../shared/time";

export const CSRF_HEADER = "x-wingmate-csrf";
export const MAX_JSON_BYTES = 16 * 1024;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 64;

export interface ConsoleSession {
  readonly id: string;
  readonly csrf: string;
  readonly createdAt: number;
  lastSeenAt: number;
}

export type Refusal = { readonly status: number; readonly code: string; readonly error: string };

/** The bind address must be loopback; anything else would expose the Console beyond this machine. */
export function assertLoopbackHostname(hostname: string): void {
  if (!LOOPBACK_HOSTNAMES.has(hostname))
    throw new Error(`Console only binds to loopback (127.0.0.1, localhost or ::1), not "${hostname}"`);
}

const token = () => randomBytes(32).toString("base64url");

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class ConsoleBoundary {
  private readonly sessions = new Map<string, ConsoleSession>();
  private readonly hosts: ReadonlySet<string>;
  readonly cookieName: string;

  constructor(
    hostname: string,
    readonly port: number,
    private readonly clock: Clock,
    private readonly idleMs = SESSION_IDLE_MS,
  ) {
    assertLoopbackHostname(hostname);
    const bound = hostname === "::1" ? `[::1]:${port}` : `127.0.0.1:${port}`;
    this.hosts = new Set([bound, `localhost:${port}`]);
    // Cookies are not port-isolated, so a per-port name keeps two Consoles (or a stale tab) from colliding.
    this.cookieName = `wingmate_console_${port}`;
  }

  /** Host must name this listener (defeats DNS rebinding); the expected Origin is derived from it. */
  checkHost(req: Request): Refusal | null {
    const host = req.headers.get("host")?.toLowerCase() ?? "";
    return this.hosts.has(host)
      ? null
      : refusal(421, "console_host_refused", "Request Host is not this Console");
  }

  private origin(req: Request): string {
    return `http://${req.headers.get("host")?.toLowerCase() ?? ""}`;
  }

  /**
   * Origin, when present, must be exactly this origin (`null` and other loopback ports are refused). `requireOrigin` is set for
   * actions: browsers always send Origin on POST, so a missing one is a non-browser or stripped request and fails closed.
   * Sec-Fetch-Site, when present, must be same-origin.
   */
  checkOrigin(req: Request, requireOrigin: boolean): Refusal | null {
    const origin = req.headers.get("origin");
    if (origin === null ? requireOrigin : origin !== this.origin(req))
      return refusal(403, "console_origin_refused", "Cross-origin requests are not accepted");
    const site = req.headers.get("sec-fetch-site");
    if (site !== null && site !== "same-origin")
      return refusal(403, "console_origin_refused", "Cross-site requests are not accepted");
    return null;
  }

  /** The dashboard document itself: refuse frames/embeds (clickjacking) and foreign Origins; top-level navigations bootstrap. */
  checkDocument(req: Request): Refusal | null {
    const dest = req.headers.get("sec-fetch-dest");
    if (dest !== null && dest !== "document")
      return refusal(403, "console_embed_refused", "The Console must be opened as a top-level page");
    const origin = req.headers.get("origin");
    if (origin !== null && origin !== this.origin(req))
      return refusal(403, "console_origin_refused", "Cross-origin requests are not accepted");
    return null;
  }

  /** Reuses the request's live session or issues a fresh one; never adopts a caller-chosen id. */
  bootstrap(req: Request): { session: ConsoleSession; setCookie: string } {
    const session = this.session(req) ?? this.issue();
    return { session, setCookie: this.cookie(session.id) };
  }

  private issue(): ConsoleSession {
    this.prune();
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0];
      if (!oldest) break;
      this.sessions.delete(oldest.id);
    }
    const now = this.clock.now().getTime();
    const session: ConsoleSession = { id: token(), csrf: token(), createdAt: now, lastSeenAt: now };
    this.sessions.set(session.id, session);
    return session;
  }

  private cookie(id: string): string {
    const maxAge = Math.floor(this.idleMs / 1000);
    return `${this.cookieName}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
  }

  private prune(): void {
    const now = this.clock.now().getTime();
    for (const [id, s] of this.sessions) if (now - s.lastSeenAt > this.idleMs) this.sessions.delete(id);
  }

  /** The live session named by the request cookie, sliding its idle expiry; null if absent, unknown or expired. */
  session(req: Request): ConsoleSession | null {
    // Another loopback port can plant a same-named cookie (cookies span ports). Only server-issued ids are ever looked up, and
    // exactly one live match is required, so a planted value can deny service but never select or fixate a session.
    const live = readCookies(req.headers.get("cookie"), this.cookieName)
      .map((id) => this.live(id))
      .filter((v): v is ConsoleSession => v !== null);
    const s = live.length === 1 ? live[0] : undefined;
    if (!s) return null;
    s.lastSeenAt = this.clock.now().getTime();
    return s;
  }

  /** The session if it still exists and has not idled out (no sliding); expired sessions are dropped. */
  live(id: string): ConsoleSession | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    if (this.clock.now().getTime() - s.lastSeenAt > this.idleMs) {
      this.sessions.delete(id);
      return null;
    }
    return s;
  }

  /** Revokes every session (server stop). */
  revokeAll(): void {
    this.sessions.clear();
  }

  /**
   * Data reads: Host, Origin when present, browser provenance (an exact Origin or `Sec-Fetch-Site: same-origin`, so a no-cors
   * subresource load from a sibling loopback port is refused), and a live session. `csrf` additionally requires the session's
   * token header (the snapshot fetch); EventSource cannot send headers, so SSE relies on provenance plus the cookie.
   */
  authorizeRead(req: Request, csrf: boolean): Refusal | null {
    const refused = this.checkHost(req) ?? this.checkOrigin(req, false);
    if (refused) return refused;
    if (req.headers.get("origin") === null && req.headers.get("sec-fetch-site") !== "same-origin")
      return refusal(403, "console_origin_refused", "Console data is only served to the Console page");
    const s = this.session(req);
    if (!s) return sessionRequired();
    return csrf ? this.checkCsrf(req, s) : null;
  }

  private checkCsrf(req: Request, s: ConsoleSession): Refusal | null {
    const presented = req.headers.get(CSRF_HEADER);
    return presented && sameToken(presented, s.csrf)
      ? null
      : refusal(403, "console_csrf_invalid", "Missing or invalid CSRF token; reload the Console");
  }

  /** Actions: Host, required same Origin, live session, matching CSRF token, then a JSON content type. */
  authorizeAction(req: Request): Refusal | null {
    const refused = this.checkHost(req) ?? this.checkOrigin(req, true);
    if (refused) return refused;
    const s = this.session(req);
    if (!s) return sessionRequired();
    const bad = this.checkCsrf(req, s);
    if (bad) return bad;
    const type = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json")
      return refusal(415, "console_json_required", "Actions require Content-Type: application/json");
    return null;
  }
}

function sessionRequired(): Refusal {
  return refusal(
    401,
    "console_session_required",
    "No valid Console session; reload the Console page to start a new local session",
  );
}

export function refusal(status: number, code: string, error: string): Refusal {
  return { status, code, error };
}

/** Every non-empty value of the named cookie, in header order. */
export function readCookies(header: string | null, name: string): string[] {
  if (!header) return [];
  const values: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    const value = eq > 0 && part.slice(0, eq).trim() === name ? part.slice(eq + 1).trim() : "";
    if (value) values.push(value);
  }
  return values;
}

/** Reads at most MAX_JSON_BYTES and parses one JSON object; anything else is a typed refusal. */
export type JsonBody =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly refusal: Refusal };

export async function readJsonObject(req: Request): Promise<JsonBody> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_JSON_BYTES) return tooLarge();
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) {
        await reader.cancel().catch(() => {});
        return tooLarge();
      }
      chunks.push(value);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return { ok: false, refusal: refusal(400, "console_json_invalid", "Request body is not valid JSON") };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return { ok: false, refusal: refusal(400, "console_json_invalid", "Request body must be a JSON object") };
  return { ok: true, body: parsed as Record<string, unknown> };
}

const tooLarge = (): JsonBody => ({
  ok: false,
  refusal: refusal(413, "console_body_too_large", "Request body is too large"),
});
