# Wingmate Agents

Wingmate coordinates Linear issues, coding agents, Git worktrees, validation gates and pull requests. Its operator interface is a portable agent skill backed by a CLI and a local Command Center.

The current execution and scheduling backend is **Orca**. The skill can be read by another agent with terminal tools; that does not provide that agent with a native scheduler or managed worker adapter.

## Package and build

Build from this repository with Bun 1.4.2 or later:

```sh
bun install --frozen-lockfile
bun run build
./dist/wingmate package info --json
./dist/wingmate package export --out dist/wingmate-package --json
```

The compiled CLI contains the bundle's content, so export also works outside the source checkout. Export creates a new directory and refuses to overwrite an existing directory, file or symlink. It reads no credentials, project configuration or runtime records.

The exported bundle contains:

```text
wingmate-package.json                 Version, requirements and content hashes
capabilities.json                    Implemented capabilities and extension gaps
skills/wingmate/SKILL.md              Portable operator entrypoint
skills/wingmate/agents/openai.yaml    Codex skill UI metadata
skills/wingmate/references/operations.md
```

Import the `skills/wingmate` folder using the target host's supported skill mechanism, or ask an agent to read its `SKILL.md` directly. The agent needs the Wingmate CLI in its tool environment. This bundle does not install host configuration or a CLI binary, and it is not a vendor marketplace manifest. There is currently no repository-provided curl installer, Homebrew formula or launchd/systemd service.

## Capabilities

| Layer | Current implementation |
| --- | --- |
| Agent interface | Exportable `SKILL.md` and CLI; automatic host installation is not provided |
| Execution host | Orca worktrees, dispatches and terminal delivery |
| Providers | Claude/Codex coordinator paths; additional worker choices remain subject to role and sandbox admission |
| Scheduling | One shared Orca dispatcher, every five minutes, installed disabled |
| Onboarding | Offline plan for configured projects, including routing, pinned checks and baseline routines |
| Maintenance | Dispatcher reconciliation and lifecycle-checked cleanup; on-demand diagnostics |
| UI | Linear ticket, recorded agent assignment, worktree and gate visibility; routine evidence is qualified |
| Pi, OpenCode, Grok, Gemini CLI | May consume the portable instructions; their managed execution and scheduler adapters are not implemented |
| Native Claude routines / Codex scheduled tasks | Future host adapters; not installed or activated by Wingmate |

The capability manifest describes implementation, not the readiness of a particular machine. Runtime diagnostics and project policy still apply.

## Onboard a project

Configure the real Linear project, approvers, repository IDs, routing, setup and pinned commands using [the configuration specification](docs/superpowers/specs/2026-10-05-wingmate-agents-design.md). Follow [Linear app setup](docs/linear-app-setup.md) for credentials; secrets stay outside the skill and repository.

```sh
# Select an existing owner configuration; use its actual absolute path.
export WINGMATE_CONFIG=/absolute/path/to/projects.yaml
./dist/wingmate config validate
./dist/wingmate onboard --project my-app --json
```

The onboarding command produces a reviewable plan. It does not install routines, query credentials, claim issues or delete worktrees. A new project needs real mapping values before its configuration can be validated.

For an authorized installation, run the existing installer from the Wingmate source checkout:

```sh
./dist/wingmate install
./dist/wingmate doctor
```

The installer prepares the shared dispatcher worktree, binary and disabled Orca automation, and may prepare repository settings and Linear views. Activate with `wingmate install --enable` once activation is authorized, the configured acceptance requirements are met and the full doctor passes. `doctor --quick` omits sandbox probes and does not establish enablement readiness.

The baseline five-minute dispatcher reconciles issues, replies and gates and handles eligible cleanup after the configured grace period. Use `wingmate cleanup --issue JRF-501 --dry-run --json` to inspect the same cleanup policy on demand; [cleanup safety and retained cases](docs/cleanup.md) documents explicit scopes and grace-only `--force`. Export and onboarding do not create extra schedules. Use `wingmate doctor --quick --json` for an on-demand health inspection; a separate daily health job, incident triage and dependency-maintenance jobs remain extension work.

## Operate and inspect

```sh
wingmate status --json
wingmate status --project my-app --json
wingmate scan --dry-run --json
wingmate tick --dry-run --json
wingmate ui --serve
```

Open the reported loopback URL, normally `http://127.0.0.1:4848`. The Command Center links Linear tickets to their coordinator, role jobs, worktree and validation state. Assignment records do not prove that the corresponding process is currently alive; absent observations remain unknown. Usage and cost are shown only with their available provenance.

Human answers belong in the existing Linear question thread as the signed-in owner. The Console links to Linear; its answer-submission endpoint is unavailable. The dispatcher authenticates eligible replies before delivering them.

`wingmate tick --precheck` deliberately exits nonzero to suppress an extra scheduler agent turn. Read its JSON outcome when diagnosing a run. Maintenance follows the recorded lifecycle and ownership checks; an idle pane or merged pull request alone is not grounds for deleting a worktree.

## Delivery and isolation

The project configuration defines validation commands, autonomy and the delivery boundary. Implementation, review, merge and deployment are distinct decisions. Operator credentials and publication actions stay with the dispatcher; issue workers follow their installed `.wingmate/BRIEF.md` and `PROTOCOL.md`.

Isolation depends on the actual provider and host. A Git worktree by itself is not a security boundary. Native UI validation requires its configured execution evidence. Current pilot owner acceptance is recorded separately from formal unassisted/native acceptance; see [the operations checkpoint](docs/superpowers/plans/2026-10-07-wingmate-pilot-operations.md).

## Development and references

The [automation management design](docs/superpowers/specs/2026-10-09-wingmate-automation-control-layer.md) maps the existing core to the proposed shared routine, run, agent and workspace model. Its [alignment review](docs/superpowers/review/2026-10-09-control-layer-alignment.md) separates shipped behavior, local prototypes and remaining work.

```sh
bun run check
bun run lint
bun test
bun run build
```

- [Operations runbook](docs/runbook.md)
- [Linear OAuth setup](docs/linear-app-setup.md)
- [Runtime toolchains](docs/runtime-toolchains.md)
- [Native UI relay](docs/native-ui-relay.md)
- [Design specification](docs/superpowers/specs/2026-10-05-wingmate-agents-design.md)
