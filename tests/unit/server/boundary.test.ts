import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Launcher, type WingmateServer, startServer } from "../../../src/server";
import { readRecord } from "../../../src/state/records";
import { type World, labeledByOwner, runTick, todo, world } from "../../sim/harness";

/** Every file under the temp world (state, records, ledger, worktrees), hashed: any unauthorized write shows up here. */
function fileTree(root: string, rel = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(join(root, rel)).sort()) {
    const path = join(rel, name);
    if (lstatSync(join(root, path)).isDirectory()) Object.assign(files, fileTree(root, path));
    else
      files[path] = createHash("sha256")
        .update(readFileSync(join(root, path)))
        .digest("hex");
  }
  return files;
}

interface Session {
  cookie: string;
  csrf: string;
}

const NAVIGATE = { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none" };

describe("Console request boundary", () => {
  let w: World;
  let server: WingmateServer;
  let base: string;
  let launches: { cmd: string; args: string[] }[];
  let launchCode = 0; // -1: executable not found
  let worktreePath: string;

  const launcher: Launcher = async (cmd, args) => {
    launches.push({ cmd, args });
    if (launchCode === -1)
      return cmd === "orca"
        ? { code: null, error: "spawn orca ENOENT", missing: true }
        : { code: 0, error: null };
    return { code: launchCode, error: launchCode === 0 ? null : "fake opener failed" };
  };

  async function bootstrap(headers: Record<string, string> = NAVIGATE): Promise<Session> {
    const res = await fetch(`${base}/`, { headers });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";")[0] ?? "";
    const csrf = (await res.text()).match(/name="wingmate-csrf" content="([^"]+)"/)?.[1] ?? "";
    expect(cookie).toMatch(/^wingmate_console_\d+=.+/);
    expect(csrf.length).toBeGreaterThan(20);
    return { cookie, csrf };
  }

  const read = (s: Session | null, path: string, extra: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      headers: {
        ...(s ? { cookie: s.cookie, "x-wingmate-csrf": s.csrf } : {}),
        "sec-fetch-site": "same-origin",
        ...extra,
      },
    });

  const post = (s: Session | null, action: string, body: string, extra: Record<string, string> = {}) =>
    fetch(`${base}/api/actions/${action}`, {
      method: "POST",
      headers: {
        ...(s ? { cookie: s.cookie, "x-wingmate-csrf": s.csrf } : {}),
        origin: base,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
        ...extra,
      },
      body,
    });

  const without = (headers: Record<string, string>, ...names: string[]) =>
    Object.fromEntries(Object.entries(headers).filter(([k]) => !names.includes(k)));

  beforeAll(async () => {
    w = await world();
    labeledByOwner(w, todo("i_open", "JRF-870"));
    await runTick(w);
    const rec = await readRecord(w.dirs, "JRF-870");
    if (!rec?.worktree) throw new Error("record worktree missing");
    worktreePath = rec.worktree.path;
    launches = [];
    server = await startServer({
      port: 0,
      dirs: w.dirs,
      cfg: w.cfg,
      clock: w.clock,
      linearClient: w.linear,
      launcher,
    });
    base = server.url;
  });

  afterAll(() => {
    server?.stop();
  });

  test("refuses to bind anywhere but loopback", async () => {
    await expect(startServer({ port: 0, hostname: "0.0.0.0", dirs: w.dirs, cfg: w.cfg })).rejects.toThrow(
      "loopback",
    );
  });

  test("top-level navigation bootstraps a session without any token in the URL", async () => {
    const res = await fetch(`${base}/`, { headers: NAVIGATE });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const html = await res.text();
    const csrf = html.match(/name="wingmate-csrf" content="([^"]+)"/)?.[1];
    expect(csrf).toBeTruthy();
    // The CSRF token is independent of the cookie value (not derivable from what other loopback ports can see).
    expect(setCookie).not.toContain(csrf ?? "none");
    // A plain request (as `orca tab create --url` or a CLI-opened browser sends) also bootstraps.
    expect((await fetch(`${base}/`)).status).toBe(200);
    expect((await fetch(`${base}/index.html`, { headers: NAVIGATE })).status).toBe(200);
  });

  test("a live session is reused; a forged cookie is never adopted", async () => {
    const s = await bootstrap();
    const again = await fetch(`${base}/`, { headers: { ...NAVIGATE, cookie: s.cookie } });
    expect(again.headers.get("set-cookie")?.split(";")[0]).toBe(s.cookie);
    const name = s.cookie.split("=")[0];
    const forged = await fetch(`${base}/`, { headers: { ...NAVIGATE, cookie: `${name}=attacker-chosen` } });
    expect(forged.headers.get("set-cookie")).not.toContain("attacker-chosen");
  });

  test("a CSRF token from another session, or a planted duplicate cookie, grants nothing", async () => {
    const a = await bootstrap();
    const b = await bootstrap();
    expect(a.cookie).not.toBe(b.cookie);
    const before = fileTree(w.root);
    const res = await post(
      { cookie: a.cookie, csrf: b.csrf },
      "pause",
      JSON.stringify({ scope: "global", on: true }),
    );
    expect(res.status).toBe(403);
    expect((await read({ cookie: a.cookie, csrf: b.csrf }, "/api/snapshot")).status).toBe(403);
    expect(fileTree(w.root)).toEqual(before);
    // A sibling port can plant a same-named cookie: it neither breaks the real session nor works on its own.
    const name = a.cookie.split("=")[0];
    expect(
      (await read({ cookie: `${name}=planted; ${a.cookie}`, csrf: a.csrf }, "/api/snapshot")).status,
    ).toBe(200);
    expect((await read({ cookie: `${name}=planted`, csrf: a.csrf }, "/api/snapshot")).status).toBe(401);
    // Two live sessions in one header are ambiguous and refused.
    expect((await read({ cookie: `${a.cookie}; ${b.cookie}`, csrf: a.csrf }, "/api/snapshot")).status).toBe(
      401,
    );
  });

  test("framed or cross-origin bootstrap is refused without issuing a session", async () => {
    for (const headers of [
      { ...NAVIGATE, "sec-fetch-dest": "iframe", "sec-fetch-site": "cross-site" },
      { ...NAVIGATE, "sec-fetch-dest": "embed" },
      { origin: "https://evil.example" },
      { origin: "http://127.0.0.1:9" },
      { origin: "null" },
    ]) {
      const res = await fetch(`${base}/`, { headers });
      expect(res.status).toBe(403);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  test("DNS-rebinding Host headers are refused on every route, with zero mutations", async () => {
    const s = await bootstrap();
    const before = fileTree(w.root);
    const port = new URL(base).port;
    for (const host of [
      `evil.example:${port}`,
      `127.0.0.1:${Number(port) + 1}`,
      "127.0.0.1",
      `0.0.0.0:${port}`,
    ]) {
      expect((await fetch(`${base}/`, { headers: { ...NAVIGATE, host } })).status).toBe(421);
      expect((await fetch(`${base}/healthz`, { headers: { host } })).status).toBe(421);
      expect((await read(s, "/api/snapshot", { host })).status).toBe(421);
      expect((await read(s, "/api/events", { host })).status).toBe(421);
      const res = await post(s, "pause", JSON.stringify({ scope: "global", on: true }), {
        host,
        origin: `http://${host}`,
      });
      expect(res.status).toBe(421);
    }
    // `localhost` is the same loopback listener and is accepted (its cookie is host-scoped by the browser).
    expect((await fetch(`${base}/healthz`, { headers: { host: `localhost:${port}` } })).status).toBe(200);
    expect(fileTree(w.root)).toEqual(before);
  });

  test("snapshot requires session, CSRF token and same-origin provenance; no wildcard CORS", async () => {
    const s = await bootstrap();
    const ok = await read(s, "/api/snapshot?timeframe=7d");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();
    expect((await ok.json()).funnel).toBeDefined();
    // Explicit same Origin is also browser provenance.
    expect((await read(s, "/api/snapshot", { origin: base, "sec-fetch-site": "same-origin" })).status).toBe(
      200,
    );

    const cases: [Session | null, Record<string, string>, number][] = [
      [null, {}, 401],
      [{ cookie: `${s.cookie.split("=")[0]}=expired-or-forged`, csrf: s.csrf }, {}, 401],
      [{ cookie: s.cookie, csrf: "wrong" }, {}, 403],
      [s, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }, 403],
      // A hostile sibling loopback port is same-site (cookies travel) but not same-origin.
      [s, { origin: "http://127.0.0.1:9999", "sec-fetch-site": "same-site" }, 403],
      [s, { origin: "null" }, 403],
      // no-cors subresource load from a sibling port: no Origin, Sec-Fetch-Site same-site
      [s, { "sec-fetch-site": "same-site" }, 403],
    ];
    for (const [session, headers, status] of cases)
      expect((await read(session, "/api/snapshot", headers)).status).toBe(status);
    // No CSRF header at all
    const noCsrf = await fetch(`${base}/api/snapshot`, {
      headers: { cookie: s.cookie, "sec-fetch-site": "same-origin" },
    });
    expect(noCsrf.status).toBe(403);
    // No browser provenance at all (neither Origin nor Sec-Fetch-Site)
    const bare = await fetch(`${base}/api/snapshot`, {
      headers: { cookie: s.cookie, "x-wingmate-csrf": s.csrf },
    });
    expect(bare.status).toBe(403);
    const unauthorized = await read(null, "/api/snapshot");
    expect(unauthorized.headers.get("access-control-allow-origin")).toBeNull();
    expect(JSON.stringify(await unauthorized.json())).not.toContain("funnel");

    expect((await read(s, "/api/snapshot?timeframe=forever")).status).toBe(400);
    expect((await read(s, "/api/snapshot?project=not-configured")).status).toBe(400);
    expect((await read(s, "/api/snapshot?project=bouncr")).status).toBe(200);
    expect((await fetch(`${base}/api/snapshot`, { method: "POST" })).status).toBe(405);
  });

  test("SSE stream requires a session and same-origin provenance; no wildcard CORS", async () => {
    const s = await bootstrap();
    expect((await read(null, "/api/events")).status).toBe(401);
    expect((await read(s, "/api/events", { origin: "https://evil.example" })).status).toBe(403);
    expect((await read(s, "/api/events", { origin: "http://localhost:9999" })).status).toBe(403);
    expect((await read(s, "/api/events", { "sec-fetch-site": "cross-site" })).status).toBe(403);
    const bare = await fetch(`${base}/api/events`, { headers: { cookie: s.cookie } });
    expect(bare.status).toBe(403);

    // EventSource cannot send headers: cookie + Sec-Fetch-Site alone are enough (no CSRF token, no URL token).
    const controller = new AbortController();
    const res = await fetch(`${base}/api/events`, {
      headers: { cookie: s.cookie, "sec-fetch-site": "same-origin", accept: "text/event-stream" },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const reader = res.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain('"type":"connected"');
    await reader?.cancel();
    controller.abort();
  });

  test("unauthorized or malformed action requests change nothing", async () => {
    const s = await bootstrap();
    const pause = JSON.stringify({ scope: "global", on: true });
    const before = fileTree(w.root);
    const linearWrites = w.linear.writes.length;
    const launchCount = launches.length;

    const valid = {
      cookie: s.cookie,
      "x-wingmate-csrf": s.csrf,
      origin: base,
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
    };
    const raw = (headers: Record<string, string>, body: string, method = "POST", action = "pause") =>
      fetch(`${base}/api/actions/${action}`, { method, headers, body });

    const cases: [string, Promise<Response>, number][] = [
      // The classic cross-site "simple request": a form/fetch POST with text/plain and no preflight.
      [
        "simple text/plain cross-site",
        raw(
          { "content-type": "text/plain", origin: "https://evil.example", "sec-fetch-site": "cross-site" },
          pause,
        ),
        403,
      ],
      ["simple text/plain, no Origin", raw({ "content-type": "text/plain" }, pause), 403],
      ["text/plain with valid session", raw({ ...valid, "content-type": "text/plain" }, pause), 415],
      [
        "form-urlencoded with valid session",
        raw({ ...valid, "content-type": "application/x-www-form-urlencoded" }, pause),
        415,
      ],
      ["foreign Origin", raw({ ...valid, origin: "https://evil.example" }, pause), 403],
      ["sibling loopback Origin", raw({ ...valid, origin: "http://127.0.0.1:9999" }, pause), 403],
      ["sibling localhost Origin", raw({ ...valid, origin: "http://localhost:9999" }, pause), 403],
      ["null Origin", raw({ ...valid, origin: "null" }, pause), 403],
      ["missing Origin", raw(without(valid, "origin"), pause), 403],
      ["same-site Sec-Fetch-Site", raw({ ...valid, "sec-fetch-site": "same-site" }, pause), 403],
      ["no session cookie", raw(without(valid, "cookie"), pause), 401],
      ["forged session cookie", raw({ ...valid, cookie: `${s.cookie.split("=")[0]}=nope` }, pause), 401],
      ["missing CSRF", raw(without(valid, "x-wingmate-csrf"), pause), 403],
      ["wrong CSRF", raw({ ...valid, "x-wingmate-csrf": `${s.csrf}x` }, pause), 403],
      ["invalid JSON", raw(valid, "{scope: global"), 400],
      ["JSON array", raw(valid, "[]"), 400],
      ["JSON null", raw(valid, "null"), 400],
      ["extra fields", raw(valid, JSON.stringify({ scope: "global", on: true, extra: 1 })), 400],
      ["wrong types", raw(valid, JSON.stringify({ scope: "global", on: "yes" })), 400],
      ["oversized body", raw(valid, JSON.stringify({ scope: "x".repeat(20_000), on: true })), 413],
      ["PUT", raw(valid, pause, "PUT"), 405],
      ["DELETE", raw(valid, pause, "DELETE"), 405],
      ["unknown action", raw(valid, pause, "POST", "shutdown"), 404],
    ];
    for (const [name, pending, status] of cases) {
      const res = await pending;
      expect({ name, status: res.status }).toEqual({ name, status });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
    const get = await fetch(`${base}/api/actions/pause`, { headers: valid });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    const preflight = await fetch(`${base}/api/actions/pause`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(preflight.status).toBe(405);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();

    // Unauthorized promote/open/answer reach no handler either.
    expect(
      (await post(null, "promote", JSON.stringify({ linearId: "i_x", providerLabel: "codex" }))).status,
    ).toBe(401);
    expect((await post(null, "open", JSON.stringify({ target: "orca", path: worktreePath }))).status).toBe(
      401,
    );
    expect(
      (await post({ cookie: s.cookie, csrf: "bad" }, "answer", JSON.stringify({ identifier: "JRF-870" })))
        .status,
    ).toBe(403);

    expect(fileTree(w.root)).toEqual(before);
    expect(existsSync(join(w.dirs.state, "pause.json"))).toBe(false);
    expect(w.linear.writes.length).toBe(linearWrites);
    expect(launches.length).toBe(launchCount);
  });

  test("an expired session is refused for reads and actions until the page is reloaded", async () => {
    const s = await bootstrap();
    expect((await read(s, "/api/snapshot")).status).toBe(200);
    w.clock.advance(13 * 60 * 60 * 1000);
    const before = fileTree(w.root);
    const snap = await read(s, "/api/snapshot");
    expect(snap.status).toBe(401);
    expect((await snap.json()).code).toBe("console_session_required");
    expect((await post(s, "pause", JSON.stringify({ scope: "global", on: true }))).status).toBe(401);
    expect(fileTree(w.root)).toEqual(before);
    // Reloading the page issues a fresh session that works.
    const fresh = await bootstrap({ ...NAVIGATE, cookie: s.cookie });
    expect(fresh.cookie).not.toBe(s.cookie);
    expect((await read(fresh, "/api/snapshot")).status).toBe(200);
  });

  test("global and project pause are independent scopes and audited", async () => {
    const s = await bootstrap();
    const call = async (scope: string, on: boolean) => {
      const res = await post(s, "pause", JSON.stringify({ scope, on }));
      expect(res.status).toBe(200);
      return (await res.json()) as {
        ok: boolean;
        status: string;
        message: string;
        data: { pausedScopes: string[] };
      };
    };
    // The core scope is "global"; the legacy "all" and unconfigured keys are refused without touching pause.json.
    for (const scope of ["all", "not-a-project", "Global"]) {
      const res = await post(s, "pause", JSON.stringify({ scope, on: true }));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("pause_scope_invalid");
    }
    expect(existsSync(join(w.dirs.state, "pause.json"))).toBe(false);
    expect((await call("global", true)).data.pausedScopes).toEqual(["global"]);
    expect((await call("bouncr", true)).data.pausedScopes).toEqual(["bouncr", "global"]);
    const resumed = await call("global", false);
    expect(resumed.status).toBe("confirmed");
    expect(resumed.data.pausedScopes).toEqual(["bouncr"]);
    expect(resumed.message).toContain("still paused: bouncr");

    const snap = await (await read(s, "/api/snapshot")).json();
    expect(snap.globalPaused).toBe(false);
    expect(snap.pausedProjects).toEqual(["bouncr"]);
    expect(snap.projects.find((p: { key: string }) => p.key === "bouncr").paused).toBe("project");
    expect(snap.projects.find((p: { key: string }) => p.key !== "bouncr").paused).toBeNull();

    expect((await call("bouncr", false)).data.pausedScopes).toEqual([]);
    const ledger = readFileSync(join(w.dirs.ledger, "global.jsonl"), "utf8");
    expect(ledger.match(/"type":"console_pause".*"outcome":"confirmed"/g)?.length).toBe(4);
    expect(ledger.match(/"type":"console_pause".*"outcome":"refused"/g)?.length).toBe(3);
  });

  test("promote is limited to configured provider labels and configured projects, confirmed by re-read", async () => {
    const s = await bootstrap();
    const promote = (linearId: string, providerLabel: string) =>
      post(s, "promote", JSON.stringify({ linearId, providerLabel }));
    const unlabeled = { labels: [] };
    w.linear.add(todo("i_promo", "JRF-871", unlabeled));
    w.linear.add(
      todo("i_foreign", "JRF-872", { ...unlabeled, projectId: "11111111-1111-4111-8111-111111111111" }),
    );
    w.linear.add(
      todo("i_conflict", "JRF-873", {
        labels: [{ id: "lb-human", name: "human", parentId: "grp-agent", parentName: "Agent" }],
      }),
    );
    w.linear.add(
      todo("i_started", "JRF-874", {
        ...unlabeled,
        state: { id: "st-prog", name: "In Progress", type: "started" },
      }),
    );
    const writes = w.linear.writes.length;

    for (const [id, label, code] of [
      ["i_promo", "gemini", "label_not_allowed"], // an Agent-group label, but configured unsupported
      ["i_promo", "allow-deps", "label_not_allowed"], // a real label outside the provider set
      ["i_promo", "Blocked", "label_not_allowed"],
      ["i_foreign", "codex", "issue_out_of_scope"],
      ["i_conflict", "codex", "conflicting_agent_label"],
      ["i_started", "codex", "issue_not_promotable"],
      ["i_missing", "codex", "issue_not_found"],
    ] as const) {
      const res = await promote(id, label);
      expect({ id, label, status: res.status, code: (await res.json()).code }).toEqual({
        id,
        label,
        status: 400,
        code,
      });
    }
    expect(
      (await post(s, "promote", JSON.stringify({ linearId: "../x", providerLabel: "codex" }))).status,
    ).toBe(400);
    expect(w.linear.writes.length).toBe(writes);

    const res = await promote("i_promo", "codex");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      status: "confirmed",
      data: { identifier: "JRF-871", project: "bouncr" },
    });
    expect(body.message).not.toContain("will claim");
    expect((await w.linear.getIssues(["i_promo"]))[0]?.labels.map((l) => l.name)).toEqual(["codex"]);
    expect(w.linear.writes.length).toBe(writes + 1);
  });

  test("open accepts only an active record's worktree and reports success only after an exit-0 launch", async () => {
    const s = await bootstrap();
    const open = (path: string, target = "orca") => post(s, "open", JSON.stringify({ target, path }));
    const count = launches.length;
    for (const [path, target] of [
      ["/tmp", "orca"],
      [w.root, "orca"],
      [`${worktreePath}/../..`, "orca"],
      ["relative/path", "orca"],
      ["https://evil.example/", "orca"],
      [worktreePath, "browser"],
      [worktreePath, "terminal"],
    ] as const) {
      const res = await open(path, target);
      expect({ path, target, status: res.status }).toEqual({ path, target, status: 400 });
    }
    expect(launches.length).toBe(count);

    launchCode = 1;
    const failed = await open(worktreePath);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ ok: false, status: "failed" });
    // No duplicate open after a failed Orca launch.
    expect(launches.slice(count).map((l) => l.cmd)).toEqual(["orca"]);

    launchCode = -1; // Orca CLI absent: the system opener is the only launcher
    const fallback = await open(worktreePath);
    expect(fallback.status).toBe(200);
    expect(await fallback.json()).toMatchObject({ ok: true, status: "launched" });
    expect(launches.slice(count + 1)).toEqual([
      { cmd: "orca", args: ["file", "open", "README.md", "--worktree", `path:${worktreePath}`, "--focus"] },
      { cmd: "open", args: [worktreePath] },
    ]);

    launchCode = 0;
    const launched = await open(worktreePath);
    expect(launched.status).toBe(200);
    expect(await launched.json()).toMatchObject({ ok: true, status: "launched" });
    expect(launches.at(-1)).toEqual({
      cmd: "orca",
      args: ["file", "open", "README.md", "--worktree", `path:${worktreePath}`, "--focus"],
    });
  });

  test("the answer endpoint stays fail-closed for an authenticated session", async () => {
    const s = await bootstrap();
    const before = fileTree(w.root);
    const res = await post(
      s,
      "answer",
      JSON.stringify({ identifier: "JRF-870", questionId: "q", answerText: "ok" }),
    );
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("console_answer_unavailable");
    expect(fileTree(w.root)).toEqual(before);
  });
});

