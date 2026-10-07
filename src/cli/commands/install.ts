// src/cli/commands/install.ts — `wingmate install [--enable] [--client-id <id> --client-secret -] [--json]` (§4.3, §11.1, §11.5); C31:
// `--client-secret -` reads the OAuth client secret from one line of stdin, so it never stands on the command line.
import { doctor } from "../../ops/doctor";
import { type InstallResult, install } from "../../ops/install";
import { REPLACE_REFS_SETTING } from "../../ops/repoSettings";
import { upsertViews, viewDefinitions, viewRecipe } from "../../ops/views";
import { WingmateError } from "../../shared/errors";
import type { Argv } from "../index";
import { type OpsDeps, UsageError, buildOps, liveDoctorOptions, readFlags, readStdinLine } from "../ops";
import { stderr, stdout } from "./tick";

const USAGE = [
  "usage: wingmate install [--enable] [--client-id <id> --client-secret -] [--json]",
  "  --client-secret - reads the OAuth client secret from one line of stdin; never put the secret itself on the command line",
].join("\n");
/** C31: a literal secret still works, but `ps` and the shell history show every argument. The secret itself is never printed. */
const ARGV_SECRET_WARNING =
  "warning: a client secret given on the command line is visible in ps and in the shell history; pass --client-secret - and give it on stdin";
export interface InstallCommandDeps extends OpsDeps {
  install?: typeof install;
  /** C31: what `--client-secret -` reads its one line from (default: this process's stdin). */
  stdin?: AsyncIterable<Uint8Array | string>;
}

function print(r: InstallResult, out: (l: string) => void, cfg: Parameters<typeof viewRecipe>[0]): void {
  out(`installed wingmate ${r.version}`);
  out(`  binary      ${r.binPath} (sha256 ${r.sha256.slice(0, 16)}…)`);
  out(`  worktree    ${r.worktreeId}`);
  out(`  automation  ${r.automationId ?? "none"} (${r.enabled ? "enabled" : "disabled"})`);
  if (r.repoSettings.length) {
    // R30 (D14): a deliberate setting in each pilot repository, so Orca's checkouts follow no replace ref an agent plants
    out(`repository config ${REPLACE_REFS_SETTING} (Orca's checkouts follow no replace ref):`);
    const width = Math.max(...r.repoSettings.map((s) => s.repo.length));
    for (const s of r.repoSettings)
      out(
        `  ${s.repo.padEnd(width)}  ${s.outcome === "failed" ? `NOT SET (${s.detail ?? "unknown"})` : s.outcome}${s.path ? `  ${s.path}` : ""}`,
      );
    if (r.repoSettings.some((s) => s.outcome === "failed"))
      out(
        "  doctor's replace_refs_disabled refuses --enable until each is set: fix the cause, then re-run install",
      );
  }
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
  const given = flags.value.get("client-secret");
  if ((clientId === undefined) !== (given === undefined)) {
    err(`${USAGE}\n--client-id and --client-secret go together`);
    return 2;
  }
  let clientSecret = given;
  if (given === "-") {
    clientSecret = (await readStdinLine(deps.stdin)).trim();
    if (!clientSecret) {
      err(`${USAGE}\n--client-secret -: stdin gave no secret (one line expected)`);
      return 2;
    }
  } else if (given !== undefined) err(ARGV_SECRET_WARNING);
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
