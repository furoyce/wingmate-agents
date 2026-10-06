// src/machine/guard.ts — a check before every external action (§6.0 stop flag, Ruling R16 lost lock) and the read-only context, both
// as proxies over the ports' write verbs, so no call site can forget them.
import type { Ctx } from "./context";

/** Raised by the tick's guard; the tick turns it into its outcome instead of an error. */
export class TickAbort extends Error {
  constructor(
    readonly outcome: "lock_lost" | "stopped",
    readonly reason: string,
  ) {
    super(`tick aborted: ${reason}`);
    this.name = "TickAbort";
  }
}
export const isTickAbort = (e: unknown): e is TickAbort => e instanceof TickAbort;

/** The write verbs of each port: Linear and GitHub writes, Orca mutations, git push (reads pass through unguarded). */
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
  git: ["push"],
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
    linear: guardMethods(ctx.linear, WRITE_VERBS.linear, check),
    orca: guardMethods(ctx.orca, WRITE_VERBS.orca, check),
    git: guardMethods(ctx.git, WRITE_VERBS.git, check),
    gh: guardMethods(ctx.gh, WRITE_VERBS.gh, check),
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
