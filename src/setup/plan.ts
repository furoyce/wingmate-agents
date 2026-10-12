import { WingmateError } from "../shared/errors";

export const HOSTS = Object.freeze(["orca", "codex", "claude-code", "pi", "opencode"] as const);
export const CONNECTORS = Object.freeze(["linear", "github"] as const);

export type SetupHost = (typeof HOSTS)[number];
export type SetupConnector = (typeof CONNECTORS)[number];
export type SetupAnswers = {
  host: SetupHost;
  connector: SetupConnector;
  project: string;
  repo: string;
  scheduler: "orca" | "native";
};

export interface SetupPlan {
  version: 1;
  readOnly: true;
  status: "planned";
  readiness: "unverified";
  operatorHarness: SetupHost;
  issueConnector: SetupConnector;
  project: string;
  repo: string;
  backend: {
    requested: "orca" | "native";
    resolved: SetupHost;
    implemented: boolean;
    liveReady: "unknown";
  };
  connection: {
    kind: SetupConnector;
    status: "unverified" | "adapter_missing";
    detail: string;
  };
  projectSummary: {
    key: string;
    repository: string;
    created: false;
    mappings: "unverified";
    detail: string;
  };
  schedule: {
    terminology: "automations" | "scheduled tasks" | "routines" | "native scheduler (unverified)";
    host: SetupHost;
    executionEnvironment: "local Orca dispatcher" | "Codex desktop" | "Claude cloud" | "unknown";
    cadence: { cron: string | null; timezone: "project-config" | "host-config" | null; note: string };
    observed: null;
    created: false;
    enabled: null;
    detail: string;
  };
  routines: {
    dispatcher: { implemented: boolean; detail: string };
    cleanup: { implemented: boolean; detail: string };
    health: { mode: "manual"; argv: string[]; detail: string };
    audits: { implemented: false; schedule: null; detail: string };
  };
  blockers: string[];
  nextSteps: { id: string; title: string; note: string; argv?: string[] }[];
  sourceURLs: { title: string; url: string }[];
}

const KEYS = ["host", "connector", "project", "repo", "scheduler"] as const;
const PROJECT = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
const CONTROLS = /\p{Cc}/u;

function invalid(message: string): never {
  throw new WingmateError(
    "setup_input_invalid",
    message,
    "Use the listed harness, connector and scheduler values, a lowercase project slug, and owner/repository.",
  );
}

function validate(input: SetupAnswers): void {
  if (!input || typeof input !== "object" || Array.isArray(input))
    invalid("Setup answers must be an object with host, connector, project, repo and scheduler.");
  if (Object.keys(input).some((key) => !KEYS.includes(key as keyof SetupAnswers)))
    invalid("Setup answers contain an unknown field.");
  for (const key of KEYS) {
    if (!Object.hasOwn(input, key)) invalid(`Setup ${key} is required as an explicit field.`);
    validateSetupAnswer(key, input[key]);
  }
}

/** Shared by interactive questions and complete plans so a bad answer can be retried in place. */
export function validateSetupAnswer(key: keyof SetupAnswers, value: unknown): asserts value is string {
  if (typeof value !== "string" || CONTROLS.test(value))
    invalid(`Setup ${key} must be a string without control characters.`);
  if (key === "host" && !HOSTS.includes(value as SetupHost)) invalid("Choose a listed operator harness.");
  if (key === "connector" && !CONNECTORS.includes(value as SetupConnector))
    invalid("Choose Linear or GitHub as the issue connector.");
  if (key === "scheduler" && value !== "orca" && value !== "native")
    invalid("Choose Orca or native as the scheduler.");
  if (
    key === "project" &&
    (value.length > 64 || !PROJECT.test(value) || value === "constructor" || value === "prototype")
  )
    invalid("The project key must be a safe lowercase slug, at most 64 characters, such as my-app.");
  if (key !== "repo") return;
  const parts = value.split("/");
  const [owner, repo] = parts;
  if (
    parts.length !== 2 ||
    !owner ||
    !OWNER.test(owner) ||
    !repo ||
    !REPOSITORY.test(repo) ||
    repo === "." ||
    repo === ".."
  )
    invalid("The repository must be a GitHub owner/repository name, without a URL or shell syntax.");
}

