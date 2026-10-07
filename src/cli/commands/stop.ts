// src/cli/commands/stop.ts — `wingmate stop --issue <id> | --project <key> | --all [--reason <text>] [--json]` (§13.3 i): the kill switch.
import { type StopScope, stop } from "../../ops/stop";
import { IDENTIFIER_RE } from "../../shared/ids";
import type { Argv } from "../index";
import { type OpsDeps, UsageError, buildOps, readFlags } from "../ops";
import { stderr, stdout } from "./tick";

const USAGE = "usage: wingmate stop --issue <id> | --project <key> | --all [--reason <text>] [--json]";

export async function stopCommand(argv: Argv, deps: OpsDeps = {}): Promise<number> {
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
  const ctx = await buildOps(deps, { readOnly: false, linearOptional: true });
  if (scope.kind === "project" && !ctx.cfg.projects[scope.key]) {
    err(`${USAGE}\nunknown project ${scope.key} (one of ${Object.keys(ctx.cfg.projects).join(", ")})`);
    return 2;
  }
  const r = await stop(ctx, scope, flags.value.get("reason") ?? "");
  if (flags.bool.has("json")) out(JSON.stringify(r, null, 2));
  else {
    out(`stopped (blocked owner_stop): ${r.stopped.join(", ") || "none"}`);
    if (r.deferred.length)
      out(`Linear label and comment follow on the next tick for: ${r.deferred.join(", ")}`);
    if (r.unverifiable.length) out(`could not verify stopped: ${r.unverifiable.join(", ")}`);
    if (r.failed.length) out(`not blocked: ${r.failed.join(", ")}`);
    out(
      r.flagCleared
        ? "stop flag cleared"
        : "stop flag KEPT: ticks stay stopped for this scope; fix the failures and re-run",
    );
  }
  return r.flagCleared && r.failed.length === 0 && r.unverifiable.length === 0 ? 0 : 1;
}
