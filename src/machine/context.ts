// src/machine/context.ts — everything a tick needs, built once per process
import { join } from "node:path";
import type { Config } from "../config/schema";
import type { Intent } from "../kit/intents";
import type { GhPort, GitPort, LinearIssue, LinearPort, LinearTeamMeta, OrcaPort } from "../ports";
import { run } from "../shared/exec";
import { logger } from "../shared/logger";
import type { Dirs } from "../shared/paths";
import type { Clock } from "../shared/time";
import { Journal } from "../state/journal";
import { Ledger } from "../state/ledger";
import type { WRecord } from "../state/records";
import type { Reconciled } from "./reconcile";

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

/**
 * §13.3(d) publishing (`./publish`, loaded on first use): true once the PR is open and the issue is in review; false when the guards
 * refused — nothing is pushed, and the record is either still working with the refusal's pointer delivered or blocked.
 */
export type PublishFn = (
  ctx: Ctx,
  r: WRecord,
  issue: LinearIssue,
  intent: Extract<Intent, { kind: "finish" }>,
  rec: Reconciled,
) => Promise<boolean>;
export interface SweepResult {
  killed: string[];
  /** Process names (never command lines) for the ledger's proof. */
  commands?: string[];
}
/** §13.3(i) process sweep; `spare` keeps the process whose command line carries it (the parked coordinator) and its ancestors. */
export type SweepFn = (paths: string[], opts?: { spare?: string }) => Promise<SweepResult>;

/**
 * REL-1 (§4.3): the tick's wall-clock bound. After `at` every external action ends the tick (`tick_deadline`, through the guard), and no
 * wait runs past it; `now` is the clock it is read with (tests inject one).
 */
export interface TickDeadline {
  at: number;
  now(): number;
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
  /** The dispatcher-owned kit dir of an issue: `<state>/kit/<identifier>` (§13.3 a; `spawn` derives the same path). */
  kitDirFor(identifier: string): string;
  /** Read-only paths of the agents' toolchain for the sandbox `allowRead` (§13.3 b). */
  toolchainPaths: string[];
  sweep: SweepFn;
  publishImpl(): Promise<{ publish: PublishFn }>;
  /** REL-1: set by `tick` for its own run; absent outside a tick (no bound). */
  deadline?: TickDeadline;
}

/** REL-1: what is left of the tick's time in ms (unbounded outside a tick). */
export const remainingMs = (ctx: Ctx): number =>
  ctx.deadline ? ctx.deadline.at - ctx.deadline.now() : Number.POSITIVE_INFINITY;

export interface BuildCtxInput {
  cfg: Config;
  dirs: Dirs;
  clock: Clock;
  linear: LinearPort;
  orca: OrcaPort;
  git: GitPort;
  gh: GhPort;
  home?: string;
  toolchainPaths?: string[];
  sweep?: SweepFn;
  publishImpl?: () => Promise<{ publish: PublishFn }>;
  /** Team metadata read already (or the empty fallback of a command that must run while Linear is down); absent → read here. */
  teamMeta?: LinearTeamMeta;
}

/** The Homebrew prefix: git and gh may live under a user-level prefix inside `denyRead ~/` (spike 2026-10-06 §2.5, Ruling R11). */
async function brewPrefix(): Promise<string | null> {
  if (process.env.HOMEBREW_PREFIX) return process.env.HOMEBREW_PREFIX;
  try {
    const r = await run(["brew", "--prefix"], { timeoutMs: 5_000 });
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  } catch {
    return null; // brew is not installed
  }
}

/**
 * The default toolchain read grants. `~/.codex` is deliberately absent although the plan listed it: it holds Codex's `auth.json`,
 * and the agent sandbox denies reading it (§13.3 b `Read(~/.codex/**)`, `denyWrite ~/.codex/**`).
 */
export async function defaultToolchainPaths(home: string): Promise<string[]> {
  const brew = await brewPrefix();
  return [
    ...new Set([
      "/usr/bin",
      "/bin",
      "/opt/homebrew",
      "/usr/local/bin",
      join(home, ".bun"),
      join(home, ".local/bin"),
      join(home, ".local/share/claude"),
      ...(brew ? [brew] : []),
    ]),
  ];
}

export async function buildCtx(o: BuildCtxInput): Promise<Ctx> {
  const tm = o.teamMeta ?? (await o.linear.teamMeta(o.cfg.workspace.team));
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
  const home = o.home ?? process.env.HOME ?? "/";
  return {
    cfg: o.cfg,
    dirs: o.dirs,
    clock: o.clock,
    linear: o.linear,
    orca: o.orca,
    git: o.git,
    gh: o.gh,
    home,
    journal: new Journal(o.dirs, o.clock),
    ledger: new Ledger(o.dirs),
    // Logs go under this context's state root (never the real home when tests pass a temp Dirs).
    log: logger(o.dirs.logs),
    meta,
    now: () => o.clock.now().toISOString(),
    kitDirFor: (identifier) => join(o.dirs.kit, identifier),
    toolchainPaths: o.toolchainPaths ?? (await defaultToolchainPaths(home)),
    sweep: o.sweep ?? ((paths, opts) => import("./sweep").then((m) => m.sweep(paths, opts))),
    publishImpl: o.publishImpl ?? (() => import("./publish")),
  };
}