function schedule(host: SetupHost): SetupPlan["schedule"] {
  const base = { host, observed: null, created: false, enabled: null } as const;
  switch (host) {
    case "orca":
      return {
        ...base,
        terminology: "automations",
        executionEnvironment: "local Orca dispatcher",
        cadence: {
          cron: "*/5 * * * *",
          timezone: "project-config",
          note: "Proposed installer cadence for the one shared dispatcher; the real timezone comes from reviewed configuration. No live schedule has been observed.",
        },
        detail:
          "Orca automations can run the implemented local dispatcher. Multiple projects and operator harnesses share this automation; setup does not create a second schedule.",
      };
    case "claude-code":
      return {
        ...base,
        terminology: "routines",
        executionEnvironment: "Claude cloud",
        cadence: {
          cron: "0 * * * *",
          timezone: "host-config",
          note: "Proposed hourly routine, respecting the host's minimum hourly frequency. This is a plan, not an observed or created routine.",
        },
        detail:
          "Claude routines run in the cloud. Wingmate's routine/execution adapter is missing; the local Orca tick cannot be copied into a routine. Claude's /schedule entrypoint is host guidance, not a public Wingmate CRUD API.",
      };
    case "codex":
      return {
        ...base,
        terminology: "scheduled tasks",
        executionEnvironment: "Codex desktop",
        cadence: {
          cron: null,
          timezone: "host-config",
          note: "The owner chooses the requested cadence in the desktop host. No fixed or live schedule is assumed.",
        },
        detail:
          "Codex scheduled tasks need a desktop scheduling/execution adapter. Wingmate has not implemented native task creation, discovery or lifecycle binding.",
      };
    case "pi":
    case "opencode":
      return {
        ...base,
        terminology: "native scheduler (unverified)",
        executionEnvironment: "unknown",
        cadence: {
          cron: null,
          timezone: null,
          note: "Native scheduling capabilities and cadence are unverified.",
        },
        detail:
          "No native scheduler or execution adapter is supplied for this harness. Setup does not infer host capabilities or create jobs.",
      };
  }
}

