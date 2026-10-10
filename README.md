# Wingmate Agents

Wingmate coordinates Linear issues, coding agents, Git worktrees, validation gates and pull requests. Its operator interface is a portable agent skill backed by a CLI and a local Command Center.

The current execution and scheduling backend is **Orca**. The skill can be read by another agent with terminal tools; that does not provide that agent with a native scheduler or managed worker adapter.

## Install the skill and CLI

Choose the interface you need:

| Interface | Available on `main` | Installation |
| --- | --- | --- |
| Portable Wingmate skill | Yes | Build/export below, then copy the skill into your agent's skill directory |
| Orca with a Claude Code or Codex agent | Yes | Install the skill for that agent, then use the Orca-backed CLI and Command Center |
| Native Orca plugin | Not yet released | Use the skill and browser Command Center for now; see [plugin status](#native-orca-plugin-status) |
| Other agents with file and terminal tools | Portable instructions only | Give the agent the exported `SKILL.md` path and access to the CLI |

### 1. Build and export

These shell examples target a local macOS installation. You need Git and **Bun 1.4.2 or later** to build. Skill export itself requires no Orca session or Linear credentials. Running managed work also needs Orca and its `orca` CLI, GitHub CLI authentication (`gh auth status`), and the provider CLIs/accounts selected by your project configuration.

```sh
git clone https://github.com/furoyce/wingmate-agents.git
cd wingmate-agents
bun --version
bun install --frozen-lockfile
bun run build

# Make the built CLI available in this shell without installing an automation.
wingmate_checkout="$(pwd -P)"
export PATH="$wingmate_checkout/dist:$PATH"
wingmate package info --json
wingmate package export --out dist/wingmate-package --json
```

Keep this checkout at a stable path. To use the CLI in later terminals, add its **absolute** `dist` directory to your shell's PATH, or call `/absolute/path/to/wingmate-agents/dist/wingmate` directly. Launch your terminal agent from an environment with that PATH. A desktop agent may need the absolute executable path supplied explicitly.

The compiled CLI contains the bundle's content, so export also works outside the source checkout. Export creates a new directory and refuses to overwrite an existing directory, file or symlink. If `dist/wingmate-package` already exists, choose a new output directory. Export reads no credentials, project configuration or runtime records.

The exported bundle contains:

```text
wingmate-package.json                 Version, requirements and content hashes
capabilities.json                    Implemented capabilities and extension gaps
skills/wingmate/SKILL.md              Portable operator entrypoint
skills/wingmate/agents/openai.yaml    Codex skill UI metadata
skills/wingmate/references/operations.md
```

### 2. Install into your agent

Run the appropriate block from the Wingmate checkout after export. Copy the **whole `wingmate` directory**, including its references and metadata. These commands stop before copying if the destination already exists, including a symlink; review and back up an existing installation before replacing it.

**Codex — personal skill:**

```sh
mkdir -p "$HOME/.agents/skills"
test ! -e "$HOME/.agents/skills/wingmate" &&
  test ! -L "$HOME/.agents/skills/wingmate" &&
  cp -R dist/wingmate-package/skills/wingmate "$HOME/.agents/skills/wingmate"
```

Start a new Codex session and ask: **“Use the Wingmate skill to run `wingmate package info --json`.”** Codex's personal discovery directory is documented in [OpenAI's local skill guidance](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills).

**Claude Code — personal skill:**

```sh
mkdir -p "$HOME/.claude/skills"
test ! -e "$HOME/.claude/skills/wingmate" &&
  test ! -L "$HOME/.claude/skills/wingmate" &&
  cp -R dist/wingmate-package/skills/wingmate "$HOME/.claude/skills/wingmate"
```

