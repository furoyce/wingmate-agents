// src/machine/guard.ts — a check before every external action (§6.0 stop flag, Ruling R16 lost lock) and the read-only context, both
// as proxies over the ports' write verbs, so no call site can forget them.
import { stopRequested } from "../state/heartbeat";
import type { Ctx } from "./context";

/**
 * Raised by the tick's guard; the tick turns it into its outcome instead of an error. REL-1: a tick past its deadline ends with outcome
 * `error`, reason `tick_deadline` (exit 2), its heartbeat written — never killed mid-step by the precheck timeout.
 */
export class TickAbort extends Error {
  constructor(
    readonly outcome: "lock_lost" | "stopped" | "error",
    readonly reason: string,
  ) {
    super(`tick aborted: ${reason}`);
    this.name = "TickAbort";
  }
}
export const isTickAbort = (e: unknown): e is TickAbort => e instanceof TickAbort;

/**
 * F1: raised inside one record's processing — a stop scoped to its issue or project, or another writer changed the record since this
 * tick read or wrote it. It is a `TickAbort`, so every catch that lets the tick's aborts through lets it through too; the record's
 * boundary (advance, claim, cleanup) catches it, and only that record stops for this tick.
 */
export class RecordAbort extends TickAbort {
  constructor(
    readonly code: "record_changed" | "stop_requested",
    readonly identifier: string,
  ) {
    super("stopped", code);
    this.name = "RecordAbort";
  }
}
export const isRecordAbort = (e: unknown): e is RecordAbort => e instanceof RecordAbort;

/**
 * F1 (§6.0, §13.3 i): the tick's context for one record. Before each external action a stop scoped to the record's project or issue
 * aborts that record; a stop for everything is left to the tick's own guard, which aborts the whole tick.
 */
export function recordCtx(ctx: Ctx, project: string, identifier: string): Ctx {
  return guardedCtx(ctx, async () => {
    if (await stopRequested(ctx.dirs)) return;
    if (await stopRequested(ctx.dirs, project, identifier))
      throw new RecordAbort("stop_requested", identifier);
  });
}

/**
 * The write verbs of each port: Linear and GitHub writes, Orca mutations, git push, the claim's fetch (C30: it writes the repository's
 * object store) and install's `core.useReplaceRefs=false` (R30: it writes the repository's config); reads pass through unguarded.
 */
export const WRITE_VERBS = {
  linear: ["updateIssue", "createComment", "updateComment", "createAttachment", "createIssue", "subscribe"],
  orca: [
    "worktreeCreate",
    "worktreeSet",
    "worktreeRm",
    "terminalCreate",
    "terminalKeys",
    "terminalSend",
    "terminalClose",
    "workerStop",
    "workerAbandon",
    "workerRelease",
    "orchestrationSend",
    "automationsCreate",
    "automationsEdit",
  ],
  git: ["push", "fetchCommit", "disableReplaceRefs"],
  gh: ["prCreate"],
} as const;

/** A view of `port` whose listed methods run `check` first; everything else is the port itself. */
export function guardMethods<T extends object>(
  port: T,
  verbs: readonly string[],
  check: (verb: string) => Promise<void>,
): T {
  return new Proxy(port, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || !verbs.includes(prop) || typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        await check(prop);
        return value.apply(target, args);
      };
    },
  });
}

/** A Ctx whose every external write (and process sweep) runs `check` first; the ports and the context object stay untouched. */
export function guardedCtx(ctx: Ctx, check: (verb: string) => Promise<void>): Ctx {
  return {
    ...ctx,
    checkMutation: async () => {
      await ctx.checkMutation?.();
      await check("cleanup");
    },
    linear: guardMethods(ctx.linear, WRITE_VERBS.linear, check),
    orca: guardMethods(ctx.orca, WRITE_VERBS.orca, check),
    git: guardMethods(ctx.git, WRITE_VERBS.git, check),
    gh: guardMethods(ctx.gh, WRITE_VERBS.gh, check),
    ...(ctx.nativeUi
      ? { nativeUi: guardMethods(ctx.nativeUi, ["acquire", "simctl", "emulator", "capture"], check) }
      : {}),
    sweep: async (paths, opts) => {
      await check("sweep");
      return ctx.sweep(paths, opts);
    },
    // methods that read ctx fields keep working on the copy
    now: ctx.now,
    kitDirFor: ctx.kitDirFor,
    publishImpl: () => ctx.publishImpl(),
  };
}
