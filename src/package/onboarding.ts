// Embedded public guidance only: no config, credentials, filesystem or host access.
const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

export const ONBOARDING_GUIDE = freeze({
  format: "wingmate-onboarding-guide/v1",
  readOnly: true,
  configurationRequired: false,
  executionBackend: "orca",
  title: "Wingmate new-user onboarding",
  summary:
    "An early technical release for Linear intake, Orca-managed agents and GitHub pull requests. This guide describes steps; it does not execute them or establish machine readiness. GitHub issue ingestion and native Orca plugin installation are not shipped.",
  prerequisites: [
    "On first launch, run wingmate with no arguments in a terminal, or wingmate setup, to choose harness, issue connector, project and scheduler. Agents can use wingmate setup --questions --json and supply the answers as flags. That plan reports adapter gaps; the detailed installation steps below cover the currently implemented Orca and Linear path.",
    "Local macOS, Git and Bun 1.4.2 or later; build the CLI and use package install --host codex or --host claude-code to install the skill and launch guided agent setup. Agent-driven installs use --json and continue in the same conversation. Managed execution additionally needs running Orca, its CLI, GitHub authentication and the configured provider accounts/CLIs.",
    "Commands below are examples, not a script to run all at once. Replace uppercase placeholders and example absolute paths with verified owner values. Never invent IDs, request secrets in chat or place credentials in project/skill files.",
  ],
  interfaces: [
    {
      name: "Orca",
      guidance:
        "Use the skill in an Orca agent and the CLI/Command Center. Orca owns the single shared five-minute dispatcher schedule.",
    },
    {
      name: "Local Codex or Claude Code",
      guidance:
        "Install the portable skill in the host's documented skill directory. It controls the same Orca-backed CLI; Wingmate does not create a separate Codex scheduled task or Claude routine. Operator and worker choices are separate: the starter uses Claude for writable work, even when Codex is the operator. Review the runbook's isolation limits before widening providers.",
    },
    {
      name: "Other agents or cloud sessions",
      guidance:
        "An agent may read the exported skill and invoke an accessible CLI. Managed execution/credential isolation adapters are not supplied for every host; a hosted session needs explicit access to the execution environment.",
    },
  ],
  steps: [
    {
      id: "interface",
      title: "Check the interface and installation",
      guidance:
        "Have your agent load the Wingmate skill and identify the CLI it will use. The capability manifest describes implementation, not current installation health.",
      requiredInputs: ["Installed skill path and Wingmate executable path accessible to this agent."],
      commands: ["wingmate package info --json"],
      stopConditions: [
        "If the skill or CLI is missing, follow README installation first. Do not substitute a native plugin or create a competing host schedule.",
      ],
    },
    {
      id: "repositories",
      title: "Connect the real repositories",
      guidance:
        "Check existing Orca registrations first. Register only missing repositories, including the Wingmate source checkout and each target repository. Obtain their actual Orca repository UUIDs from Orca; retain existing registrations.",
      requiredInputs: [
        "Stable absolute Wingmate checkout path; target checkout paths; GitHub owner/repository names and base refs; actual Orca repository UUIDs.",
      ],
      commands: [
        "orca status --json",
        "gh auth status",
        "orca repo list --json",
        "orca repo add --path /absolute/path/to/repository",
      ],
      stopConditions: [
        "If Orca, repository identity or GitHub access is unavailable, resolve that input before live installation.",
      ],
    },
    {
      id: "configuration",
      title: "Add a project to the owner's configuration",
      guidance:
        "For a new installation, export the package and copy skills/wingmate/assets/projects.example.yaml to a new owner-selected absolute config path without overwriting anything. Replace every placeholder with verified values; the example is deliberately invalid until completed. The checked-in config contains pilot-specific values. For an existing installation, locate its selected config and draft an additive copy that preserves all workspace mappings/projects/settings, adding projects.PROJECT_KEY. Validate the draft separately. Editing the live selected file affects subsequent enabled ticks without reinstalling; review rollout before publishing it. If rollout needs a pause, preserve existing pause/automation state and use authorized operator controls rather than automatically resuming everything. There is no project-add wizard. Linear issues, agent assignments, runs and worktrees are subsequently discovered or created by the lifecycle, not manually inserted into state files.",
      requiredInputs: [
        "workspace.linearWorkspace, team, owner and approvers: real Linear workspace/user UUIDs and team key; labels: matching Agent/Lifecycle groups, supported provider labels and human/allow-deps labels.",
        "projects.PROJECT_KEY.linearProject: real Linear project UUID; repos: actual Orca/GitHub mappings; routing.default and routing.rules: existing repository keys.",
        "Repository setup and nonempty gates as argv arrays, requiredCheck, runtimeBinPaths, package roots, UI kind/paths/dev URL or native validation policy, and necessary network/build permissions.",
        "Timezone, available providers/coordinator cascade, autonomy, delivery boundary (review/merge/deploy), budgets and concurrency. Preserve the owner's choices; a configured provider still needs role and sandbox admission.",
      ],
      commands: ["export WINGMATE_CONFIG=/absolute/path/to/projects.yaml"],
      stopConditions: [
        "Missing IDs, approvers, routing or validation commands need real owner/source input. Do not overwrite an existing configuration, copy pilot IDs or weaken gates to make validation pass.",
        "For an existing installation, use its recorded install output/receipt to identify the selected config path. Set WINGMATE_CONFIG in each operator shell (or your shell profile); install pins the canonical path for the automation but does not configure your shell. A second project does not need another schedule. If you reinstall for its preparation or switch config paths, plain install disables the shared automation; restore only the previously authorized state after readiness checks.",
      ],
    },
    {
      id: "plan",
      title: "Validate and review the onboarding plan",
      guidance:
        "Review the selected project and the entire configuration before installation. The project flag filters this offline plan only: installation and activation cover the whole selected configuration. Neither command verifies credentials, runs gates or installs anything.",
      requiredInputs: [
        "Existing configuration at WINGMATE_CONFIG and the exact project key added or selected above.",
      ],
      commands: ["wingmate config validate", "wingmate onboard --project PROJECT_KEY --json"],
      stopConditions: [
        "Resolve invalid config, unintended project changes or unknown execution requirements before preparing the shared dispatcher.",
      ],
    },
    {
      id: "install",
      title: "Prepare the shared automation, disabled",
      guidance:
        "Follow the Linear setup guide for the private client-credentials app, exact labels and Todo/In Progress/In Review states, substituting your team for the pilot team. From the registered Wingmate source checkout, keep the absolute WINGMATE_CONFIG selected. On macOS, the owner privately copies the client secret then pipes it from the clipboard to stdin. Later installs can use wingmate install with stored credentials. Install prepares repository settings and saved views, builds the dispatcher and leaves its automation disabled; plain reinstall also disables an existing automation.",
      requiredInputs: [
        "Owner's OAuth client ID; client secret supplied privately on stdin, never in chat or command arguments; reviewed config and installation authorization.",
      ],
      commands: [
        "pbpaste | wingmate install --client-id ACTUAL_CLIENT_ID --client-secret -",
        "pbcopy </dev/null",
        'export PATH="$HOME/.local/bin:$PATH"',
      ],
      stopConditions: [
        "Do not proceed with missing OAuth access, unintended configuration scope or failed installation checks. Installing the skill alone does not install credentials or enable automation.",
      ],
    },
    {
      id: "readiness",
      title: "Verify providers, validation and notifications",
      guidance:
        "Run full doctor from the trusted Wingmate checkout; it can launch sandbox/provider probes. Resolve its actual blockers and repository UI/toolchain requirements. Finish the saved views and subscribe to Needs you per the setup guide. Use a scratch issue that Wingmate is not working on for the notification test, which posts a comment and adds Needs-Human. Run confirm-notify only after the owner reports receiving both the comment/mention and view notifications, then tidy the scratch issue and rerun full doctor.",
      requiredInputs: [
        "Usable configured providers/toolchains/UI validation environment; real scratch Linear issue identifier; actual owner notification receipt.",
      ],
      commands: [
        "wingmate doctor",
        "wingmate doctor --notify-test ACTUAL_SCRATCH_ISSUE_ID",
        "wingmate doctor --confirm-notify",
        "wingmate doctor",
      ],
      stopConditions: [
        "doctor --quick does not replace full readiness checks. Missing native UI execution evidence, failed probes or unreceived notifications remain blockers; do not mark them passed.",
      ],
    },
    {
      id: "first_issue",
      title: "Prepare the first issue and inspect intake",
      guidance:
        "Create or select a small issue in the configured Linear project, write its acceptance criteria, and use Todo (unstarted). A signed-in configured approver adds one supported Agent-group label in Linear for an admitted coordinator. Remove no ownership or blocking evidence merely to queue it: existing active ownership, veto lifecycle labels, open children or prerequisites can defer intake. Keep the new installation disabled while reviewing the scan; the scan needs credentials and may write local diagnostic evidence but does not claim issues.",
      requiredInputs: [
        "Real Linear issue in the configured project; clear requirements; configured approver and supported label; resolved prerequisites.",
      ],
      commands: ["wingmate scan --dry-run --json"],
      stopConditions: [
        "Inspect reported skip/error reasons. Scan exit 0 means it would act, 1 means idle, and 2 means error; eligibility is not proof of a started agent.",
      ],
    },
    {
      id: "activate",
      title: "Activate when authorized",
      guidance:
        "When activation is explicitly authorized and configured acceptance requirements/full doctor pass, enable the shared dispatcher. This applies to every project in the selected configuration. Orca then runs the dispatcher every five minutes; no per-project or extra agent-host schedules are installed.",
      requiredInputs: [
        "Authorization to activate the reviewed configuration; passing full doctor and required acceptance evidence.",
      ],
      commands: ["wingmate install --enable", "wingmate status --json"],
      stopConditions: [
        "If enablement fails, inspect its result and resolve blockers; do not enable an Orca automation manually to bypass doctor.",
      ],
    },
    {
      id: "operate",
      title: "Inspect progress and maintain safely",
      guidance:
        "Open the Command Center to connect Linear tickets with recorded agents, worktrees and gates; leave its server running while using it. Answer owner questions in their existing Linear threads. Follow the configured review/merge/deploy boundary. Cleanup follows lifecycle, ownership, content, PR and complete worker evidence; it can retain completed work when proof is missing. An idle pane, wm-* name or merged PR alone does not authorize deletion. Separate daily audits/dependency jobs and generic orphan removal are not installed.",
      requiredInputs: [
        "Configured project key, actual issue records and owner responses when required by project policy.",
      ],
      commands: [
        "wingmate status --project PROJECT_KEY --json",
        "wingmate ui --open orca --serve",
        "wingmate doctor --quick --json",
        "wingmate cleanup --project PROJECT_KEY --dry-run --json",
      ],
      stopConditions: [
        "Treat missing/stale process and schedule evidence as unknown. Preserve dirty/unmerged work and unresolved attempts; inspect cleanup retention reasons rather than deleting orphaned worktrees manually.",
      ],
    },
  ],
  references: [
    {
      title: "Build and install the skill/CLI",
      url: "https://github.com/furoyce/wingmate-agents/blob/main/README.md#install-the-skill-and-cli",
    },
    {
      title: "Configuration schema",
      url: "https://github.com/furoyce/wingmate-agents/blob/main/src/config/schema.ts",
    },
    {
      title: "Linear app, labels and notification setup",
      url: "https://github.com/furoyce/wingmate-agents/blob/main/docs/linear-app-setup.md",
    },
    {
      title: "Runtime toolchains",
      url: "https://github.com/furoyce/wingmate-agents/blob/main/docs/runtime-toolchains.md",
    },
    {
      title: "Native UI validation",
      url: "https://github.com/furoyce/wingmate-agents/blob/main/docs/native-ui-relay.md",
    },
    {
      title: "Operations and upgrade runbook",
      url: "https://github.com/furoyce/wingmate-agents/blob/main/docs/runbook.md",
    },
    { title: "Cleanup safety", url: "https://github.com/furoyce/wingmate-agents/blob/main/docs/cleanup.md" },
  ],
} as const);

export type OnboardingGuide = typeof ONBOARDING_GUIDE;

export function renderOnboardingGuide(): string {
  const guide = ONBOARDING_GUIDE;
  const list = (items: readonly string[]) => items.map((item) => `- ${item}`).join("\n");
  return [
    `# ${guide.title}`,
    guide.summary,
    `Guide format: \`${guide.format}\`. Reading this guide requires no configuration or credentials and performs no actions.`,
    "## Before you start",
    list(guide.prerequisites),
    "## Choose your interface",
    list(guide.interfaces.map((item) => `**${item.name}:** ${item.guidance}`)),
    ...guide.steps.flatMap((step, index) => [
      `## ${index + 1}. ${step.title}`,
      step.guidance,
      "Required inputs:",
      list(step.requiredInputs),
      "Command examples (run at the indicated stage):",
      `\`\`\`sh\n${step.commands.join("\n")}\n\`\`\``,
      "Stop and resolve:",
      list(step.stopConditions),
    ]),
    "## References",
    list(guide.references.map((reference) => `[${reference.title}](${reference.url})`)),
    "",
  ].join("\n\n");
}
