// src/cli/commands/status.ts — `wingmate status [--json|--md] [--cost] [--project <key>]` (§13.2): local state only, identifiers and codes.
import { loadConfig } from "../../config/load";
import { renderStatusMd, statusReport } from "../../ops/status";
import { homeDirs } from "../../shared/paths";
import type { Argv } from "../index";
import { UsageError, readFlags } from "../ops";
import type { LocalDeps } from "./pause";
import { stderr, stdout } from "./tick";

const USAGE = "usage: wingmate status [--json|--md] [--cost] [--project <key>]";

export async function statusCommand(argv: Argv, deps: LocalDeps = {}): Promise<number> {
  const out = deps.out ?? stdout;
  const err = deps.err ?? stderr;
  let flags: ReturnType<typeof readFlags>;
  try {
    if (argv.cmd.length > 1) throw new UsageError(USAGE);
    flags = readFlags(argv, { bool: ["json", "md", "cost"], value: ["project"] }, USAGE);
    if (flags.bool.has("json") && flags.bool.has("md"))
      throw new UsageError(`${USAGE}\n--json and --md exclude each other`);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(e.usage);
    return 2;
  }
  const project = flags.value.get("project");
  if (project !== undefined) {
    const cfg = await (deps.loadCfg ?? (() => loadConfig()))();
    if (!cfg.projects[project]) {
      err(`${USAGE}\nunknown project ${project} (one of ${Object.keys(cfg.projects).join(", ")})`);
      return 2;
    }
  }
  const report = await statusReport(
    { dirs: deps.dirs ?? homeDirs(), now: deps.now ?? (() => new Date().toISOString()) },
    { cost: flags.bool.has("cost"), ...(project !== undefined ? { project } : {}) },
  );
  if (flags.bool.has("json")) out(JSON.stringify(report, null, 2));
  else out(renderStatusMd(report).trimEnd());
  return 0;
}
