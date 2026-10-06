// src/cli/wire.ts — the only place a live Ctx is built (Tasks 12 and 13 use it too).
import { loadConfig } from "../config/load";
import { GhCli } from "../gh/cli";
import { GitCli } from "../git/cli";
import { TokenStore } from "../linear/auth";
import { LinearClient } from "../linear/client";
import { GraphQL } from "../linear/graphql";
import { type Ctx, buildCtx } from "../machine/context";
import { guardedCtx } from "../machine/guard";
import { OrcaClient } from "../orca/client";
import { WingmateError } from "../shared/errors";
import { homeDirs } from "../shared/paths";
import { SystemClock } from "../shared/time";

/** A Ctx whose every write verb (Linear, Orca, git push, gh pr create) and the process sweep refuse with `read_only`. */
export function readOnlyCtx(ctx: Ctx): Ctx {
  return guardedCtx(ctx, async (verb) => {
    throw new WingmateError("read_only", `read-only context: ${verb} is not allowed`);
  });
}

export async function buildRealCtx(
  o: { readOnly: boolean } = { readOnly: false },
): Promise<Ctx & { tokens: TokenStore }> {
  const dirs = homeDirs();
  const clock = new SystemClock();
  const cfg = await loadConfig();
  const tokens = new TokenStore(dirs, clock);
  // Ruling R17: 20 s per request and two retries keep a hung Linear well inside the 180 s tick budget
  const linear = new LinearClient(new GraphQL(tokens, fetch, { timeoutMs: 20_000, maxRetries: 2 }));
  const ctx = await buildCtx({
    cfg,
    dirs,
    clock,
    linear,
    orca: new OrcaClient(),
    git: new GitCli(),
    gh: new GhCli(),
  });
  return Object.assign(o.readOnly ? readOnlyCtx(ctx) : ctx, { tokens });
}
