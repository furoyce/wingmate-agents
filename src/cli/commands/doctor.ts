// src/cli/commands/doctor.ts — `wingmate doctor [--quick] [--notify-test <issue>] [--confirm-notify] [--rotate] [--json]` (§13.3, §7.5).
import { type DoctorOptions, type DoctorReport, doctor } from "../../ops/doctor";
import { stop } from "../../ops/stop";
import { errorCode } from "../../shared/errors";
import { IDENTIFIER_RE } from "../../shared/ids";
import type { Argv } from "../index";
import { type OpsDeps, UsageError, buildOps, liveDoctorOptions, readFlags } from "../ops";
import { stderr, stdout } from "./tick";

const USAGE =
  "usage: wingmate doctor [--quick] [--notify-test <issue>] [--confirm-notify] [--rotate] [--json]";

/** §13.3(g): the compromise response `doctor --rotate` walks the owner through after `stop --all`. */
export const ROTATION_STEPS = [
  "1. Every agent is stopped and every active issue blocked (`wingmate stop --all`, done above).",
  "2. Linear: Settings → API → OAuth applications → Wingmate → rotate the client secret (all app tokens die with it).",
  "3. `wingmate install --client-id <id> --client-secret <new secret>` stores it (0600); the cached token was dropped above.",
  "4. GitHub: `gh auth refresh` (or revoke the token at github.com/settings/tokens and `gh auth login`).",
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

export interface DoctorCommandDeps extends OpsDeps {
  /** Merged over the live options (tests inject the command runner and the probes). */
  doctorOverrides?: Partial<DoctorOptions>;
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
  const ctx = await buildOps(deps, { readOnly: false, linearOptional: true });
  if (flags.bool.has("rotate")) {
    const report = await stop(ctx, { kind: "all" }, "credential rotation (wingmate doctor --rotate)");
    const dropped = ctx.tokens
      ? await ctx.tokens.invalidate().then(
          () => "dropped",
          (e: unknown) => `not dropped (${errorCode(e)})`,
        )
      : "no token store";
    if (flags.bool.has("json")) out(JSON.stringify({ stop: report, token: dropped }, null, 2));
    else {
      out(
        `stopped: ${report.stopped.join(", ") || "none"}; flag ${report.flagCleared ? "cleared" : "KEPT (re-run stop)"}`,
      );
      out(`cached Linear token: ${dropped}`);
      for (const s of ROTATION_STEPS) out(s);
    }
    return report.flagCleared && report.failed.length === 0 ? 0 : 1;
  }
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
