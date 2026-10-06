// src/machine/context.ts — everything a tick needs, built once per process
import type { Config } from "../config/schema";
import type { GhPort, GitPort, LinearPort, LinearTeamMeta, OrcaPort } from "../ports";
import { logger } from "../shared/logger";
import type { Dirs } from "../shared/paths";
import type { Clock } from "../shared/time";
import { Journal } from "../state/journal";
import { Ledger } from "../state/ledger";

export interface Meta {
  states: LinearTeamMeta["states"];
  labels: LinearTeamMeta["labels"];
  stateId: (name: string) => string;
  stateByType: (type: string) => string;
  labelId: (name: string) => string;
  agentGroupId: string;
  lifecycleGroupId: string;
  lifecycleIds: Set<string>;
}

export interface Ctx {
  cfg: Config;
  dirs: Dirs;
  clock: Clock;
  linear: LinearPort;
  orca: OrcaPort;
  git: GitPort;
  gh: GhPort;
  journal: Journal;
  ledger: Ledger;
  log: ReturnType<typeof logger>;
  meta: Meta;
  home: string;
  now(): string;
}

export interface BuildCtxInput {
  cfg: Config;
  dirs: Dirs;
  clock: Clock;
  linear: LinearPort;
  orca: OrcaPort;
  git: GitPort;
  gh: GhPort;
  home?: string;
}

export async function buildCtx(o: BuildCtxInput): Promise<Ctx> {
  const tm = await o.linear.teamMeta(o.cfg.workspace.team);
  const labelId = (name: string) => {
    const l = tm.labels.find((x) => x.name === name);
    if (!l) throw new Error(`Linear label not found: ${name}`);
    return l.id;
  };
  const agentGroupId =
    tm.labels.find((l) => l.parentName === o.cfg.labels.agentGroup)?.parentId ?? "grp-agent";
  const lifecycleGroupId =
    tm.labels.find((l) => l.parentName === o.cfg.labels.lifecycleGroup)?.parentId ?? "grp-life";
  const meta: Meta = {
    states: tm.states,
    labels: tm.labels,
    labelId,
    agentGroupId,
    lifecycleGroupId,
    lifecycleIds: new Set(tm.labels.filter((l) => l.parentId === lifecycleGroupId).map((l) => l.id)),
    stateId: (name) => {
      const s = tm.states.find((x) => x.name === name);
      if (!s) throw new Error(`state not found: ${name}`);
      return s.id;
    },
    stateByType: (type) => {
      const s = tm.states.find((x) => x.type === type);
      if (!s) throw new Error(`no state of type ${type}`);
      return s.id;
    },
  };
  return {
    cfg: o.cfg,
    dirs: o.dirs,
    clock: o.clock,
    linear: o.linear,
    orca: o.orca,
    git: o.git,
    gh: o.gh,
    home: o.home ?? process.env.HOME ?? "/",
    journal: new Journal(o.dirs, o.clock),
    ledger: new Ledger(o.dirs),
    // Logs go under this context's state root (never the real home when tests pass a temp Dirs).
    log: logger(o.dirs.logs),
    meta,
    now: () => o.clock.now().toISOString(),
  };
}
