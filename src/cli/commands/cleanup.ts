import pino from "pino";
import { loadConfig, selectedConfigPath } from "../../config/load";
import { GhCli } from "../../gh/cli";
import { GitCli } from "../../git/cli";
import { type Ctx, buildCtx } from "../../machine/context";
import { type CleanupScope, cleanupOps, renderCleanupMd } from "../../ops/cleanup";
import { OrcaClient } from "../../orca/client";
import type { LinearPort } from "../../ports";
import { WingmateError } from "../../shared/errors";
import { IDENTIFIER_RE } from "../../shared/ids";
import { homeDirs } from "../../shared/paths";
import { SystemClock } from "../../shared/time";
import type { Argv } from "../index";
import { UsageError, readFlags } from "../ops";
import { readOnlyCtx } from "../wire";
import { stderr, stdout } from "./tick";

const USAGE =
  "usage: wingmate cleanup (--issue <id> | --project <key> | --all) [--dry-run] [--json] [--force] [--orphaned]";
export interface CleanupCommandDeps {
  build?: (options: { readOnly: boolean }) => Promise<Ctx>;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

/** Cleanup never needs Linear. In particular, a dry run must not mint/refresh credentials or create log/state directories. */
export async function buildCleanupCtx(options: { readOnly: boolean }): Promise<Ctx> {
  const cfg = await loadConfig(await selectedConfigPath());
  const linear = new Proxy({} as LinearPort, {
    get: () => () => {
      throw new WingmateError("cleanup_linear_forbidden", "cleanup does not access Linear");
    },
  });
  const ctx = await buildCtx({
    cfg,
    dirs: homeDirs(),
    clock: new SystemClock(),
    linear,
    orca: new OrcaClient(),
    git: new GitCli(),
    gh: new GhCli(),
    teamMeta: { states: [], labels: [] },
    toolchainPaths: [],
    log: pino({ enabled: false }),
  });
  return options.readOnly ? readOnlyCtx(ctx) : ctx;
}

export async function cleanupCommand(argv: Argv, deps: CleanupCommandDeps = {}): Promise<number> {
  const out = deps.out ?? stdout;
  const err = deps.err ?? stderr;
  let scope: CleanupScope;
  let flags: ReturnType<typeof readFlags>;
  try {
    if (argv.cmd.length !== 1) throw new UsageError(USAGE);
    flags = readFlags(
      argv,
      { bool: ["all", "dry-run", "json", "force", "orphaned"], value: ["issue", "project"] },
      USAGE,
    );
    const issue = flags.value.get("issue");
    const project = flags.value.get("project");
    if ([issue !== undefined, project !== undefined, flags.bool.has("all")].filter(Boolean).length !== 1)
      throw new UsageError(`${USAGE}\nexactly one explicit scope is required`);
    if (issue !== undefined && !IDENTIFIER_RE.test(issue))
      throw new UsageError(`${USAGE}\ninvalid issue identifier`);
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
  const dryRun = flags.bool.has("dry-run");
  const ctx = await (deps.build ?? buildCleanupCtx)({ readOnly: dryRun });
  if (scope.kind === "project" && !ctx.cfg.projects[scope.key]) {
    err(`unknown project ${scope.key}`);
    return 2;
  }
  const report = await cleanupOps(ctx, {
    scope,
    dryRun,
    force: flags.bool.has("force"),
    orphaned: flags.bool.has("orphaned"),
  });
  out(flags.bool.has("json") ? JSON.stringify(report, null, 2) : renderCleanupMd(report));
  return report.inventory !== "complete" ||
    report.cleaned.some((r) => r.outcome === "deferred" && !["grace", "retry_delay"].includes(r.reason))
    ? 2
    : 0;
}
