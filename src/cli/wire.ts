// src/cli/wire.ts — the only place a live Ctx is built (Tasks 12 and 13 use it too).
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config/load";
import { GhCli } from "../gh/cli";
import { GitCli } from "../git/cli";
import { TokenStore } from "../linear/auth";
import { LinearClient } from "../linear/client";
import { EnvToken } from "../linear/envToken";
import { GraphQL } from "../linear/graphql";
import { type Ctx, buildCtx } from "../machine/context";
import { guardedCtx } from "../machine/guard";
import { OrcaClient } from "../orca/client";
import type { LinearTeamMeta } from "../ports";
import { WingmateError, errorCode } from "../shared/errors";
import { type Dirs, homeDirs } from "../shared/paths";
import { type Clock, SystemClock } from "../shared/time";

/** A Ctx whose every write verb (Linear, Orca, git push, gh pr create) and the process sweep refuse with `read_only`. */
export function readOnlyCtx(ctx: Ctx): Ctx {
  return guardedCtx(ctx, async (verb) => {
    throw new WingmateError("read_only", `read-only context: ${verb} is not allowed`);
  });
}

export interface RealCtxOptions {
  readOnly: boolean;
  /**
   * Task 12: build even when Linear cannot be read (no app credentials yet, an outage) — `stop` must work then, `install` runs before
   * the credentials exist and `doctor` reports the failure as a check. The team metadata is then empty: a Linear write that needs it
   * fails with context, and `linearDown` carries the code.
   */
  linearOptional?: boolean;
}
export type RealCtx = Ctx & { tokens: TokenStore | EnvToken; graphql: GraphQL; linearDown: string | null };

/** Whether the OAuth app's credentials.json exists. Its content is TokenStore's to judge: a broken file never falls back. */
async function hasAppCredentials(dirs: Dirs): Promise<boolean> {
  try {
    await lstat(join(dirs.config, "credentials.json"));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/**
 * §11.1 identity (Task 13): the token a live context reads Linear with.
 * - credentials.json present: the app's TokenStore, for every context (all Wingmate reads and writes are the app's).
 * - absent, read-only (`scan`, `tick --dry-run`): EnvToken, the owner's personal key; that context refuses every write (`read_only`).
 * - absent, `linearOptional` (`install`, `stop`, `doctor`): the TokenStore, as Task 12 built them — Linear cannot be read
 *   (`linearDown` = `linear_credentials_missing`) and the command carries on; the personal key is never used there.
 * - absent otherwise (`tick`, `tick --precheck`): `linear_app_required`, before anything is read — a personal key never writes.
 */
export async function linearTokens(
  o: RealCtxOptions,
  dirs: Dirs,
  clock: Clock,
  env: Record<string, string | undefined> = process.env,
): Promise<TokenStore | EnvToken> {
  if (await hasAppCredentials(dirs)) return new TokenStore(dirs, clock);
  if (o.readOnly) return new EnvToken(dirs.config, { env });
  if (o.linearOptional) return new TokenStore(dirs, clock);
  throw new WingmateError(
    "linear_app_required",
    `writing to Linear needs the Wingmate OAuth app, and ${join(dirs.config, "credentials.json")} does not exist; a personal API key serves only read-only commands (scan, tick --dry-run)`,
    "docs/linear-app-setup.md: create the OAuth app, then run `wingmate install --client-id <id> --client-secret -` (the secret on stdin)",
  );
}

export async function buildRealCtx(o: RealCtxOptions = { readOnly: false }): Promise<RealCtx> {
  const dirs = homeDirs();
  const clock = new SystemClock();
  const tokens = await linearTokens(o, dirs, clock);
  const cfg = await loadConfig();
  // Ruling R17: 20 s per request and two retries keep a hung Linear well inside the 180 s tick budget
  const graphql = new GraphQL(tokens, fetch, { timeoutMs: 20_000, maxRetries: 2 });
  const linear = new LinearClient(graphql);
  let teamMeta: LinearTeamMeta | undefined;
  let linearDown: string | null = null;
  if (o.linearOptional)
    teamMeta = await linear.teamMeta(cfg.workspace.team).catch((e: unknown): LinearTeamMeta => {
      linearDown = errorCode(e);
      return { states: [], labels: [] };
    });
  const ctx = await buildCtx({
    cfg,
    dirs,
    clock,
    linear,
    orca: new OrcaClient(),
    git: new GitCli(),
    gh: new GhCli(),
    ...(teamMeta ? { teamMeta } : {}),
  });
  return Object.assign(o.readOnly ? readOnlyCtx(ctx) : ctx, { tokens, graphql, linearDown });
}
