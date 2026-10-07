// src/cli/commands/doctor.ts — `wingmate doctor [--quick] [--notify-test <issue>] [--confirm-notify] [--rotate] [--json]` (§13.3, §7.5).
import { type DoctorOptions, type DoctorReport, doctor } from "../../ops/doctor";
import { type StopReport, requestScopedStop, stop } from "../../ops/stop";
import { errorCode } from "../../shared/errors";
import { IDENTIFIER_RE } from "../../shared/ids";
import { homeDirs } from "../../shared/paths";
import type { Argv } from "../index";
import { type OpsCtx, UsageError, buildOps, liveDoctorOptions, readFlags } from "../ops";
import { FLAG_KEPT, type StopCommandDeps, flagLines, readConfigFirst } from "./stop";
import { stderr, stdout } from "./tick";

const USAGE =
  "usage: wingmate doctor [--quick] [--notify-test <issue>] [--confirm-notify] [--rotate] [--json]";

/** §13.3(g): the compromise response `doctor --rotate` walks the owner through after `stop --all`. */
export const ROTATION_STEPS = [
  "1. Every agent is stopped and every active issue blocked (`wingmate stop --all`, done above).",
  "2. Linear: Settings → API → OAuth applications → Wingmate → rotate the client secret (all app tokens die with it).",
  "3. `wingmate install --client-id <id> --client-secret -` reads the new secret from stdin (paste it, then Enter) and stores it (0600); the cached token was dropped above.",
  // F5: `gh auth refresh` issues a new token and leaves the old one valid, and `gh auth logout` revokes nothing (gh's manual)
  "4. GitHub: revoke GitHub CLI's authorization at github.com/settings/applications (Authorized OAuth Apps → GitHub CLI → Revoke), which kills every gh token; if gh was logged in with a personal access token, delete it at github.com/settings/tokens. Then `gh auth login`.",
  "5. Inspect the worktrees named in the blocked comments, then `wingmate doctor`; re-queue issues by moving them to Todo.",
];

export function renderChecks(r: DoctorReport): string[] {
  const lines = r.checks.map(
    (c) => `${c.ok ? "ok  " : c.blocking ? "FAIL" : "warn"}  ${c.name.padEnd(20)} ${c.detail}`,
  );
  const failing = r.checks.filter((c) => !c.ok && c.blocking).length;
  lines.push(r.ok ? "doctor: ok" : `doctor: FAIL (${failing} blocking)`);
  return lines;
}

export type DoctorCommandDeps = StopCommandDeps & {
  /** Merged over the live options (tests inject the command runner and the probes). */
  doctorOverrides?: Partial<DoctorOptions>;
};

const ROTATE_REASON = "credential rotation (wingmate doctor --rotate)";

/**
 * `--rotate`: `stop --all` (F2: its flag written before the live context is built; F8: the config read before the flag), the cached
 * token dropped, the steps printed.
 */
async function rotate(
  deps: DoctorCommandDeps,
  json: boolean,
  out: (l: string) => void,
  err: (l: string) => void,
) {
  await readConfigFirst(deps, err);
  const at = (deps.now ?? (() => new Date().toISOString()))();
  const requested = await requestScopedStop(deps.dirs ?? homeDirs(), { kind: "all" }, ROTATE_REASON, at);
  let ctx: OpsCtx;
  let report: StopReport;
  try {
    ctx = await buildOps(deps, { readOnly: false, linearOptional: true });
    report = await stop(ctx, { kind: "all" }, ROTATE_REASON, { requested });
  } catch (e) {
    err(FLAG_KEPT);
    throw e;
  }
  const dropped = ctx.tokens
    ? await ctx.tokens.invalidate().then(
        () => "dropped",
        (e: unknown) => `not dropped (${errorCode(e)})`,
      )
    : "no token store";
  if (json) out(JSON.stringify({ stop: report, token: dropped }, null, 2));
  else {
    out(`stopped: ${report.stopped.join(", ") || "none"}`);
    for (const l of flagLines(report, requested)) out(l);
    out(`cached Linear token: ${dropped}`);
    for (const s of ROTATION_STEPS) out(s);
  }
  return report.flagCleared && report.failed.length === 0 ? 0 : 1;
}

export async function doctorCommand(argv: Argv, deps: DoctorCommandDeps = {}): Promise<number> {
  const out = deps.out ?? stdout;
  const err = deps.err ?? stderr;
  let flags: ReturnType<typeof readFlags>;
  try {
    if (argv.cmd.length > 1) throw new UsageError(USAGE);
    flags = readFlags(
      argv,
      { bool: ["quick", "confirm-notify", "rotate", "json"], value: ["notify-test"] },
      USAGE,
    );
    const nt = flags.value.get("notify-test");
    if (nt !== undefined && !IDENTIFIER_RE.test(nt))
      throw new UsageError(`${USAGE}\n--notify-test takes an issue identifier`);
    if (flags.bool.has("rotate") && (flags.bool.size > (flags.bool.has("json") ? 2 : 1) || flags.value.size))
      throw new UsageError(`${USAGE}\n--rotate runs on its own`);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(e.usage);
    return 2;
  }
  if (flags.bool.has("rotate")) return rotate(deps, flags.bool.has("json"), out, err);
  const ctx = await buildOps(deps, { readOnly: false, linearOptional: true });
  const nt = flags.value.get("notify-test");
  const report = await doctor(
    ctx,
    liveDoctorOptions(ctx, {
      probes: !flags.bool.has("quick"),
      ...(nt !== undefined ? { notifyTest: nt } : {}),
      ...(flags.bool.has("confirm-notify") ? { confirmNotify: true } : {}),
      ...deps.doctorOverrides,
    }),
  );
  if (flags.bool.has("json")) out(JSON.stringify(report, null, 2));
  else for (const l of renderChecks(report)) out(l);
  return report.ok ? 0 : 1;
}
