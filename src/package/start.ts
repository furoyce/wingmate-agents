import { spawn } from "node:child_process";
import type { SetupHost } from "../setup/plan";

/** Preserve access when the executable is not on the next agent's PATH. */
export function currentCli(): string[] {
  return Bun.main.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, Bun.main];
}

export function onboardingHandoff(host: SetupHost, directory: string, cli: string[]) {
  const skill = `${directory}/SKILL.md`;
  const prompt = [
    "Use the Wingmate skill to complete my initial Wingmate installation and project onboarding.",
    `Read the installed skill at this JSON-encoded path: ${JSON.stringify(skill)}.`,
    `Invoke the Wingmate CLI using this exact argv prefix (append command arguments): ${JSON.stringify(cli)}.`,
    `Known operator harness: ${host}. Reuse these and other known choices; ask only for missing inputs.`,
    "Run setup --questions --json, prepare the selected setup plan, then follow the bundled onboarding guide through real configuration, supported backend installation and full readiness checks within my installation request.",
    "Keep credentials out of chat. Preserve existing projects, user choices and automation state. Activation still needs my authorization and passing checks. If a required input or adapter is missing, report that exact blocker and continue independent setup work.",
    "Do not stop after printing capabilities or the setup plan. Report separately whether the skill is installed, the project is configured, the backend is installed and the schedule is enabled, using actual evidence.",
  ].join("\n");
  const executable = host === "codex" ? "codex" : host === "claude-code" ? "claude" : null;
  return {
    state: "pending" as const,
    skill,
    cli,
    knownAnswers: { host },
    command: [...cli, "setup", "--host", host],
    questions: [...cli, "setup", "--questions", "--json"],
    guide: [...cli, "onboard", "--guide", "--json"],
    prompt,
    agentCommand: executable ? [executable, prompt] : null,
    instruction:
      "Installer agent: continue onboarding now in this conversation using this prompt; do not launch a nested agent. A terminal user can start the indicated agentCommand, or load the skill in their existing agent. The skill is installed; project/backend installation and schedule activation remain unverified.",
  };
}

/** Interactive only. No shell expansion, injected flags, approval bypass or background daemon. */
export function launchOnboardingAgent(argv: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0] as string, argv.slice(1), { stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 2)));
  });
}
