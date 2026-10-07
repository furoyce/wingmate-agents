// tests/unit/cli/wire.test.ts — Task 13 (§11.1): the token a live context reads Linear with. The OAuth app's credentials.json wins for
// every context; without it a read-only context (scan, tick --dry-run) reads with the owner's personal key, the commands Task 12 built
// with `linearOptional` (install, stop, doctor) keep running without any Linear credentials, and every other context (tick) refuses
// `linear_app_required`. Temp homes only; `fetch` is a fake, so nothing reaches Linear.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tickCommand } from "../../../src/cli/commands/tick";
import { parseArgv } from "../../../src/cli/index";
import { type RealCtxOptions, buildRealCtx, linearTokens } from "../../../src/cli/wire";
import { type Credentials, TokenStore, writeCredentials } from "../../../src/linear/auth";
import { EnvToken } from "../../../src/linear/envToken";
import { homeDirs } from "../../../src/shared/paths";
import { SystemClock } from "../../../src/shared/time";

const KEY = "lin_api_wire_test"; // a fake key, short enough to stay clear of the secret scanner's entropy rule
const GRAPHQL = "https://api.linear.app/graphql";
/** The one read a build makes (team metadata), answered empty. */
const TEAM_META = {
  data: { teams: { nodes: [{ states: { nodes: [] }, labels: { nodes: [] } }] }, issueLabels: { nodes: [] } },
};
const clock = new SystemClock();
let root: string;
let dirs: ReturnType<typeof homeDirs>;

/** A fresh temp home for each test (never the real one). */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wm-wire-"));
  dirs = homeDirs({
    WINGMATE_HOME: join(root, "state"),
    WINGMATE_CONFIG_HOME: join(root, "config"),
    HOME: root,
  });
});

const credentialsFile = () => join(dirs.config, "credentials.json");
function personalKeyFile(): void {
  mkdirSync(dirs.config, { recursive: true, mode: 0o700 });
  const f = join(dirs.config, "linear-token");
  writeFileSync(f, "lin_api_from_file\n", { mode: 0o600 });
  chmodSync(f, 0o600);
}
/** The app's credentials with a cached token valid for 30 days, so nothing is minted. */
const appCredentials = (accessToken = "app-token-cached"): Promise<void> => {
  const token: Credentials["token"] = {
    accessToken,
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  };
  return writeCredentials(dirs, { clientId: "cid", clientSecret: "csecret", token });
};

describe("linearTokens (§11.1, Task 13)", () => {
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("credentials.json present: the app's TokenStore for every context, the personal key ignored", async () => {
    await appCredentials();
    personalKeyFile();
    const shapes: RealCtxOptions[] = [
      { readOnly: true },
      { readOnly: false },
      { readOnly: false, linearOptional: true },
    ];
    for (const o of shapes) {
      const t = await linearTokens(o, dirs, clock, { WINGMATE_LINEAR_TOKEN: KEY });
      expect(t).toBeInstanceOf(TokenStore);
      expect(await t.getToken()).toBe("app-token-cached");
    }
  });

  test("a credentials.json that does not parse is still the app's: never a fallback to the personal key", async () => {
    mkdirSync(dirs.config, { recursive: true });
    writeFileSync(credentialsFile(), "{ not json", { mode: 0o600 });
    const t = await linearTokens({ readOnly: true }, dirs, clock, { WINGMATE_LINEAR_TOKEN: KEY });
    expect(t).toBeInstanceOf(TokenStore);
    await expect(t.getToken()).rejects.toMatchObject({ code: "linear_credentials_invalid" });
  });

  test("absent, read-only (scan, tick --dry-run): EnvToken — $WINGMATE_LINEAR_TOKEN, else <config>/linear-token; credentials.json is never created", async () => {
    const fromEnv = await linearTokens({ readOnly: true }, dirs, clock, { WINGMATE_LINEAR_TOKEN: KEY });
    expect(fromEnv).toBeInstanceOf(EnvToken);
    expect(await fromEnv.getToken()).toBe(KEY);
    personalKeyFile();
    const fromFile = await linearTokens({ readOnly: true }, dirs, clock, {});
    expect(await fromFile.getToken()).toBe("lin_api_from_file");
    expect(existsSync(credentialsFile())).toBe(false);
  });

  test("absent, linearOptional (install, stop, doctor): the TokenStore as Task 12 built it — the personal key is never used there", async () => {
    personalKeyFile();
    const t = await linearTokens({ readOnly: false, linearOptional: true }, dirs, clock, {
      WINGMATE_LINEAR_TOKEN: KEY,
    });
    expect(t).toBeInstanceOf(TokenStore);
    await expect(t.getToken()).rejects.toMatchObject({ code: "linear_credentials_missing" });
  });

  test("absent, any other context (tick, tick --precheck): linear_app_required pointing at the setup guide, even with a personal key at hand", async () => {
    personalKeyFile();
    const e = await linearTokens({ readOnly: false }, dirs, clock, { WINGMATE_LINEAR_TOKEN: KEY }).then(
      () => null,
      (x: unknown) => x as { code?: string; message?: string; nextStep?: string },
    );
    expect(e?.code).toBe("linear_app_required");
    expect(e?.nextStep).toContain("docs/linear-app-setup.md");
    expect(e?.message).not.toContain(KEY);
  });
});

