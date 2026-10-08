// tests/unit/server/server.test.ts — Unit tests for the Wingmate Console HTTP server endpoints.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type WingmateServer, startServer } from "../../../src/server";
import { type World, world } from "../../sim/harness";

describe("server endpoints", () => {
  let w: World;
  let server: WingmateServer;

  beforeAll(async () => {
    w = await world();
    server = await startServer({
      port: 4899,
      dirs: w.dirs,
      cfg: w.cfg,
      clock: w.clock,
      linearClient: w.linear,
    });
  });

  afterAll(() => {
    server?.stop();
  });

  test("GET /healthz returns status ok", async () => {
    const res = await fetch(`${server.url}/healthz`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  test("GET / serves the dashboard HTML SPA", async () => {
    const res = await fetch(`${server.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Wingmate");
    expect(html).toContain("Architect Console");
    expect(html).toContain("Lifecycle Pipeline Funnel");
  });

  test("GET /api/snapshot returns valid snapshot payload", async () => {
    const res = await fetch(`${server.url}/api/snapshot?timeframe=7d`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.funnel).toBeDefined();
    expect(data.activeWorktrees).toBeDefined();
    expect(data.projects).toBeDefined();
    expect(data.metrics).toBeDefined();
  });

  test("POST /api/actions/pause toggles dispatcher pause state", async () => {
    const res = await fetch(`${server.url}/api/actions/pause`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "global", on: true }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.data.pausedScopes).toContain("global");
  });
});
