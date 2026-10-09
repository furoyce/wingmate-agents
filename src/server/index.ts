// src/server/index.ts — Native Bun HTTP server for the Wingmate Console dashboard and API.
import { watch } from "node:fs";
import { ZodError } from "zod";
import { loadConfig } from "../config/load";
import type { Config } from "../config/schema";
import { LinearClient } from "../linear/client";
import type { LinearPort } from "../ports";
import { WingmateError } from "../shared/errors";
import { errorCode } from "../shared/errors";
import { type Dirs, homeDirs } from "../shared/paths";
import { type Clock, SystemClock } from "../shared/time";
import {
  type ActionResponse,
  type Launcher,
  OpenBody,
  PauseBody,
  PromoteBody,
  auditConsoleAction,
  defaultLauncher,
  handleAnswerQuestion,
  handleOpenTarget,
  handlePromoteIssue,
  handleTogglePause,
} from "./actions";
import { ConsoleBoundary, type Refusal, assertLoopbackHostname, readJsonObject } from "./boundary";
import { renderDashboardHtml } from "./html";
import { buildSnapshot } from "./snapshot";
import type { Timeframe } from "./types";

export * from "./types";
export * from "./snapshot";
export * from "./actions";
export * from "./html";
export * from "./boundary";

const TIMEFRAMES: readonly Timeframe[] = ["today", "7d", "30d", "all"];
const isTimeframe = (v: string): v is Timeframe => (TIMEFRAMES as readonly string[]).includes(v);

const API_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
// The page uses inline script/style and same-origin fetches only; it must never be framed.
const DOCUMENT_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { ...API_HEADERS, ...headers } });
const refuse = (r: Refusal) => json(r.status, { ok: false, code: r.code, error: r.error });
const methodNotAllowed = (allow: string) =>
  json(405, { ok: false, code: "console_method_not_allowed", error: "Method not allowed" }, { Allow: allow });

export interface ServerOptions {
  port?: number;
  hostname?: string;
  dirs?: Dirs;
  cfg?: Config;
  clock?: Clock;
  linearClient?: LinearPort | null;
  /** Opener used by the open action; tests inject a fake so no real application is launched. */
  launcher?: Launcher;
  /** SSE keep-alive and session re-check interval (default 10 s, below the 30 s idle timeout). */
  sseIntervalMs?: number;
}

export interface WingmateServer {
  port: number;
  url: string;
  stop: () => void;
}