interface Call {
  url: string;
  auth: string | null;
}

/**
 * `buildRealCtx` reads the process environment (homeDirs, the token variable) and the global `fetch`: both point at this test's temp
 * home and a fake for `fn`, then are restored. `token` undefined removes the variable.
 */
async function live<T>(token: string | undefined, fn: (calls: Call[]) => Promise<T>): Promise<T> {
  const env: Record<string, string | undefined> = {
    WINGMATE_HOME: dirs.state,
    WINGMATE_CONFIG_HOME: dirs.config,
    HOME: root,
    HOMEBREW_PREFIX: "/opt/homebrew", // no `brew --prefix` subprocess for the toolchain paths
    WINGMATE_LINEAR_TOKEN: token,
  };
  const set = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  const saved = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
  const savedFetch = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify(TEAM_META), { status: 200 });
  }) as unknown as typeof fetch;
  for (const [k, v] of Object.entries(env)) set(k, v);
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = savedFetch;
    for (const [k, v] of saved) set(k, v);
  }
}

// A built context opens its pino log file under the temp home asynchronously, so these homes are kept, as the fake world keeps its
// own: removing one right after a build would race that open.
describe("buildRealCtx credential rules (Task 13)", () => {
  test("read-only without credentials.json: every Linear read carries the personal key (bare, F6: never as Bearer), and the context still refuses every write", async () => {
    await live(KEY, async (calls) => {
      const ctx = await buildRealCtx({ readOnly: true });
      expect(calls).toEqual([{ url: GRAPHQL, auth: KEY }]);
      expect(ctx.tokens).toBeInstanceOf(EnvToken);
      expect(ctx.linearDown).toBeNull();
      await expect(ctx.linear.createComment("issue-1", "hello", { id: "c1" })).rejects.toMatchObject({
        code: "read_only",
      });
      expect(calls).toHaveLength(1);
      expect(existsSync(credentialsFile())).toBe(false);
    });
  });

  test("with credentials.json, even a read-only context reads as the app: the personal key is ignored", async () => {
    await appCredentials("app-token-cached");
    await live(KEY, async (calls) => {
      const ctx = await buildRealCtx({ readOnly: true });
      expect(calls).toEqual([{ url: GRAPHQL, auth: "Bearer app-token-cached" }]);
      expect(ctx.tokens).toBeInstanceOf(TokenStore);
    });
  });

  test("read-only with no credentials at all: linear_credentials_missing from the personal-key path, before any request", async () => {
    await live(undefined, async (calls) => {
      await expect(buildRealCtx({ readOnly: true })).rejects.toMatchObject({
        code: "linear_credentials_missing",
        nextStep: expect.stringContaining("docs/linear-app-setup.md"),
      });
      expect(calls).toEqual([]);
    });
  });

  test("a writing context without credentials.json (tick) refuses linear_app_required before any request; `tick --precheck` prints only the code", async () => {
    personalKeyFile();
    await live(KEY, async (calls) => {
      await expect(buildRealCtx({ readOnly: false })).rejects.toMatchObject({ code: "linear_app_required" });
      const lines: string[] = [];
      const code = await tickCommand(parseArgv(["tick", "--precheck"]), {
        out: (l) => {
          lines.push(l);
        },
      });
      expect(code).toBe(2);
      expect(lines).toEqual(['{"outcome":"error","reason":"linear_app_required"}']);
      expect(calls).toEqual([]);
    });
  });

  test("install, stop and doctor (linearOptional) still build without any Linear credentials, as in Task 12: no request, linearDown names the code", async () => {
    await live(KEY, async (calls) => {
      const ctx = await buildRealCtx({ readOnly: false, linearOptional: true });
      expect(ctx.tokens).toBeInstanceOf(TokenStore);
      expect(ctx.linearDown).toBe("linear_credentials_missing");
      expect(ctx.meta.labels).toEqual([]);
      expect(calls).toEqual([]);
    });
  });
});
