// src/machine/step.ts — what each §6.3 step of one record's advance shares.
import type { ProjectConfig } from "../config/schema";
import type { LinearIssue } from "../ports";
import type { WRecord } from "../state/records";
import type { Ctx } from "./context";
import type { Liveness } from "./liveness";
import type { Event, Reconciled } from "./reconcile";
import type { Budget, TickSummary } from "./tick";

export interface Advance {
  ctx: Ctx;
  rec: Reconciled;
  /** The record, re-read under its lock (held for that read only, F1); steps mutate this object, every write is compare-and-write. */
  r: WRecord;
  /** The issue as reconcile read it, kept in step with Wingmate's own writes (LinearWrites). */
  issue: LinearIssue;
  s: TickSummary;
  budget: Budget;
  project: ProjectConfig;
  evs: Event[];
  /** The coordinator's liveness at reconcile time; stale once this tick (re)launched it. */
  live: Liveness | undefined;
  /** §6.7 reconcile-only (the tick's, or its project paused, F3): bookkeeping, but nothing that starts an agent. */
  ro: boolean;
  /** A (re)launch, resume or handoff happened this tick: liveness and timers are not judged on the stale snapshot. */
  launched: boolean;
  /** A tick-level transition or note: the status comment is refreshed once at the end (Ruling R1). */
  dirty: boolean;
}

/** `next`: continue with the following step; `stop`: this record is done for the tick. */
export type StepOut = "next" | "stop";

/** Records whose coordinator is supposed to be running. */
export const WORKING: ReadonlySet<string> = new Set(["claimed", "working"]);