export async function startServer(options: ServerOptions = {}): Promise<WingmateServer> {
  const port = options.port ?? 4848;
  const hostname = options.hostname ?? "127.0.0.1";
  assertLoopbackHostname(hostname);
  const launcher = options.launcher ?? defaultLauncher;
  const dirs = options.dirs ?? homeDirs();
  const cfg = options.cfg ?? (await loadConfig());
  const clock = options.clock ?? new SystemClock();

  let linearClient: LinearPort | null = options.linearClient ?? null;
  if (linearClient === null && options.linearClient === undefined) {
    try {
      linearClient = LinearClient.fromCredentials(dirs, clock);
    } catch {
      linearClient = null;
    }
  }

  // Active SSE client streams, and how to close each one (server stop)
  const sseClients = new Set<(msg: string) => void>();
  const sseClosers = new Set<() => void>();
  const sseIntervalMs = options.sseIntervalMs ?? 10_000;

  // Watch records and state directory for real-time live events
  let watcher: ReturnType<typeof watch> | null = null;
  try {
    watcher = watch(dirs.records, { recursive: false }, () => {
      const payload = JSON.stringify({ type: "records_updated", at: clock.now().toISOString() });
      for (const send of sseClients) send(payload);
    });
  } catch {
    // Directory watch not supported on some systems; SSE interval handles it
  }

  let boundary: ConsoleBoundary | null = null;
  const broadcastUpdate = () => {
    const payload = JSON.stringify({ type: "records_updated", at: clock.now().toISOString() });
    for (const send of sseClients) send(payload);
  };

  const handleAction = async (action: string, body: Record<string, unknown>): Promise<Response> => {
    if (action === "promote") {
      const { linearId, providerLabel } = PromoteBody.parse(body);
      const result = await audited("promote", null, { linearId, providerLabel }, () =>
        handlePromoteIssue(linearClient, cfg, linearId, providerLabel),
      );
      broadcastUpdate();
      return json(result.ok ? 200 : 502, result);
    }
    if (action === "answer") {
      // Fail closed: a generic Console session must not impersonate a Linear approver.
      const refused = await handleAnswerQuestion(dirs, "", "", "", linearClient, clock);
      return json(503, { ...refused, ok: false, code: "console_answer_unavailable" });
    }
    if (action === "pause") {
      const { scope, on } = PauseBody.parse(body);
      const result = await audited("pause", null, { scope, on }, () =>
        handleTogglePause(dirs, cfg, scope, on),
      );
      broadcastUpdate();
      return json(200, result);
    }
    if (action === "open") {
      const { path } = OpenBody.parse(body);
      const result = await audited("open", null, { path }, () => handleOpenTarget(dirs, path, launcher));
      return json(result.ok ? 200 : 502, result);
    }
    return json(404, { ok: false, error: "Unknown action" });
  };

  /** Runs one permitted mutation and appends its outcome (or refusal) to the ledger before answering. */
  async function audited(
    action: string,
    issue: string | null,
    target: Record<string, unknown>,
    run: () => Promise<ActionResponse>,
  ): Promise<ActionResponse> {
    let result: ActionResponse;
    try {
      result = await run();
    } catch (err) {
      await auditConsoleAction(dirs, clock, action, issue, {
        ...target,
        outcome: "refused",
        code: errorCode(err),
      }).catch(() => {});
      throw err;
    }
    try {
      await auditConsoleAction(dirs, clock, action, issue, {
        ...target,
        outcome: result.status ?? "unknown",
      });
      return result;
    } catch {
      return { ...result, message: `${result.message} (audit record could not be written)` };
    }
  }

  const server = Bun.serve({
    port,
    hostname,
    idleTimeout: 30,
    async fetch(req) {
      const gate = boundary;
      if (!gate) return new Response("Starting", { status: 503 });
      const url = new URL(req.url);
      const path = url.pathname;
      const hostRefused = gate.checkHost(req);
      if (hostRefused) return refuse(hostRefused);

      // 1. Health check (no data)
      if (path === "/healthz") {
        if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed("GET, HEAD");
        return json(200, { ok: true, version: "0.1.0" });
      }

      // 2. Dashboard document: a top-level navigation bootstraps the browser session (cookie + embedded CSRF token).
      if (path === "/" || path === "/index.html") {
        if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed("GET, HEAD");
        const docRefused = gate.checkDocument(req);
        if (docRefused) return refuse(docRefused);
        const { session, setCookie } = gate.bootstrap(req);
        return new Response(req.method === "HEAD" ? null : renderDashboardHtml(session.csrf), {
          headers: { ...DOCUMENT_HEADERS, "Set-Cookie": setCookie },
        });
      }

      // 3. API Snapshot
      if (path === "/api/snapshot") {
        if (req.method !== "GET") return methodNotAllowed("GET");
        const refused = gate.authorizeRead(req, true);
        if (refused) return refuse(refused);
        const timeframe = url.searchParams.get("timeframe") || "7d";
        const project = url.searchParams.get("project") || undefined;
        if (!isTimeframe(timeframe)) return json(400, { ok: false, error: "Unknown timeframe" });
        if (project !== undefined && !Object.hasOwn(cfg.projects, project))
          return json(400, { ok: false, error: "Unknown project" });
        try {
          const snap = await buildSnapshot(dirs, cfg, clock, linearClient, { timeframe, project });
          return json(200, snap);
        } catch {
          return json(500, { ok: false, error: "Snapshot could not be built; see the dispatcher logs" });
        }
      }

      // 4. Server-Sent Events (SSE) Stream (same-origin EventSource carries the session cookie)
      if (path === "/api/events") {
        if (req.method !== "GET") return methodNotAllowed("GET");
        const refused = gate.authorizeRead(req, false);
        if (refused) return refuse(refused);
        const sessionId = gate.session(req)?.id ?? "";
        let timer: ReturnType<typeof setInterval> | null = null;
        let clientSend: ((msg: string) => void) | null = null;
        let dispose = () => {};
        let disposed = false;

        const body = new ReadableStream({
          start(controller) {
            dispose = () => {
              if (disposed) return;
              disposed = true;
              if (timer) clearInterval(timer);
              timer = null;
              if (clientSend) sseClients.delete(clientSend);
              sseClosers.delete(dispose);
              req.signal.removeEventListener("abort", dispose);
              try {
                controller.close();
              } catch {
                // already closed or cancelled
              }
            };
            clientSend = (data: string) => {
              // Every delivery checks the session without extending its lifetime, including broadcasts between heartbeats.
              if (disposed) return;
              if (!gate.live(sessionId)) return dispose();
              try {
                controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
              } catch {
                dispose();
              }
            };
            sseClients.add(clientSend);
            sseClosers.add(dispose);
            req.signal.addEventListener("abort", dispose, { once: true });
            if (req.signal.aborted) return dispose();

            // Initial connected message
            clientSend(JSON.stringify({ type: "connected", at: clock.now() }));
            if (disposed) return;

            // Keep-alive below the server's idle timeout; an expired or revoked session ends the stream (no late events).
            timer = setInterval(() => {
              clientSend?.(JSON.stringify({ type: "heartbeat", at: clock.now() }));
            }, sseIntervalMs);
          },
          cancel() {
            dispose();
          },
        });

        return new Response(body, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            Connection: "keep-alive",
          },
        });
      }

      // 5. Actions API: authorization and strict JSON are checked before any handler can run.
      if (path.startsWith("/api/actions/")) {
        if (req.method !== "POST") return methodNotAllowed("POST");
        const refused = gate.authorizeAction(req);
        if (refused) return refuse(refused);
        const parsed = await readJsonObject(req);
        if (!parsed.ok) return refuse(parsed.refusal);
        try {
          return await handleAction(path.slice("/api/actions/".length), parsed.body);
        } catch (err) {
          if (err instanceof ZodError)
            return json(400, {
              ok: false,
              code: "console_body_invalid",
              error: "Request body has invalid fields",
            });
          const answerUnavailable = err instanceof WingmateError && err.code === "console_answer_unavailable";
          const status = answerUnavailable ? 503 : err instanceof WingmateError ? 400 : 500;
          const msg = err instanceof WingmateError ? err.message : "Action failed; see the Console logs";
          return json(status, {
            ok: false,
            error: msg,
            ...(err instanceof WingmateError ? { code: err.code } : {}),
          });
        }
      }

      return new Response("Not Found", { status: 404 });
    },
  });
  boundary = new ConsoleBoundary(hostname, server.port ?? port, clock);

  const url = `http://${hostname === "::1" ? "[::1]" : hostname}:${server.port}`;

  return {
    port: server.port ?? port,
    url,
    stop: () => {
      watcher?.close();
      for (const close of [...sseClosers]) close();
      boundary?.revokeAll();
      server.stop(true);
    },
  };
}
