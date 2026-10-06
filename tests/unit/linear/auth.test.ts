// tests/unit/linear/auth.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore, writeCredentials } from "../../../src/linear/auth";
import { homeDirs } from "../../../src/shared/paths";
import { FixedClock } from "../../../src/shared/time";

let root: string;
let dirs: ReturnType<typeof homeDirs>;
const clock = new FixedClock(new Date("2026-10-06T10:00:00Z"));

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "wm-auth-"));
  dirs = homeDirs({ WINGMATE_HOME: root, WINGMATE_CONFIG_HOME: root, HOME: root });
  await writeCredentials(dirs, { clientId: "cid", clientSecret: "sec" });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const fakeFetch = (calls: string[]) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url));
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_id")).toBe("cid");
    return new Response(
      JSON.stringify({
        access_token: `tok-${calls.length}`,
        token_type: "Bearer",
        expires_in: 2592000,
        scope: "read,write",
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

describe("TokenStore", () => {
  test("mints once and caches with expiry", async () => {
    const calls: string[] = [];
    const ts = new TokenStore(dirs, clock, fakeFetch(calls));
    expect(await ts.getToken()).toBe("tok-1");
    expect(await ts.getToken()).toBe("tok-1");
    expect(calls.length).toBe(1);
    const saved = JSON.parse(await Bun.file(join(root, "credentials.json")).text());
    expect(saved.token.expiresAt).toBe("2026-11-05T10:00:00.000Z");
  });
  test("re-mints when fewer than 24h remain or after invalidate()", async () => {
    const calls: string[] = [];
    const ts = new TokenStore(dirs, clock, fakeFetch(calls));
    await ts.getToken();
    clock.advance(29 * 24 * 3600 * 1000 + 3600 * 1000);
    expect(await ts.getToken()).toBe("tok-2");
    await ts.invalidate();
    expect(await ts.getToken()).toBe("tok-3");
  });
  test("credentials file is 0600", async () => {
    expect(statSync(join(root, "credentials.json")).mode & 0o777).toBe(0o600);
  });
});

describe("TokenStore — fix round 1", () => {
  test("a corrupt credentials.json is linear_credentials_invalid, not a raw parse error", async () => {
    await Bun.write(join(root, "credentials.json"), "{ not json");
    const ts = new TokenStore(dirs, clock, fakeFetch([]));
    await expect(ts.getToken()).rejects.toMatchObject({ code: "linear_credentials_invalid" });
    await Bun.write(join(root, "credentials.json"), JSON.stringify({ clientId: "", clientSecret: "s" }));
    await expect(ts.getToken()).rejects.toMatchObject({ code: "linear_credentials_invalid" });
  });
  test("a malformed token response is linear_token_mint_failed", async () => {
    const ts = new TokenStore(
      dirs,
      clock,
      (async () =>
        new Response(JSON.stringify({ token_type: "Bearer" }), { status: 200 })) as unknown as typeof fetch,
    );
    await expect(ts.getToken()).rejects.toMatchObject({ code: "linear_token_mint_failed" });
  });
  test("a hung token endpoint times out as linear_token_mint_failed", async () => {
    const ts = new TokenStore(
      dirs,
      clock,
      (async () => new Promise<Response>(() => undefined)) as unknown as typeof fetch,
      {
        timeoutMs: 50,
      },
    );
    const started = Date.now();
    await expect(ts.getToken()).rejects.toMatchObject({ code: "linear_token_mint_failed" });
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