/** Public, credential-free planning only. Never loads config, state, a host or a connector. */
export function setupPlan(input: SetupAnswers): SetupPlan {
  validate(input);
  const backend = input.scheduler === "orca" || input.host === "orca" ? "orca" : input.host;
  const orca = backend === "orca";
  const supported = orca && input.connector === "linear";
  const blockers: string[] = [];
  if (!orca)
    blockers.push(
      `${backend} native scheduling and execution adapters are not implemented. They must establish trusted runtime access, durable ownership, launch/cancellation and result evidence before live installation.`,
    );
  if (input.connector === "github")
    blockers.push(
      "GitHub repository and pull-request publication are supported, but GitHub issue intake is not implemented. A real issue-source adapter is required; do not invent Linear project or issue IDs.",
    );

  const nextSteps: SetupPlan["nextSteps"] = supported
    ? [
        {
          id: "config-inputs",
          title: "Draft a separate owner configuration",
          note: `Obtain real Linear workspace, owner/approver and project UUIDs, Orca repository UUIDs, routing and pinned setup/check argv for ${input.project} (${input.repo}). Follow the onboarding guide for the starter asset, prerequisites, labels, private OAuth setup and UI validation. Set WINGMATE_CONFIG to a reviewed absolute draft path in each operator shell. Preserve existing mappings and pause state; editing a live config affects enabled ticks. This selection neither creates a project nor chooses the worker provider.`,
          argv: ["wingmate", "onboard", "--guide"],
        },
        {
          id: "validate-config",
          title: "Validate the selected draft",
          note: "Set WINGMATE_CONFIG first. Validation checks the full configuration without connecting or establishing execution readiness.",
          argv: ["wingmate", "config", "validate"],
        },
        {
          id: "onboard-project",
          title: "Inspect project routing and pinned checks",
          note: "The project flag filters this read-only plan. Install and enable act on the entire selected configuration.",
          argv: ["wingmate", "onboard", "--project", input.project, "--json"],
        },
        {
          id: "install-disabled",
          title: "Prepare the Orca dispatcher disabled",
          note: "After the guide's prerequisites and private credential setup, run from the registered Wingmate source checkout with the reviewed config selected and installation authorized. Plain install prepares or updates the one shared automation disabled; it can disable an existing automation. It does not activate this plan.",
          argv: ["wingmate", "install"],
        },
        {
          id: "doctor",
          title: "Run full readiness checks",
          note: "Full doctor may launch bounded provider/sandbox probes. Resolve the actual blocking checks, notification receipt requirements and required UI/toolchain acceptance; quick doctor is a manual health check, not a readiness substitute.",
          argv: ["wingmate", "doctor"],
        },
        {
          id: "first-issue",
          title: "Review a small first Linear issue",
          note: "Use a real issue in the configured Linear project with clear acceptance criteria and Todo state. A configured approver adds an admitted Agent label. With installation disabled, inspect dry-run intake and all skip reasons; eligibility is not launch proof.",
          argv: ["wingmate", "scan", "--dry-run", "--json"],
        },
        {
          id: "authorized-enable",
          title: "Enable only when activation is authorized",
          note: "Only when activation is authorized and full doctor plus configured acceptance requirements pass. This enables every project in the reviewed selected config. Preserve prior pause/automation decisions and do not create duplicate host schedules.",
          argv: ["wingmate", "install", "--enable"],
        },
      ]
    : [
        {
          id: "adapter-design",
          title: "Resolve the missing adapters",
          note: "This combination is a design plan only. Supply and validate the missing issue-source and/or scheduling/execution adapters before requesting installation or activation. Current install is Orca/Linear-specific; no native job or GitHub intake recipe is available.",
        },
        {
          id: "supported-alternative",
          title: "Choose the implemented Orca and Linear path if appropriate",
          note: "Any listed harness may serve as the operator frontend when it can access the local CLI. Re-plan with Orca scheduling and Linear intake; that still requires real reviewed config, credentials and readiness evidence.",
        },
      ];

  return {
    version: 1,
    readOnly: true,
    status: "planned",
    readiness: "unverified",
    operatorHarness: input.host,
    issueConnector: input.connector,
    project: input.project,
    repo: input.repo,
    backend: {
      requested: input.scheduler,
      resolved: backend,
      implemented: orca,
      liveReady: "unknown",
    },
    connection: {
      kind: input.connector,
      status: input.connector === "linear" ? "unverified" : "adapter_missing",
      detail:
        input.connector === "linear"
          ? "Linear intake is implemented but no account, permission, project mapping or notification has been inspected or connected. Obtain real IDs and private credentials through the supported onboarding workflow."
          : "GitHub repository/PR support does not imply GitHub issue intake. No issue connection or fictional Linear mapping is created.",
    },
    projectSummary: {
      key: input.project,
      repository: input.repo,
      created: false,
      mappings: "unverified",
      detail:
        "Desired project/repository only; no checkout, registration, issue, config mapping or pinned check has been inspected or created.",
    },
    schedule: schedule(backend),
    routines: {
      dispatcher: {
        implemented: supported,
        detail: supported
          ? "The shared Orca dispatcher performs issue intake, reconciliation, gate/review progression and liveness watchdog work under configured policy. Its installation, running state and schedule are unknown here."
          : "Issue dispatch for this selected combination is blocked by the missing adapters.",
      },
      cleanup: {
        implemented: supported,
        detail: supported
          ? "Lifecycle cleanup is integrated into the same dispatcher, with conservative ownership, worker/content and PR guards. A read-only cleanup dry run is available after configuration; generic orphan sweeping is not installed."
          : "No cleanup job is installed; an execution adapter must prove exact owned resources and safe recovery before lifecycle cleanup can operate.",
      },
      health: {
        mode: "manual",
        argv: ["wingmate", "doctor", "--quick", "--json"],
        detail:
          "Manual health inspection for a configured local Orca installation; no recurring health job is created, and quick checks do not prove readiness.",
      },
      audits: {
        implemented: false,
        schedule: null,
        detail:
          "Separate scheduled repository/dependency audits, a generic worktree sweeper and per-project maintenance schedules are future work; no audit jobs or counts are observed.",
      },
    },
    blockers,
    nextSteps,
    sourceURLs:
      backend === "claude-code"
        ? [{ title: "Claude routines", url: "https://code.claude.com/docs/en/routines" }]
        : backend === "codex"
          ? [{ title: "Codex automations", url: "https://learn.chatgpt.com/docs/automations" }]
          : [],
  };
}
