/** Public starter only: placeholders deliberately fail validation until real mappings are supplied. */
export const PROJECT_CONFIG_TEMPLATE = `# Wingmate: one-project starter, not a ready-to-run configuration.
# Replace every <...> placeholder with verified values. Keep credentials elsewhere.
# For an existing installation, add a project to its selected config instead of replacing it.
workspace:
  linearWorkspace: "<LINEAR_WORKSPACE_UUID>"
  team: "<LINEAR_TEAM_KEY>"
  owner: "<OWNER_LINEAR_USER_UUID>"
  approvers: ["<APPROVER_LINEAR_USER_UUID>"]
labels:
  agentGroup: Agent
  lifecycleGroup: Lifecycle
  agent:
    supported: [agent-ready, claude]
    human: human
  lifecycle: [Ready, In-Agent, Needs-Human, Review-Ready, Blocked]
  allowDeps: allow-deps
defaults:
  timezone: "<IANA_TIMEZONE>"
  autonomy: ask-first
  done: review
  providers:
    default: claude
    coordinatorCascade: [claude]
    # Widen writable providers only after reviewing/accepting their isolation limits (runbook section 16).
    workers: [claude]
    verifyCross: true
  cleanup:
    worktreeGraceHours: 24
projects:
  my-app: # Choose a stable local project key; use it in --project.
    linearProject: "<LINEAR_PROJECT_UUID>"
    repos:
      main:
        orcaRepo: "<ORCA_REPOSITORY_UUID>"
        github: "<GITHUB_OWNER>/<GITHUB_REPOSITORY>"
        base: origin/main
        # Replace with the repo's argv sequence if dependency setup is required.
        setup: none
        # Add absolute toolchain bin directories when the worker needs them.
        runtimeBinPaths: []
        # Replace with the repo's real pinned argv checks; never use a no-op gate.
        gates: [["<VALIDATION_EXECUTABLE>", "<VALIDATION_ARGUMENT>"]]
        requiredCheck: none # Set the exact required GitHub check when applicable.
        # Choose web, ios or none explicitly; web projects also need their actual
        # path prefixes (not globs), dev argv, url and smokeRoutes. For example:
        # ui:
        #   kind: web
        #   paths: ["src/"]
        #   dev: ["bun", "run", "dev"]
        #   url: "http://127.0.0.1:3000"
        #   smokeRoutes: ["/"]
        # Native iOS execution also needs an available isolated host adapter.
        ui: { kind: "<UI_KIND>" }
    routing:
      default: main
`;
