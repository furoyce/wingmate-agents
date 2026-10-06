// src/linear/auth.ts — Linear OAuth app identity: client_credentials token minted and cached in credentials.json (0600).
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { WingmateError } from "../shared/errors";
import type { Dirs } from "../shared/paths";
import type { Clock } from "../shared/time";
import { iso } from "../shared/time";
import { readText, writeAtomic } from "../state/fs";

const Creds = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  token: z.object({ accessToken: z.string(), expiresAt: z.string() }).nullable().default(null),
});
export type Credentials = z.infer<typeof Creds>;

const SCOPES = "read,write,comments:create,issues:create";
const TOKEN_URL = "https://api.linear.app/oauth/token";
/** Re-mint when fewer than this many milliseconds remain before expiry. */
const REFRESH_MARGIN_MS = 24 * 3600 * 1000;

const path = (dirs: Dirs) => join(dirs.config, "credentials.json");

export async function writeCredentials(
  dirs: Dirs,
  c: { clientId: string; clientSecret: string; token?: Credentials["token"] },
): Promise<void> {
  await writeAtomic(path(dirs), JSON.stringify({ ...c, token: c.token ?? null }, null, 2), 0o600);
  await chmod(path(dirs), 0o600);
}

export async function readCredentials(dirs: Dirs): Promise<Credentials> {
  const t = await readText(path(dirs));
  if (!t)
    throw new WingmateError(
      "linear_credentials_missing",
      `no ${path(dirs)}`,
      "run `wingmate install` with the Linear OAuth client id/secret (docs/linear-app-setup.md)",
    );
  return Creds.parse(JSON.parse(t));
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
    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok)
      throw new WingmateError(
        "linear_token_mint_failed",
        `token endpoint returned ${res.status}`,
        "check the OAuth app client id/secret and that the app is installed in the workspace",
      );
    const j = z.object({ access_token: z.string(), expires_in: z.number() }).parse(await res.json());
    const token = { accessToken: j.access_token, expiresAt: iso(new Date(now + j.expires_in * 1000)) };
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
