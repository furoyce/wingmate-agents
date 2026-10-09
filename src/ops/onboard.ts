// A configuration-only onboarding plan. This module never builds an operator context or reads installation/credential state.
import { ConfigPathSchema, loadConfig, selectedConfigPath } from "../config/load";
import type { Config } from "../config/schema";
import { WingmateError } from "../shared/errors";

export interface OnboardingOptions {
  project?: string;
  configPath?: string;
  cwd?: string;
}

/** These are suggestions for the trusted operator; the planner never executes them. */
export interface OnboardingStep {
  id: string;
  argv: string[];
  env: { WINGMATE_CONFIG: string };
  note: string;
}

export function onboardingPlan(config: Config, configPath: string, project?: string) {
  if (!ConfigPathSchema.safeParse(configPath).success)
    throw new WingmateError(
      "config_path_invalid",
      "onboarding requires an absolute normalized config path without control characters",
      "set WINGMATE_CONFIG to an existing project configuration file",
    );
  const configuredProjects = Object.keys(config.projects);
  if (project !== undefined && !Object.hasOwn(config.projects, project))
    throw new WingmateError(
      "onboard_project_unknown",
      `project ${JSON.stringify(project)} is not configured`,
      `choose a configured key: ${configuredProjects.map((key) => JSON.stringify(key)).join(", ")}`,
    );
  const selected = project === undefined ? configuredProjects : [project];
  const projects = selected.map((key) => {
    const p = config.projects[key];
    if (!p) throw new WingmateError("config_invalid", `project ${JSON.stringify(key)} is missing`);
    return {
      key,
      linearProject: p.linearProject,
      autonomy: p.autonomy,
      done: p.done,
      routing: structuredClone(p.routing),
      concurrency: structuredClone(p.concurrency),
      repos: Object.entries(p.repos).map(([name, repo]) => ({
        name,
        orcaRepo: repo.orcaRepo,
        github: repo.github,
        base: repo.base,
        setup: structuredClone(repo.setup),
        runtimeBinPaths: [...repo.runtimeBinPaths],
        pinnedChecks: repo.gates.map((argv) => [...argv]),
        requiredCheck: repo.requiredCheck,
        ui: {
          kind: repo.ui.kind,
          paths: [...repo.ui.paths],
          nativePolicyConfigured: repo.ui.native !== undefined,
          ...(repo.ui.kind === "ios"
            ? { limitation: "Native iOS execution requires isolated host adapters that are not implemented." }
            : {}),
        },
      })),
    };
  });
  const step = (id: string, argv: string[], note: string): OnboardingStep => ({
    id,
    argv: ["wingmate", ...argv],
    env: { WINGMATE_CONFIG: configPath },
    note,
  });
  return {
    version: 1 as const,
    readOnly: true as const,
    configPath,
    configuredProjects,
    selectedProject: project ?? null,
    projects,
    readiness: {
      configuration: "validated" as const,
      execution: "unverified" as const,
      unknowns: [
        "Orca repository mappings and GitHub/Linear access have not been checked.",
        "Runtime paths, setup dependencies and pinned check results have not been checked.",
        "Credentials, provider availability, installation and automation state have not been read.",
        "UI prerequisites and notification receipt confirmation have not been checked.",
      ],
    },
    routines: {
      dispatcher: {
        host: "Orca" as const,
        trigger: "*/5 * * * *",
        timezone: config.defaults.timezone,
        currentState: "unknown" as const,
        proposedInstallState: "disabled" as const,
        detail:
          "Plain install prepares a disabled five-minute automation; enabled ticks reconcile and dispatch configured projects.",
      },
      health: {
        mode: "manual" as const,
        detail:
          "The operator runs doctor --quick for health checks; it skips sandbox probes and does not replace full doctor.",
      },
      cleanup: {
        mode: "dispatcher" as const,
        worktreeGraceHours: config.defaults.cleanup.worktreeGraceHours,
        detail:
          "Dispatcher cleanup handles done/cancelled worktrees after the configured grace period, preserves open PRs and defers unverifiable cleanup. There is no separate cleanup CLI.",
      },
      otherHosts: {
        supported: false as const,
        detail:
          "Other automation hosts and production isolated native iOS host adapters are not implemented.",
      },
    },
    nextSteps: [
      step(
        "validate_config",
        ["config", "validate", "--file", configPath],
        "Review all configured projects and pinned checks; project selection filters this plan only.",
      ),
      step(
        "install_disabled",
        ["install"],
        "Run from an Orca-managed Wingmate checkout after privately provisioning required OAuth credentials. Install covers the selected config, not just this plan's project.",
      ),
      step(
        "quick_health",
        ["doctor", "--quick"],
        "Read operator health diagnostics; quick doctor skips sandbox probes.",
      ),
      step(
        "full_health",
        ["doctor"],
        "Run full doctor and resolve its actual blocking checks, including notification receipt confirmation when required.",
      ),
      step(
        "dry_run",
        ["tick", "--dry-run", "--json"],
        "Requires operator credentials; review eligibility without claiming tickets. Tick intentionally returns a nonzero exit code, including a successful dry run.",
      ),
      step(
        "enable_after_review",
        ["install", "--enable"],
        "Only when activation is authorized and full doctor passes. This operator action enables automation; onboarding itself never does.",
      ),
    ],
  };
}

export type OnboardingPlan = ReturnType<typeof onboardingPlan>;

/** Read only the selected configuration; do not inspect credentials, protected records, repositories or Orca. */
export async function readOnboardingPlan(options: OnboardingOptions = {}): Promise<OnboardingPlan> {
  let configPath: string;
  try {
    configPath = await selectedConfigPath(options.configPath, options.cwd);
  } catch (e) {
    if (!(e instanceof WingmateError)) throw e;
    throw new WingmateError(
      e.code,
      e.message,
      "set WINGMATE_CONFIG to an existing project configuration file",
    );
  }
  let config: Config;
  try {
    config = await loadConfig(configPath);
  } catch (e) {
    if (e instanceof WingmateError)
      throw new WingmateError(e.code, e.message, `fix the selected config file: ${configPath}`);
    // YAML parser diagnostics can echo source values. Refuse invalid YAML without reproducing its contents.
    throw new WingmateError(
      "config_invalid",
      "the selected configuration is not valid YAML",
      `fix the selected config file: ${configPath}`,
    );
  }
  return onboardingPlan(config, configPath, options.project);
}