In a new local Claude Code session, run **`/wingmate`** and ask it to report the installed package capabilities. See [Claude Code's skill locations](https://code.claude.com/docs/en/skills#where-skills-live). These personal directories apply to local agents; a hosted/cloud session needs its own skill files and access to the execution environment.

**Agents inside Orca:** use the installation block for the agent you launch in Orca. The skill calls Wingmate's CLI; [project setup](#onboard-a-project) connects the shared Orca dispatcher. Open the Command Center with `wingmate ui --open orca --serve` after configuring the project.

**Other agents:** import `dist/wingmate-package/skills/wingmate` using the host's documented skill mechanism, or provide its absolute `SKILL.md` path and ask the agent to read it, follow its references, and run `wingmate package info --json`. Reading the skill does not implement a managed Pi, OpenCode, Grok or Gemini scheduler/worker adapter.

### 3. Verify discovery and CLI access

Ask the agent to identify the Wingmate skill it loaded and run:

```sh
wingmate package info --json
```

The output should identify `wingmate-skill-bundle/v1`, the `skills/wingmate/SKILL.md` entrypoint and Orca as the execution backend. If the skill is missing, check that its directory contains `SKILL.md` directly, then start a new session. If `wingmate` is not found, fix the agent's PATH or supply the absolute executable path from step 1.

At this point the skill and CLI are usable, but no project credentials or automation have been installed. Continue with [project onboarding](#onboard-a-project) to manage real issues. There is currently no repository-provided curl installer, Homebrew formula or marketplace plugin package.

### Native Orca plugin status

The native sidebar/palette plugin is still in development and is **not included in `main` or the exported skill bundle**. There is no released plugin package to add through Orca Settings yet. The current supported path is the portable skill plus `wingmate ui --open orca --serve`; it opens the dashboard in Orca's browser.

The [automation management design](docs/superpowers/specs/2026-10-09-wingmate-automation-control-layer.md#10-command-center-and-plugin-contract) describes the planned plugin as another interface to this same core. Native plugin installation instructions will accompany that implementation when it ships.

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

Configure your Linear workspace/team, approvers, project IDs, Orca repository IDs, GitHub repositories, routing, setup and pinned validation commands using [the configuration specification](docs/superpowers/specs/2026-10-05-wingmate-agents-design.md). The checked-in `config/projects.yaml` contains the owner's pilot projects; replace those mappings with your own in a separate configuration file before any live installation. Follow [Linear app setup](docs/linear-app-setup.md) for the OAuth app, labels, workflow states and credentials, substituting your configured team for the guide's pilot team. Secrets stay outside the skill and repository.

```sh
# Select an existing owner configuration; use its actual absolute path.
export WINGMATE_CONFIG=/absolute/path/to/projects.yaml
wingmate config validate
wingmate onboard --project my-app --json
```

The onboarding command produces a reviewable plan. It does not install routines, query credentials, claim issues or delete worktrees. A new project needs real mapping values before its configuration can be validated. `--project my-app` only filters this plan; installation and activation apply to the entire selected configuration.

For managed execution, keep Orca running and register the Wingmate source checkout with Orca if it is not already registered. Register the target repositories too and use their actual Orca IDs in your configuration. From the Wingmate checkout:

```sh
orca repo add --path "$wingmate_checkout"
orca status --json
gh auth status
```

Complete the OAuth installation in [Linear setup, step 2](docs/linear-app-setup.md#2-give-the-client-id-and-secret-to-wingmate-install). On macOS, after copying the application's client secret to the clipboard, the first install is:

```sh
pbpaste | wingmate install --client-id YOUR_CLIENT_ID --client-secret -
pbcopy </dev/null
export PATH="$HOME/.local/bin:$PATH"
wingmate doctor
```

Replace `YOUR_CLIENT_ID` with the app's client ID; the secret is read from stdin. Later installs can reuse the stored credentials:

```sh
wingmate install
wingmate doctor
```

Run installation and the full doctor from the Wingmate source checkout, with `WINGMATE_CONFIG` still set. The installer builds from the Orca-managed `wingmate-dispatcher` worktree, creates `~/.local/bin/wingmate`, prepares repository settings and Linear views, and creates the shared automation **disabled**. Add `~/.local/bin` to your persistent PATH for the installed CLI. Re-running plain `wingmate install` also leaves the automation disabled. The full doctor can launch sandbox/provider probes; `doctor --quick` omits those probes and does not establish enablement readiness.

Complete the setup guide's notification/acceptance checks, then activate when you are ready to dispatch agents:

```sh
wingmate install --enable
wingmate status --json
wingmate ui --open orca --serve
```

Enablement requires authorized activation, the configured acceptance requirements and a passing full doctor. Keep the Console process running while using the dashboard; Ctrl-C stops that UI server. Exporting or copying a skill never enables the dispatcher.

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

The Console binds to loopback only, but loopback is not treated as authentication. Opening the plain URL (by hand or with `wingmate ui --open orca`) starts a browser session: an `HttpOnly`, `SameSite=Strict` cookie named for the port, plus a CSRF token embedded in the page. No token ever appears in a URL or in logs. Data reads (`/api/snapshot`, `/api/events`) need that session and same-origin browser provenance. Actions also need the exact `Origin`, the CSRF header and `Content-Type: application/json`. Requests with a foreign or `null` Origin, a different loopback port, a rebinding `Host`, a frame, or a `text/plain` body are refused before any handler runs. No CORS headers are sent. Sessions expire after 12 idle hours; reload the page to start a new one. This protects the browser request boundary. It does not protect against hostile processes already running as your OS user, which can read Wingmate's state directly anyway.

Console actions are scoped and audited in the ledger as `console_*` events. Pause/resume takes `global` or a configured project key, and the two are independent: resuming global leaves a paused project paused. Promote only adds a configured provider label (`labels.agent.supported`) to a backlog/todo issue in a configured project, and reports success only once a re-read shows the label. Open only accepts an active record's existing worktree and reports success only after the opener exits 0. The header shows dispatcher health from the last tick's freshness and outcome, not just whether a heartbeat exists. Completions are split into recorded done, released and Linear-completed. None of them is shown as merged, because records hold no merge receipt.

Human answers belong in the existing Linear question thread as the signed-in owner. The Console links to Linear; its answer-submission endpoint is unavailable. The dispatcher authenticates eligible replies before delivering them.

`wingmate tick --precheck` deliberately exits nonzero to suppress an extra scheduler agent turn. Read its JSON outcome when diagnosing a run. Maintenance follows the recorded lifecycle and ownership checks; an idle pane or merged pull request alone is not grounds for deleting a worktree.

## Update an installation

From a clean `main` checkout, build and export the updated skill using the freshly built executable explicitly:

```sh
git pull --ff-only
bun install --frozen-lockfile
bun run build
./dist/wingmate package info --json
./dist/wingmate package export --out dist/wingmate-package-updated --json
```

Choose another **new** output directory if that one already exists. Replace only your installed Wingmate skill directory with the new bundle's `skills/wingmate` directory after reviewing/backing up your previous copy, then restart the agent. Rebuilding/exporting does not upgrade an already installed dispatcher binary: `wingmate` on PATH may still resolve to that older version. Keep the skill and the CLI used by your agent on the same release, and verify `wingmate package info --json` after updating both.

For a managed installation, follow the [runbook's upgrade procedure](docs/runbook.md#15-upgrading) to update the dispatcher checkout and reinstall; `install --enable` runs the full doctor before re-enabling. Keep your configuration and credentials outside the source checkout. Removing an agent's Wingmate skill directory only removes skill discovery; it does not stop or uninstall the shared Orca automation.

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
