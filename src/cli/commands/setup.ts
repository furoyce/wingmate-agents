import { createInterface } from "node:readline";
import { type SetupAnswers, type SetupPlan, setupPlan, validateSetupAnswer } from "../../setup/plan";
import { WingmateError } from "../../shared/errors";
import type { Argv } from "../index";
import { UsageError, readFlags } from "../ops";

type AnswerKey = keyof SetupAnswers;
export interface SetupQuestion {
  id: AnswerKey;
  title: string;
  options?: readonly { value: string; label: string; labelsByHost?: Readonly<Record<string, string>> }[];
}

/** Also exposed as JSON for a skill or future plugin to ask the same questions. */
export const SETUP_QUESTIONS: readonly SetupQuestion[] = [
  {
    id: "host",
    title: "Which harness are you using?",
    options: [
      { value: "orca", label: "Orca" },
      { value: "codex", label: "Codex (desktop or CLI)" },
      { value: "claude-code", label: "Claude Code" },
      { value: "pi", label: "Pi" },
      { value: "opencode", label: "OpenCode" },
    ],
  },
  {
    id: "connector",
    title: "Where will your issues come from?",
    options: [
      { value: "linear", label: "Linear (implemented)" },
      { value: "github", label: "GitHub Issues (adapter planned)" },
    ],
  },
  { id: "project", title: "Choose a project key, for example my-app" },
  { id: "repo", title: "Which GitHub repository, in owner/repository form?" },
  {
    id: "scheduler",
    title: "Where should the recurring jobs run?",
    options: [
      { value: "orca", label: "Orca automations (implemented)" },
      {
        value: "native",
        label: "Selected harness's native scheduler (adapter pending outside Orca)",
        labelsByHost: {
          orca: "Orca automations (implemented)",
          codex: "Codex desktop scheduled tasks (adapter planned)",
          "claude-code": "Claude Code cloud routines, hourly or slower (adapter planned)",
          pi: "Pi native scheduler (capability unverified)",
          opencode: "OpenCode native scheduler (capability unverified)",
        },
      },
    ],
  },
];

const USAGE =
  "usage: wingmate setup [--host orca|codex|claude-code|pi|opencode] [--connector linear|github] [--project KEY] [--repo OWNER/REPO] [--scheduler orca|native] [--json]\n       wingmate setup --questions [--json]";

export interface SetupCommandDeps {
  interactive?: boolean;
  ask?: (question: SetupQuestion) => Promise<string | null>;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

export function renderSetupPlan(plan: SetupPlan): string {
  return [
    "Wingmate setup plan — no connections, projects or jobs have been created",
    `Harness: ${plan.operatorHarness}`,
    `Issue connector: ${plan.issueConnector}`,
    `Project: ${plan.project} (${plan.repo})`,
    `Scheduler: ${plan.backend.resolved} (${plan.schedule.terminology})`,
    `Readiness: ${plan.readiness}; observed schedule: unknown`,
    `Connection: ${plan.connection.status}. ${plan.connection.detail}`,
    "",
    "Schedule layout:",
    `- Dispatch: ${plan.schedule.cadence.cron ?? "cadence not selected"}; timezone from ${plan.schedule.cadence.timezone ?? "unverified host"}`,
    `- Execution: ${plan.schedule.executionEnvironment}`,
    `- Cleanup: ${plan.routines.cleanup.implemented ? "integrated into the dispatcher" : "requires the missing adapters"}`,
    "- Health: on-demand checks for a configured Orca installation",
    "- Repository/dependency audits: not scheduled",
    plan.schedule.cadence.note,
    plan.schedule.detail,
    "",
    ...(plan.blockers.length
      ? ["Before this combination can run:", ...plan.blockers.map((s) => `- ${s}`), ""]
      : []),
    "Next steps:",
    ...plan.nextSteps.flatMap((step) => [
      `- ${step.title}: ${step.note}`,
      ...(step.argv ? [`  ${step.argv.map(quote).join(" ")}`] : []),
    ]),
    ...plan.sourceURLs.map((source) => `${source.title}: ${source.url}`),
  ].join("\n");
}

/** Readline is allocated only for an explicit/bare interactive setup, never for worker commands. */
function terminalQuestions() {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const lines = rl[Symbol.asyncIterator]();
  const cancel = () => rl.close();
  rl.on("SIGINT", cancel);
  return {
    async ask(question: SetupQuestion): Promise<string | null> {
      process.stderr.write(`\n${question.title}\n`);
      question.options?.forEach((option, index) => {
        process.stderr.write(`  ${index + 1}. ${option.label}\n`);
      });
      process.stderr.write("> ");
      const line = await lines.next();
      return line.done ? null : line.value;
    },
    close() {
      rl.off("SIGINT", cancel);
      rl.close();
    },
  };
}

export async function setupCommand(argv: Argv, deps: SetupCommandDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => process.stdout.write(`${s}\n`));
  const err = deps.err ?? ((s: string) => process.stderr.write(`${s}\n`));
  let flags: ReturnType<typeof readFlags>;
  try {
    if (argv.cmd.length !== 1) throw new UsageError(USAGE);
    flags = readFlags(
      argv,
      {
        bool: ["json", "questions"],
        value: ["host", "connector", "project", "repo", "scheduler"],
      },
      USAGE,
    );
    if (flags.bool.has("questions") && flags.value.size) throw new UsageError(USAGE);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(e.usage);
    return 2;
  }
  if (flags.bool.has("questions")) {
    out(
      flags.bool.has("json")
        ? JSON.stringify(
            { format: "wingmate-setup-questions/v1", readOnly: true, questions: SETUP_QUESTIONS },
            null,
            2,
          )
        : SETUP_QUESTIONS.map(
            (q) =>
              `${q.title}${q.options ? `\n${q.options.map((o) => `  ${o.value}: ${o.label}`).join("\n")}` : ""}`,
          ).join("\n\n"),
    );
    return 0;
  }

