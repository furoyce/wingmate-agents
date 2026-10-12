import { type PackageFormat, exportPackage, packageInfo } from "../../package/bundle";
import { installSkill } from "../../package/install";
import { currentCli, launchOnboardingAgent, onboardingHandoff } from "../../package/start";
import { type SetupHost, validateSetupAnswer } from "../../setup/plan";
import { type Argv, parseArgv } from "../index";
import { UsageError, readFlags } from "../ops";
import { setupCommand } from "./setup";
import { stderr, stdout } from "./tick";

const USAGE =
  "usage: wingmate package info [--format skill|codex] [--json] | wingmate package export --out <new-directory> [--format skill|codex] [--json]\n       wingmate package install --host <host> [--skills-dir <parent-directory>] [--json]";

export interface PackageCommandDeps {
  out?: (s: string) => void;
  err?: (s: string) => void;
  export?: typeof exportPackage;
  install?: typeof installSkill;
  setup?: typeof setupCommand;
  interactive?: boolean;
  cli?: string[];
  launchAgent?: typeof launchOnboardingAgent;
}

export async function packageCommand(argv: Argv, deps: PackageCommandDeps = {}): Promise<number> {
  const out = deps.out ?? stdout;
  const err = deps.err ?? stderr;
  let flags: ReturnType<typeof readFlags>;
  const action = argv.cmd[1];
  try {
    if (argv.cmd.length !== 2 || !["info", "export", "install"].includes(action ?? ""))
      throw new UsageError(USAGE);
    flags = readFlags(
      argv,
      { bool: ["json"], value: action === "install" ? ["host", "skills-dir"] : ["out", "format"] },
      USAGE,
    );
    if (action === "install") {
      if (!flags.value.has("host")) throw new UsageError(USAGE);
    } else {
      if ((action === "export") !== flags.value.has("out")) throw new UsageError(USAGE);
      if (flags.value.has("format") && !["skill", "codex"].includes(flags.value.get("format") as string))
        throw new UsageError(USAGE);
    }
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(e.usage);
    return 2;
  }
  if (action === "install") {
    const host = flags.value.get("host");
    validateSetupAnswer("host", host);
    const skillsDir = flags.value.get("skills-dir");
    const result = await (deps.install ?? installSkill)({
      host: host as SetupHost,
      ...(skillsDir === undefined ? {} : { skillsDir }),
    });
    const setupArgs = ["setup", "--host", host];
    const onboarding = onboardingHandoff(host as SetupHost, result.directory, deps.cli ?? currentCli());
    if (flags.bool.has("json")) {
      out(JSON.stringify({ ...result, onboarding }, null, 2));
      return 0;
    }
    out(`Installed Wingmate skill: ${result.directory}`);
    out(`Wingmate CLI argv for this installation: ${JSON.stringify(onboarding.cli)}`);
    const interactive = deps.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (interactive && onboarding.agentCommand) {
      out(
        `Starting ${onboarding.agentCommand[0]} to guide project installation. Its normal login and permission controls apply.`,
      );
      let code: number;
      try {
        code = await (deps.launchAgent ?? launchOnboardingAgent)(onboarding.agentCommand);
      } catch {
        err(
          `The skill is installed, but ${onboarding.agentCommand[0]} could not start. Open your agent, load ${onboarding.skill}, and ask it to finish Wingmate onboarding using CLI argv ${JSON.stringify(onboarding.cli)}.`,
        );
        return 2;
      }
      out(
        "The skill remains installed. Resume by asking your agent to use the installed skill and CLI shown above. Agent exit alone does not verify project installation or schedule activation; use its reported evidence.",
      );
      return code;
    }
    if (interactive) {
      out("Starting guided setup. The skill is installed; project and automation setup follows.");
      const code = await (deps.setup ?? setupCommand)(parseArgv(setupArgs), {
        interactive: true,
        out,
        err,
      });
      if (code !== 0) {
        err(
          `The skill remains installed. Resume using CLI argv ${JSON.stringify(onboarding.command)}, or have your agent read ${onboarding.skill} and continue installation.`,
        );
        return code;
      }
      out(
        "Continue with your agent: use the installed Wingmate skill to complete the plan's supported installation steps and readiness checks. Projects and jobs are not created by the setup plan.",
      );
    } else {
      out(
        `Onboarding is pending. Have your current agent load ${onboarding.skill} and continue installation using CLI argv ${JSON.stringify(onboarding.cli)}. For terminal questions, run argv ${JSON.stringify(onboarding.command)}. Use --json for the complete machine-readable handoff.`,
      );
    }
    return 0;
  }
  const format = (flags.value.get("format") ?? "skill") as PackageFormat;
  if (action === "export") {
    const result = await (deps.export ?? exportPackage)(flags.value.get("out") as string, format);
    out(
      flags.bool.has("json")
        ? JSON.stringify(result, null, 2)
        : `Exported Wingmate ${result.version}: ${result.directory}\nEntrypoint: ${result.entrypoint}\nNo host installation or automation change.`,
    );
  } else {
    const info = packageInfo(format);
    out(
      flags.bool.has("json")
        ? JSON.stringify(info, null, 2)
        : `Wingmate ${info.version}\nPortable skill and CLI interface; managed execution and scheduling require Orca.\nUse package install --host codex|claude-code to install the skill and start setup, or package export --out <new-directory> to create a bundle.`,
    );
  }
  return 0;
}
