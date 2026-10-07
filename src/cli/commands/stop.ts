// src/cli/commands/stop.ts — `wingmate stop --issue <id> | --project <key> | --all [--reason <text>] [--json]` (§13.3 i): the kill switch.
// F2: the flag is written before the live context is built (its Linear read can retry for a minute or more); a project key is
// checked against the config file alone.
import { loadConfig } from "../../config/load";
import { type StopReport, type StopScope, requestScopedStop, stop } from "../../ops/stop";
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
  if (scope.kind === "project") {
    const cfg = await (deps.loadCfg ?? (() => loadConfig()))();
    if (!cfg.projects[scope.key]) {
      err(`${USAGE}\nunknown project ${scope.key} (one of ${Object.keys(cfg.projects).join(", ")})`);
      return 2;
    }
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
    out(r.flagCleared ? "stop flag cleared" : FLAG_KEPT);
  }
  return r.flagCleared && r.failed.length === 0 && r.unverifiable.length === 0 ? 0 : 1;
}