  const answers: Record<string, string> = Object.fromEntries(flags.value);
  try {
    for (const [key, value] of flags.value) validateSetupAnswer(key as AnswerKey, value);
  } catch (e) {
    if (!(e instanceof WingmateError)) throw e;
    err(`${e.code}: ${e.message}`);
    return 2;
  }
  if (answers.host === "orca" && !answers.scheduler) answers.scheduler = "orca";
  const interactive =
    !flags.bool.has("json") && (deps.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY));
  const missing = SETUP_QUESTIONS.filter((q) => !answers[q.id]);
  if (missing.length && !interactive) {
    err(
      `${USAGE}\nMissing: ${missing.map((q) => `--${q.id}`).join(", ")}. Run interactively, or use setup --questions --json from your agent.`,
    );
    return 2;
  }
  const terminal = interactive && missing.length && !deps.ask ? terminalQuestions() : undefined;
  const ask = deps.ask ?? terminal?.ask;
  try {
    if (missing.length)
      err("Wingmate first-run setup. This prepares a plan only. Press Ctrl-C or enter q to cancel.");
    for (const original of missing) {
      const q: SetupQuestion = {
        ...original,
        ...(original.options
          ? {
              options: original.options.map((option) => ({
                ...option,
                label: option.labelsByHost?.[answers.host ?? ""] ?? option.label,
              })),
            }
          : {}),
      };
      if (q.id === "scheduler" && answers.host === "orca") {
        answers.scheduler = "orca";
        continue;
      }
      for (;;) {
        const answer = await ask?.(q);
        if (answer === undefined || answer === null || answer.trim().toLowerCase() === "q") {
          err("Setup cancelled; no changes made.");
          return 130;
        }
        const trimmed = answer.trim();
        const option = q.options?.find((o, i) => o.value === trimmed || String(i + 1) === trimmed);
        if (!trimmed || (q.options && !option)) {
          err(q.options ? "Choose one of the listed numbers or values." : "Enter a value, or q to cancel.");
          continue;
        }
        const value = option?.value ?? trimmed;
        try {
          validateSetupAnswer(q.id, value);
        } catch (e) {
          if (!(e instanceof WingmateError)) throw e;
          err(e.message);
          continue;
        }
        answers[q.id] = value;
        break;
      }
    }
    const plan = setupPlan(answers as unknown as SetupAnswers);
    out(flags.bool.has("json") ? JSON.stringify(plan, null, 2) : renderSetupPlan(plan));
    return 0;
  } catch (e) {
    if (!(e instanceof WingmateError)) throw e;
    err(`${e.code}: ${e.message}`);
    return 2;
  } finally {
    terminal?.close();
  }
}
