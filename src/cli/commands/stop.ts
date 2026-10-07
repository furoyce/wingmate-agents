// src/cli/commands/stop.ts — `wingmate stop --issue <id> | --project <key> | --all [--reason <text>] [--json]` (§13.3 i): the kill switch.
// F2: the flag is written before the live context is built (its Linear read can retry for a minute or more). F8: the config file is
// read first, for every scope, so a stop that cannot run writes no flag; and "stop flag cleared" is said only once no entry holds the
// scope.
import { loadConfig } from "../../config/load";
import type { Config } from "../../config/schema";
import { type StopEntry, type StopReport, type StopScope, requestScopedStop, stop } from "../../ops/stop";
import { IDENTIFIER_RE } from "../../shared/ids";
import { homeDirs } from "../../shared/paths";
import type { Argv } from "../index";
import { type OpsDeps, UsageError, buildOps, readFlags } from "../ops";
import type { LocalDeps } from "./pause";
import { stderr, stdout } from "./tick";

const USAGE = "usage: wingmate stop --issue <id> | --project <key> | --all [--reason <text>] [--json]";
/** The local state the flag is written to before anything is built (tests point it at the fake world). */
export type StopCommandDeps = OpsDeps & Pick<LocalDeps, "dirs" | "loadCfg" | "now">;
export const FLAG_KEPT = "stop flag KEPT: ticks stay stopped for this scope; fix the failures and re-run";
export const NO_FLAG =
  "stop flag NOT written: nothing was stopped (the config could not be read; run wingmate where config/projects.yaml is, or set WINGMATE_CONFIG)";

/**
 * F8: the config is read before the flag is written, for every scope. It is a local read (the live context's slow part is Linear), and
 * a stop that could not load it would leave a flag no later stop releases. On failure the owner is told nothing was stopped.
 */
export async function readConfigFirst(deps: StopCommandDeps, err: (line: string) => void): Promise<Config> {
  try {
    return await (deps.loadCfg ?? (() => loadConfig()))();
  } catch (e) {
    err(NO_FLAG);
    throw e;
  }
}

/** An entry as the owner sees it: the stop that wrote it and when (scope, key and time only). */
const entryName = (e: StopEntry) =>
  `wingmate stop ${e.scope === "all" ? "--all" : `--${e.scope} ${e.key ?? "?"}`} (${e.at})`;

/** F8: "stop flag cleared" only when no entry holds the scope; otherwise this stop's own kept entry and every other one holding it. */
export function flagLines(r: StopReport, own: StopEntry): string[] {
  if (r.flagCleared) return ["stop flag cleared"];
  const others = r.heldBy.filter((e) => !(e.scope === own.scope && e.key === own.key && e.at === own.at));
  const lines = others.length < r.heldBy.length ? [FLAG_KEPT] : [];
  if (others.length)
    lines.push(
      `stop flag still held for this scope by ${others.map(entryName).join(", ")}: ticks stay stopped until that stop finishes; re-run it if it is no longer running`,
    );
  return lines;
}

export async function stopCommand(argv: Argv, deps: StopCommandDeps = {}): Promise<number> {
  const out = deps.out ?? stdout;
  const err = deps.err ?? stderr;
  let flags: ReturnType<typeof readFlags>;
  let scope: StopScope;
  try {
    if (argv.cmd.length > 1) throw new UsageError(USAGE);
    flags = readFlags(argv, { bool: ["all", "json"], value: ["issue", "project", "reason"] }, USAGE);
    const issue = flags.value.get("issue");
    const project = flags.value.get("project");
    const given = [issue !== undefined, project !== undefined, flags.bool.has("all")].filter(Boolean).length;
    if (given !== 1) throw new UsageError(`${USAGE}\nname exactly one of --issue, --project, --all`);
    if (issue !== undefined && !IDENTIFIER_RE.test(issue))
      throw new UsageError(`${USAGE}\n--issue takes an issue identifier`);
    scope =
      issue !== undefined
        ? { kind: "issue", key: issue }
        : project !== undefined
          ? { kind: "project", key: project }
          : { kind: "all" };
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(e.usage);
    return 2;
  }
  const cfg = await readConfigFirst(deps, err);
  if (scope.kind === "project" && !cfg.projects[scope.key]) {
    err(`${USAGE}\nunknown project ${scope.key} (one of ${Object.keys(cfg.projects).join(", ")})`);
    return 2;
  }
  const reason = flags.value.get("reason") ?? "";
  const at = (deps.now ?? (() => new Date().toISOString()))();
  const requested = await requestScopedStop(deps.dirs ?? homeDirs(), scope, reason, at); // (1) before Linear or Orca
  let r: StopReport;
  try {
    r = await stop(await buildOps(deps, { readOnly: false, linearOptional: true }), scope, reason, {
      requested,
    });
  } catch (e) {
    err(FLAG_KEPT);
    throw e;
  }
  if (flags.bool.has("json")) out(JSON.stringify(r, null, 2));
  else {
    out(`stopped (blocked owner_stop): ${r.stopped.join(", ") || "none"}`);
    if (r.deferred.length)
      out(`Linear label and comment follow on the next tick for: ${r.deferred.join(", ")}`);
    if (r.unverifiable.length) out(`could not verify stopped: ${r.unverifiable.join(", ")}`);
    if (r.failed.length) out(`not blocked: ${r.failed.join(", ")}`);
    for (const l of flagLines(r, requested)) out(l);
  }
  return r.flagCleared && r.failed.length === 0 && r.unverifiable.length === 0 ? 0 : 1;
}
