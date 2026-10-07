// src/cli/commands/pause.ts — `wingmate pause [--project <key>] [--off]` and `wingmate resume [--project <key>]` (§13.3 i, §6.7): the
// scopes the tick reads from pause.json. Local only: no Linear or Orca call, so it works whatever is down.
import { loadConfig } from "../../config/load";
import type { Config } from "../../config/schema";
import { GLOBAL_SCOPE, setPause } from "../../ops/pause";
import { type Dirs, homeDirs } from "../../shared/paths";
import { Ledger } from "../../state/ledger";
import type { Argv } from "../index";
import { UsageError, readFlags } from "../ops";
import { stderr, stdout } from "./tick";

const USAGE = "usage: wingmate pause [--project <key>] [--off] | wingmate resume [--project <key>]";
export interface LocalDeps {
  dirs?: Dirs;
  loadCfg?: () => Promise<Config>;
  now?: () => string;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export async function pauseCommand(argv: Argv, deps: LocalDeps = {}): Promise<number> {
  const out = deps.out ?? stdout;
  const err = deps.err ?? stderr;
  const resume = argv.cmd[0] === "resume";
  let flags: ReturnType<typeof readFlags>;
  try {
    if (argv.cmd.length > 1) throw new UsageError(USAGE);
    flags = readFlags(argv, { bool: resume ? ["json"] : ["off", "json"], value: ["project"] }, USAGE);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(e.usage);
    return 2;
  }
  const cfg = await (deps.loadCfg ?? (() => loadConfig()))();
  const project = flags.value.get("project");
  if (project !== undefined && (project === GLOBAL_SCOPE || !cfg.projects[project])) {
    err(`${USAGE}\nunknown project ${project} (one of ${Object.keys(cfg.projects).join(", ")})`);
    return 2;
  }
  const on = !resume && !flags.bool.has("off");
  const scope = project ?? GLOBAL_SCOPE;
  const dirs = deps.dirs ?? homeDirs();
  const scopes = await setPause(dirs, scope, on);
  await new Ledger(dirs).append({
    at: (deps.now ?? (() => new Date().toISOString()))(),
    issue: null,
    type: on ? "pause" : "resume",
    data: { scope, scopes },
  });
  if (flags.bool.has("json")) out(JSON.stringify({ paused: scopes }));
  else out(scopes.length ? `paused: ${scopes.join(", ")}` : "nothing paused");
  return 0;
}
