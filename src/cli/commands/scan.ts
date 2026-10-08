// src/cli/commands/scan.ts — `wingmate scan [--json]`: the plan-only tick on a read-only context; exit 0 would act, 1 idle, 2 error.
import { scan } from "../../machine/scan";
import { errorCode } from "../../shared/errors";
import type { Argv } from "../index";
import { buildRealCtx } from "../wire";
import { type CommandDeps, booleanFlagsOnly, printSummary, stderr, stdout } from "./tick";

export async function scanCommand(argv: Argv, deps: CommandDeps = {}): Promise<number> {
  const out = deps.out ?? stdout;
  // `--dry-run` is accepted for symmetry with tick (§15.1 says `scan --dry-run`); scan never writes either way
  if (!booleanFlagsOnly(argv, ["json", "dry-run"])) {
    (deps.err ?? stderr)("usage: wingmate scan [--dry-run] [--json]");
    return 2;
  }
  try {
    const ctx = await (deps.build ?? buildRealCtx)({ readOnly: true });
    const { exitCode, summary } = await scan(ctx);
    return printSummary(summary, out, exitCode);
  } catch (e) {
    out(JSON.stringify({ outcome: "error", reason: errorCode(e) }));
    return 2;
  }
}
