import type { OnboardingPlan } from "../../ops/onboard";
import { readOnboardingPlan } from "../../ops/onboard";
import { WingmateError } from "../../shared/errors";
import type { Argv } from "../index";
import { UsageError, readFlags } from "../ops";

const USAGE = "usage: wingmate onboard [--project KEY] [--json]";
export interface OnboardCommandDeps {
  plan?: (options: { project?: string }) => Promise<OnboardingPlan>;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/** Quoted suggestions only, never passed to a shell by this command. */
const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
const commandLine = (step: OnboardingPlan["nextSteps"][number]) =>
  `WINGMATE_CONFIG=${quote(step.env.WINGMATE_CONFIG)} ${step.argv.map(quote).join(" ")}`;

export async function onboardCommand(argv: Argv, deps: OnboardCommandDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  let flags: ReturnType<typeof readFlags>;
  try {
    if (argv.cmd.length !== 1) throw new UsageError(USAGE);
    flags = readFlags(argv, { bool: ["json"], value: ["project"] }, USAGE);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(e.usage);
    return 2;
  }
  const json = flags.bool.has("json");
  let plan: OnboardingPlan;
  try {
    const project = flags.value.get("project");
    plan = await (deps.plan ?? readOnboardingPlan)(project === undefined ? {} : { project });
  } catch (e) {
    const failure =
      e instanceof WingmateError
        ? e
        : new WingmateError("internal_error", "onboarding could not read the selected configuration");
    if (json) out(JSON.stringify({ ok: false, ...failure.toJSON() }));
    else err(`${failure.code}: ${failure.message}${failure.nextStep ? `\n  next: ${failure.nextStep}` : ""}`);
    return 2;
  }
  if (json) out(JSON.stringify(plan, null, 2));
  else {
    out(`Onboarding plan (read-only): ${JSON.stringify(plan.configPath)}`);
    out("Configuration validated; execution readiness is unverified.");
    for (const p of plan.projects) {
      out(`Project ${JSON.stringify(p.key)}: ${p.autonomy}, done=${p.done}`);
      out(`  routing: ${JSON.stringify(p.routing)}`);
      for (const repo of p.repos) {
        out(
          `  repo ${JSON.stringify(repo.name)}: ${repo.github}, Orca ${repo.orcaRepo}, base ${JSON.stringify(repo.base)}`,
        );
        out(
          `    setup: ${JSON.stringify(repo.setup)}; runtime bin paths: ${JSON.stringify(repo.runtimeBinPaths)}`,
        );
        out(
          `    pinned checks: ${JSON.stringify(repo.pinnedChecks)}; required remote check: ${JSON.stringify(repo.requiredCheck)}`,
        );
        out(`    UI: ${JSON.stringify(repo.ui)}`);
      }
    }
    for (const routine of Object.values(plan.routines)) out(routine.detail);
    out(`Cleanup grace: ${plan.routines.cleanup.worktreeGraceHours} hours.`);
    for (const unknown of plan.readiness.unknowns) out(`Unverified: ${unknown}`);
    for (const step of plan.nextSteps) {
      out(`Next: ${commandLine(step)}`);
      out(`  ${step.note}`);
    }
  }
  return 0;
}
