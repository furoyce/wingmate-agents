// src/cli/commands/tick.ts — `wingmate tick [--precheck] [--dry-run] [--json]` (§4.3, §6.5): the summary is schema-validated before it
// is printed — identifiers, enumerated codes and counts only — and the exit code is never 0 (the automation's agent never starts).
import { z } from "zod";
import type { Ctx } from "../../machine/context";
import { type TickSummary, exitCodeFor, tick } from "../../machine/tick";
import { errorCode } from "../../shared/errors";
import { IDENTIFIER_RE } from "../../shared/ids";
import { HeartbeatSchema, QuotaNoticesSchema } from "../../state/heartbeat";
import type { Argv } from "../index";
import { buildRealCtx } from "../wire";

const Id = z.string().regex(IDENTIFIER_RE);
const Code = z.string().regex(/^[a-z_]+(\([A-Za-z0-9_,.:-]*\))?$/);
export const SummarySchema = z
  .object({
    at: z.string().datetime(),
    outcome: HeartbeatSchema.shape.outcome,
    reason: Code.nullable(),
    reconcileOnly: z.boolean(),
    claims: z.array(Id),
    resumes: z.array(Id),
    relaunches: z.array(Id),
    handoffs: z.array(Id),
    blocked: z.array(Id),
    released: z.array(Id),
    done: z.array(Id),
    parked: z.array(Id),
    finished: z.array(Id),
    skipped: z.array(z.object({ identifier: Id, reason: Code }).strict()),
    attention: z.array(z.object({ identifier: Id, code: Code }).strict()),
    quota: QuotaNoticesSchema, // F10: provider names, enum codes and the snapshot's age only
    counts: z.record(z.number()),
    durationMs: z.number(),
  })
  .strict();

export interface CommandDeps {
  /** `startedAt` (REL-5): `tick` passes its own start, so the context's Linear client is bounded by the tick's deadline. */
  build?: (o: { readOnly: boolean; startedAt?: number }) => Promise<Ctx>;
  out?: (line: string) => void;
  err?: (line: string) => void;
}
export const stdout = (line: string) => {
  process.stdout.write(`${line}\n`);
};
export const stderr = (line: string) => {
  process.stderr.write(`${line}\n`);
};

/** A top-level command with only known valueless flags; refuse typos and extra words before building a context. */
export function booleanFlagsOnly(argv: Argv, names: readonly string[]): boolean {
  return (
    argv.cmd.length === 1 &&
    Object.entries(argv.flags).every(([name, value]) => names.includes(name) && value === true)
  );
}

/** Prints the validated summary and returns `code`; a summary that fails its schema prints only `summary_schema` and exits 2. */
export function printSummary(summary: TickSummary, out: (line: string) => void, code: number): number {
  const parsed = SummarySchema.safeParse(summary);
  if (!parsed.success) {
    out(JSON.stringify({ outcome: "error", reason: "summary_schema" }));
    return 2;
  }
  out(JSON.stringify(parsed.data));
  return code;
}

export async function tickCommand(argv: Argv, deps: CommandDeps = {}): Promise<number> {
  const startedAt = Date.now(); // REL-1: the tick's deadline counts from here, the context build (token mint, team read) included
  const out = deps.out ?? stdout;
  if (!booleanFlagsOnly(argv, ["dry-run", "precheck", "json"])) {
    (deps.err ?? stderr)("usage: wingmate tick [--precheck] [--dry-run] [--json]");
    return 2;
  }
  const dryRun = argv.flags["dry-run"] === true;
  const precheck = argv.flags.precheck === true;
  let summary: TickSummary;
  try {
    const ctx = await (deps.build ?? buildRealCtx)({ readOnly: dryRun, startedAt });
    summary = await tick(ctx, { dryRun, precheck, startedAt });
  } catch (e) {
    out(JSON.stringify({ outcome: "error", reason: errorCode(e) }));
    return 2;
  }
  return printSummary(summary, out, exitCodeFor(summary.outcome));
}
