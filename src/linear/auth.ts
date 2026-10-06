// src/linear/auth.ts — Linear OAuth app identity: client_credentials token minted and cached in credentials.json (0600).
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { WingmateError } from "../shared/errors";
import type { Dirs } from "../shared/paths";
import type { Clock } from "../shared/time";
import { iso } from "../shared/time";
import { readText, writeAtomic } from "../state/fs";
import { FetchTimeout, fetchWithTimeout } from "./graphql";

const Creds = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  token: z.object({ accessToken: z.string(), expiresAt: z.string() }).nullable().default(null),
});
export type Credentials = z.infer<typeof Creds>;
const TokenResponse = z
  .object({ access_token: z.string().min(1), expires_in: z.number().positive() })
  .passthrough();

const SCOPES = "read,write,comments:create,issues:create";
const TOKEN_URL = "https://api.linear.app/oauth/token";
/** Re-mint when fewer than this many milliseconds remain before expiry. */
const REFRESH_MARGIN_MS = 24 * 3600 * 1000;
const DEFAULT_MINT_TIMEOUT_MS = 20_000;

const path = (dirs: Dirs) => join(dirs.config, "credentials.json");

export async function writeCredentials(
  dirs: Dirs,
  c: { clientId: string; clientSecret: string; token?: Credentials["token"] },
): Promise<void> {
  await writeAtomic(path(dirs), JSON.stringify({ ...c, token: c.token ?? null }, null, 2), 0o600);
  await chmod(path(dirs), 0o600);
}

export async function readCredentials(dirs: Dirs): Promise<Credentials> {
  const file = path(dirs);
  const t = await readText(file);
  if (!t)
    throw new WingmateError(
      "linear_credentials_missing",
      `no ${file}`,
      "run `wingmate install` with the Linear OAuth client id/secret (docs/linear-app-setup.md)",
    );
  let raw: unknown;
  try {
    raw = JSON.parse(t);
  } catch (e) {
    throw new WingmateError(
      "linear_credentials_invalid",
      `${file}: not JSON (${e instanceof Error ? e.message : String(e)})`,
      "re-run `wingmate install` with the client id/secret",
    );
  }
  const parsed = Creds.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    throw new WingmateError(
      "linear_credentials_invalid",
      `${file}: ${i?.path.join(".") || "(root)"} ${i?.message ?? "invalid"}`,
      "re-run `wingmate install` with the client id/secret",
    );
  }
  return parsed.data;
}

export interface Tokens {
  getToken(): Promise<string>;
  invalidate(): Promise<void>;
}

export class TokenStore implements Tokens {
  constructor(
    private dirs: Dirs,
    private clock: Clock,
    private fetchImpl: typeof fetch = fetch,
    private opts: { timeoutMs?: number } = {},
  ) {}

  async getToken(): Promise<string> {
    const c = await readCredentials(this.dirs);
    const now = this.clock.now().getTime();
    if (c.token && Date.parse(c.token.expiresAt) - now > REFRESH_MARGIN_MS) return c.token.accessToken;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: c.clientId,
      client_secret: c.clientSecret,
      scope: SCOPES,
    });
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_MINT_TIMEOUT_MS;
    let res: Response;
    try {
      res = await fetchWithTimeout(
        this.fetchImpl,
        TOKEN_URL,
        { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body },
        timeoutMs,
      );
    } catch (e) {
      throw new WingmateError(
        "linear_token_mint_failed",
        e instanceof FetchTimeout
          ? `token endpoint timed out after ${timeoutMs} ms`
          : `token endpoint unreachable: ${e instanceof Error ? e.message : String(e)}`,
        "check network access to api.linear.app and retry",
      );
    }
    if (!res.ok)
      throw new WingmateError(
        "linear_token_mint_failed",
        `token endpoint returned ${res.status}`,
        "check the OAuth app client id/secret and that the app is installed in the workspace",
      );
    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      throw new WingmateError("linear_token_mint_failed", "token endpoint returned a non-JSON body");
    }
    const j = TokenResponse.safeParse(raw);
    if (!j.success) {
      const i = j.error.issues[0];
      throw new WingmateError(
        "linear_token_mint_failed",
        `token endpoint returned an unexpected body: ${i?.path.join(".") || "(root)"} ${i?.message ?? "invalid"}`,
        "check the OAuth app's grant type (client credentials) and scopes",
      );
    }
    const token = {
      accessToken: j.data.access_token,
      expiresAt: iso(new Date(now + j.data.expires_in * 1000)),
    };
    await writeCredentials(this.dirs, { clientId: c.clientId, clientSecret: c.clientSecret, token });
    return token.accessToken;
  }

  async invalidate(): Promise<void> {
    const c = await readCredentials(this.dirs);
    await writeCredentials(this.dirs, { clientId: c.clientId, clientSecret: c.clientSecret, token: null });
  }

  async expiresAt(): Promise<string | null> {
    return (await readCredentials(this.dirs)).token?.expiresAt ?? null;
  }
}
