// src/server/index.ts — Native Bun HTTP server for the Wingmate Console dashboard and API.
import { watch } from "node:fs";
import { loadConfig } from "../config/load";
import type { Config } from "../config/schema";
import { LinearClient } from "../linear/client";
import type { LinearPort } from "../ports";
import { WingmateError } from "../shared/errors";
import { type Dirs, homeDirs } from "../shared/paths";
import { type Clock, SystemClock } from "../shared/time";
import { handleAnswerQuestion, handleOpenTarget, handlePromoteIssue, handleTogglePause } from "./actions";
import { renderDashboardHtml } from "./html";
import { buildSnapshot } from "./snapshot";
import type { Timeframe } from "./types";

export * from "./types";
export * from "./snapshot";
export * from "./actions";
export * from "./html";

export interface ServerOptions {
  port?: number;
  hostname?: string;
  dirs?: Dirs;
  cfg?: Config;
  clock?: Clock;
  linearClient?: LinearPort | null;
}

export interface WingmateServer {
  port: number;
  url: string;
  stop: () => void;
}

export async function startServer(options: ServerOptions = {}): Promise<WingmateServer> {
  const port = options.port ?? 4848;
  const hostname = options.hostname ?? "127.0.0.1";
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

  // Active SSE client streams
  const sseClients = new Set<(msg: string) => void>();

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

  const server = Bun.serve({
    port,
    hostname,
    idleTimeout: 30,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // 1. Health check
      if (path === "/healthz") {
        return new Response(JSON.stringify({ ok: true, version: "0.1.0" }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // 2. Dashboard HTML SPA
      if (path === "/" || path === "/index.html") {
        return new Response(renderDashboardHtml(), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // 3. API Snapshot
      if (path === "/api/snapshot" && req.method === "GET") {
        const timeframe = (url.searchParams.get("timeframe") as Timeframe) || "7d";
        const project = url.searchParams.get("project") || undefined;
        try {
          const snap = await buildSnapshot(dirs, cfg, clock, linearClient, {
            timeframe,
            project,
          });
          return new Response(JSON.stringify(snap, null, 2), {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return new Response(JSON.stringify({ error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      // 4. Server-Sent Events (SSE) Stream
      if (path === "/api/events") {
        let timer: ReturnType<typeof setInterval> | null = null;
        let clientSend: ((msg: string) => void) | null = null;

        const body = new ReadableStream({
          start(controller) {
            clientSend = (data: string) => {
              try {
                controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
              } catch {
                if (clientSend) sseClients.delete(clientSend);
              }
            };
            sseClients.add(clientSend);

            // Initial connected message
            clientSend(JSON.stringify({ type: "connected", at: clock.now() }));

            // 10s heartbeat keep-alive
            timer = setInterval(() => {
              if (clientSend) {
                clientSend(JSON.stringify({ type: "heartbeat", at: clock.now() }));
              }
            }, 10000);
          },
          cancel() {
            if (timer) clearInterval(timer);
            if (clientSend) sseClients.delete(clientSend);
          },
        });

        return new Response(body, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      // 5. Actions API
      if (path.startsWith("/api/actions/") && req.method === "POST") {
        try {
          const action = path.replace("/api/actions/", "");
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

          const broadcastUpdate = () => {
            const payload = JSON.stringify({ type: "records_updated", at: clock.now().toISOString() });
            for (const send of sseClients) send(payload);
          };

          if (action === "promote") {
            const linearId = String(body.linearId || "");
            const providerLabel = String(body.providerLabel || "agent-ready");
            const result = await handlePromoteIssue(linearClient, cfg, linearId, providerLabel);
            broadcastUpdate();
            return new Response(JSON.stringify(result), {
              headers: { "Content-Type": "application/json" },
            });
          }

          if (action === "answer") {
            const identifier = String(body.identifier || "");
            const questionId = String(body.questionId || "");
            const answerText = String(body.answerText || "");
            const result = await handleAnswerQuestion(
              dirs,
              identifier,
              questionId,
              answerText,
              linearClient,
              clock,
            );
            broadcastUpdate();
            return new Response(JSON.stringify(result), {
              headers: { "Content-Type": "application/json" },
            });
          }

          if (action === "pause") {
            const scope = String(body.scope || "global");
            const on = Boolean(body.on ?? true);
            const result = await handleTogglePause(dirs, scope, on);
            broadcastUpdate();
            return new Response(JSON.stringify(result), {
              headers: { "Content-Type": "application/json" },
            });
          }

          if (action === "open") {
            const target = (body.target as "orca" | "browser") || "browser";
            const targetPath = String(body.path || "");
            const result = await handleOpenTarget(target, targetPath);
            return new Response(JSON.stringify(result), {
              headers: { "Content-Type": "application/json" },
            });
          }

          return new Response(JSON.stringify({ error: "Unknown action" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        } catch (err) {
          const answerUnavailable = err instanceof WingmateError && err.code === "console_answer_unavailable";
          const status = answerUnavailable ? 503 : err instanceof WingmateError ? 400 : 500;
          const msg = err instanceof Error ? err.message : String(err);
          return new Response(
            JSON.stringify({
              ok: false,
              error: msg,
              ...(answerUnavailable ? { code: "console_answer_unavailable" } : {}),
            }),
            {
              status,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  const url = `http://${hostname}:${server.port}`;

  return {
    port: server.port ?? port,
    url,
    stop: () => {
      watcher?.close();
      server.stop(true);
    },
  };
}