describe("Console session and SSE lifecycle", () => {
  test("SSE ends when its session expires, the server stops, and old-instance cookies are refused", async () => {
    const w = await world();
    const start = () =>
      startServer({
        port: 0,
        dirs: w.dirs,
        cfg: w.cfg,
        clock: w.clock,
        linearClient: null,
        sseIntervalMs: 20,
      });
    let server = await start();
    const page = await fetch(`${server.url}/`);
    const cookie = page.headers.get("set-cookie")?.split(";")[0] ?? "";
    await page.text();
    const stream = async () => {
      const res = await fetch(`${server.url}/api/events`, {
        headers: { cookie, "sec-fetch-site": "same-origin" },
      });
      expect(res.status).toBe(200);
      const reader = res.body?.getReader();
      if (!reader) throw new Error("no stream");
      return reader;
    };
    const drain = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
      for (;;) if ((await reader.read()).done) return true;
    };

    const expiring = await stream();
    expect(new TextDecoder().decode((await expiring.read()).value)).toContain("connected");
    w.clock.advance(13 * 60 * 60 * 1000);
    expect(await drain(expiring)).toBe(true); // closed by the server, no late events
    expect(
      (await fetch(`${server.url}/api/events`, { headers: { cookie, "sec-fetch-site": "same-origin" } }))
        .status,
    ).toBe(401);

    const page2 = await fetch(`${server.url}/`);
    const fresh = page2.headers.get("set-cookie")?.split(";")[0] ?? "";
    await page2.text();
    const res = await fetch(`${server.url}/api/events`, {
      headers: { cookie: fresh, "sec-fetch-site": "same-origin" },
    });
    const open = res.body?.getReader();
    if (!open) throw new Error("no stream");
    await open.read();
    const port = server.port;
    server.stop();
    expect(await drain(open).catch(() => true)).toBe(true);

    // A restarted server on the same port does not honor the previous instance's cookie.
    server = await startServer({ port, dirs: w.dirs, cfg: w.cfg, clock: w.clock, linearClient: null });
    try {
      const stale = await fetch(`${server.url}/api/snapshot`, {
        headers: { cookie: fresh, "sec-fetch-site": "same-origin" },
      });
      expect(stale.status).toBe(401);
    } finally {
      server.stop();
    }
  });
});
