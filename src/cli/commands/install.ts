// src/cli/commands/install.ts — `wingmate install [--enable] [--client-id <id> --client-secret <secret>] [--json]` (§4.3, §11.1, §11.5).
import { doctor } from "../../ops/doctor";
import { type InstallResult, install } from "../../ops/install";
import { upsertViews, viewDefinitions, viewRecipe } from "../../ops/views";
import { WingmateError } from "../../shared/errors";
import type { Argv } from "../index";
import { type OpsDeps, UsageError, buildOps, liveDoctorOptions, readFlags } from "../ops";
import { stderr, stdout } from "./tick";

const USAGE = "usage: wingmate install [--enable] [--client-id <id> --client-secret <secret>] [--json]";
export interface InstallCommandDeps extends OpsDeps {
  install?: typeof install;
}

function print(r: InstallResult, out: (l: string) => void, cfg: Parameters<typeof viewRecipe>[0]): void {
  out(`installed wingmate ${r.version}`);
  out(`  binary      ${r.binPath} (sha256 ${r.sha256.slice(0, 16)}…)`);
  out(`  worktree    ${r.worktreeId}`);
  out(`  automation  ${r.automationId ?? "none"} (${r.enabled ? "enabled" : "disabled"})`);
  if (r.viewUrls.length) {
    out("saved views (set the display by hand; the API takes only the filter):");
    viewDefinitions(cfg).forEach((v, i) =>
      out(
        `  ${r.viewUrls[i] ?? "?"} — ${v.name}: ${v.display.layout}, grouped by ${v.display.grouping}, ordered by ${v.display.ordering}`,
      ),
    );
    out('  then favorite both views and subscribe to "Wingmate · Needs you"');
  } else {
    out(
      r.viewsError
        ? `saved views not written (${r.viewsError}); create them by hand:`
        : "saved views need the OAuth app; create them by hand:",
    );
    for (const l of viewRecipe(cfg)) out(`  ${l}`);
  }
  if (!r.enabled) out("next: `wingmate doctor`, then `wingmate install --enable`");
}

export async function installCommand(argv: Argv, deps: InstallCommandDeps = {}): Promise<number> {
  const out = deps.out ?? stdout;
  const err = deps.err ?? stderr;
  let flags: ReturnType<typeof readFlags>;
  try {
    if (argv.cmd.length > 1) throw new UsageError(`${USAGE}\n(uninstall is not part of slice 1)`);
    flags = readFlags(argv, { bool: ["enable", "json"], value: ["client-id", "client-secret"] }, USAGE);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(e.usage);
    return 2;
  }
  const clientId = flags.value.get("client-id");
  const clientSecret = flags.value.get("client-secret");
  if ((clientId === undefined) !== (clientSecret === undefined)) {
    err(`${USAGE}\n--client-id and --client-secret go together`);
    return 2;
  }
  const ctx = await buildOps(deps, { readOnly: false, linearOptional: true });
  const graphql = ctx.graphql;
  try {
    const r = await (deps.install ?? install)(ctx, {
      enable: flags.bool.has("enable"),
      repoRoot: process.cwd(),
      ...(clientId !== undefined && clientSecret !== undefined ? { clientId, clientSecret } : {}),
      ...(graphql ? { views: (c) => upsertViews(c.cfg, graphql) } : {}),
      doctor: (c) => doctor(c, liveDoctorOptions(ctx)),
    });
    if (flags.bool.has("json")) out(JSON.stringify(r, null, 2));
    else print(r, out, ctx.cfg);
    return 0;
  } catch (e) {
    if (e instanceof WingmateError && e.code === "doctor_failed") {
      err(`${e.message}${e.nextStep ? `\n  next: ${e.nextStep}` : ""}`);
      return 1;
    }
    throw e;
  }
}
