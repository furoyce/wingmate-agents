# Wingmate first-run setup and native adapters

Status: design extension; adapter milestones below are not implemented capabilities.
Date: 2026-10-12.
Owner direction: harness-specific onboarding, Claude Code routines as the next native scheduler, and Linear/GitHub issue connectors first.

## 1. Product contract and current boundary

Wingmate owns the issue-to-delivery lifecycle and its maintenance; users enter through a skill, CLI, plugin, or dashboard. A new user chooses their harness, issue source, projects, and schedule, then sees the resulting connections and jobs in one view. Orca is the current backend, not a permanent product prerequisite.

This extends the [control-layer design](2026-10-09-wingmate-automation-control-layer.md), including its records, ownership, approval, migration, and cleanup contracts. Preserve the existing machine, gate evidence, protected role dispatch, and exact-head publication checks while adapters are introduced.

Current managed execution and scheduling use Orca; issue intake and authenticated owner decisions use Linear. GitHub pull-request support does not implement GitHub issue intake. A portable skill loaded by another harness does not establish native scheduling or execution support. The native Orca plugin remains a separate release surface.

The first implementation increment adds an interactive `wingmate`/`wingmate setup` entrypoint and `wingmate setup --questions --json` for agent-driven questions. Flags can supply answers noninteractively. Its `setupPlan` is a pure proposal: it does not read credentials, prove readiness, save project configuration, create connections/jobs, or activate automation. Downloading/exporting a package does not execute setup.

## 2. First-run journey

| Step | Information gathered or displayed | Completion evidence |
| --- | --- | --- |
| Launch | Interactive CLI asks questions; a skill/plugin requests the same question schema | Answers, not an installation receipt |
| Harness | Orca, Codex, Claude Code, Pi, or OpenCode; distinguish frontend from scheduler and executor | Selected capabilities and their implementation status |
| Connector | Linear or GitHub Issues; account/workspace scope | Requested connection, initially unverified |
| Project | Stable project key, repository identities, base refs, source project/repository mapping | Draft configuration with unresolved inputs listed |
| Schedule proposal | Intake/reconciliation and maintenance definitions, timezone, cadence, overlap and missed-run policy | Reviewable proposal; unsupported combinations stay blocked |
| Connections/readiness | Authenticate privately, resolve identities, validate tools/gates/notifications and execution access | Scoped connection/readiness receipts, with expiry/freshness |
| Creation/activation | Apply reviewed configuration and bindings, then activate authorized ready definitions | Native IDs, operation receipts, and observed enablement |
| Dashboard | Project → issues → runs → agents → workspaces → evidence → delivery/cleanup | Reconciled read model with unknown states retained |

Ask only for missing inputs and preserve existing choices when adding a second project. Do not require another scheduler binding when a shared binding already serves that project. Selecting Claude Code must distinguish cloud routines, Desktop local tasks, and session polling before proposing a cadence.

The initial CLI questions intentionally stop at the proposal. A later resumable wizard stores versioned answers and proposal revisions outside credentials, recognizes an existing installation, and can resume incomplete connection or application steps. Noninteractive calls must never unexpectedly prompt or mutate a host.

Show the full proposed schedule before applying it: logical job, project scope, scheduler, execution location, source connection, cadence/timezone, readiness, and expected activation state. Show unavailable capability beside the affected job rather than silently substituting Orca or another provider.

## 3. Four independent interfaces

| Interface | Responsibility | Must not own |
| --- | --- | --- |
| `HostFrontend` | Ask shared questions, render plans/results, expose host menus or agent controls | Independent workflow records, authorization policy, or duplicate timers |
| `SchedulerAdapter` | Capability discovery, observe/list, plan/apply, enable/pause, run history and reconciliation | Issue ownership or proof that a started session completed its task |
| `ExecutionAdapter` | Launch/observe/cancel with stable operation identity, workspace access, liveness and evidence | Unbounded authority inferred from a scheduling prompt |
| `IssueConnector` | Scoped intake/cursors, normalized identities, actor provenance, decisions, state/comments/links | Approval inferred from issue text or an unrelated integration |

These are contracts to introduce around existing operations, not four new services. Workspace and delivery operations retain their separate contracts from the control-layer design. Frontend support, scheduler support, and executor support each report `supported`, `unsupported`, or `unverified`, plus version and observation time where applicable.

The same host may implement several interfaces; a user may combine different hosts. A scheduler can only wake the core if the chosen deployment makes that core reachable. A model/provider choice is not an execution environment or a credential-isolation guarantee.

## 4. Shared identity, ownership, and scheduling authority

Reuse the control-layer objects: Project, WorkItem, AutomationDefinition, SchedulerBinding, TriggerReceipt, AutomationRun, WorkflowRun, AgentAssignment, WorkspaceLease, Evidence, Decision, Delivery, and CleanupOperation. Internal IDs remain opaque and stable; external identities include provider, account/installation, host where applicable, and external ID.

The core remains the authoritative writer for lifecycle admission, decisions, run transitions, and workspace ownership generations. An adapter records external receipts; it cannot independently claim an issue or give a second writer a workspace. A schedule firing is not a lease and a finished dispatcher tick is not a completed development workflow.

Each logical occurrence has a durable deduplication key and selected definition revision. Retries, overlapping host wakeups, manual retries, and lost responses reconcile the same occurrence. Workspace mutation requires its current lease generation; cancelled or superseded runs cannot resume under stale ownership.

Today one physical Orca five-minute wakeup reconciles all configured projects. Future logical cleanup/watchdog/audit definitions may share that binding. Portfolio totals count physical bindings once and logical jobs separately; disabling one project must not disable the shared dispatcher. Do not create per-project copies of the same wakeup merely because onboarding ran from two frontends.

Maintain desired state separately from external observation. Schedule inventory uses these minimum states:

| State | Meaning |
| --- | --- |
| `planned` | Proposal only; no native creation receipt |
| `created` | Native identity and creation receipt recorded; enablement/liveness still separately observed |
| `observed` | Successful inventory observation with identity, scope, freshness and completeness; may be externally managed |
| `unknown` | Missing/stale/partial observation or ambiguous mutation; never equivalent to absent, disabled, or failed |

Observation alone never adopts an external routine. Migration records a cutover and occurrence watermark, verifies the old binding is disabled before enabling its replacement, and reconciles unknown outcomes before retrying. Do not promise exactly-once external launches when the host lacks idempotency or lookup guarantees.

## 5. Claude Code routines: first native adapter

The next scheduler target is **Claude Code cloud routines**, with a separate execution/deployment capability check. Desktop tasks and `/loop` remain distinct targets. The local Orca installation continues working while the cloud integration is developed.

Verified documentation describes `/schedule <description>` for creation, `/schedule list`, `/schedule update`, and `/schedule run` for management. CLI creation requires v2.1.225+; management requires v2.1.227+. Cloud schedules have a one-hour minimum. The documented HTTP `/fire` endpoint starts an existing routine; it is not a general creation/list/update API. Token creation/revocation uses the web. [Claude routines](https://code.claude.com/docs/en/routines)

Integrate through documented native host-agent control first, with capability/version detection. Do not invent `claude schedule --json`, undocumented CRUD URLs, or direct writes to private host storage. A conversational response is insufficient creation proof: capture the native routine ID/link, read it back through a supported observation path, and bind it to the Wingmate operation. If reliable reconciliation is unavailable, stop at assisted setup and mark the binding unknown rather than advertising automatic management.

A cloud routine cannot automatically use the operator's local Orca socket, local state root, local executable, or localhost dashboard. Before enabling a Wingmate routine, choose and validate one explicit execution design:

1. A scoped authenticated remote bridge submits the occurrence to the authoritative Wingmate core, which retains admission and workspace ownership.
2. A supported remote deployment runs the core with durable storage and executor access; the local writer is explicitly migrated or remains a read-only client.

Neither design is implemented by copying local state or credentials into a prompt. Define run context containing project/definition/binding IDs, occurrence and operation IDs, policy revision, execution host, and scoped connection references. The authority must durably acknowledge admission before the host reports dispatch success; record native run/session IDs and reconcile asynchronous completion.

Cloud environments need their own reachable repositories, dependencies, artifact transport, and scoped issue/delivery connections. Configure only required connectors. Existing local MCP connections do not automatically become cloud connectors. Pin the allowed project/repository scope and distinguish scheduler success from evidence-backed workflow success.

OAuth/account linking and token provisioning use the provider's supported secure flow. The owner completes login/consent and any provider-required approval; never ask for secrets in chat or place them in skills, proposals, logs, or source configuration. Store credential handles with scope and expiry/reconnect status. Existing session authorization still applies to subsequent actions within its scope; do not invent additional approval gates.

Activation needs actual connection/readiness evidence and authorized scope. Routine creation that immediately schedules work must itself be treated as activation unless a verified disabled/manual creation path is available. A one-hour cloud minimum cannot silently replace the existing five-minute dispatcher cadence: propose the changed cadence explicitly or keep Orca as the scheduler.

## 6. Other host capabilities and boundaries

| Target | Verified platform capability | Wingmate implication |
| --- | --- | --- |
| Orca | CLI automation create/list/show/edit/run/runs/remove; existing or new worktree per run | Current backend; preserve installed configuration and receipts |
| Codex | Desktop scheduled tasks can use local projects/worktrees; web tasks lack direct local-folder access; CLI/IDE do not provide the scheduling management interface | Portable frontend today; native scheduling/execution adapter still needed |
| Claude Desktop | Persistent local tasks; app must run while machine is awake; minimum one minute; required working folder and optional worktree | Future local adapter, not cloud routines |
| Claude `/loop` | CronCreate/List/Delete; session scheduling, minimum one minute, recurring seven-day expiry | Temporary polling; not a durable project scheduler |
| OpenCode | Noninteractive CLI/server execution; documented GitHub Actions schedule integration | Executor and scheduler are separate; community schedulers require explicit adapter selection |
| Pi | Print/JSON/RPC execution; extensible packages | Native scheduler CRUD unverified; no implicit scheduling package installation |

Sources: [Claude Desktop](https://code.claude.com/docs/en/desktop-scheduled-tasks), [Claude session scheduling](https://code.claude.com/docs/en/scheduled-tasks), [OpenCode CLI](https://opencode.ai/docs/cli/), [OpenCode GitHub schedules](https://opencode.ai/docs/github/), [OpenCode community ecosystem](https://opencode.ai/docs/ecosystem/), [Pi CLI](https://pi.dev/docs/latest/cli), [Pi RPC](https://pi.dev/docs/latest/rpc-commands). Orca evidence is the version-matched `orca skills get orca-cli --reference references/automations.md --json` and automation command help, inspected with CLI 1.4.222 on 2026-10-12.

Codex scheduling sources: [scheduled tasks](https://learn.chatgpt.com/docs/automations) and [desktop deep links](https://learn.chatgpt.com/docs/reference/commands). `codex://automations` opens the creation surface; opening it is not a creation receipt. The docs describe scheduling through the app/chat, not a generic `codex schedule` CLI or permission to edit private task storage.

Pi Durable is a separate experimental framework with durable task/timer primitives, not an automatically available scheduler in the Pi coding agent. Reassess capabilities when selecting a concrete adapter version. [Pi Durable](https://earendil.com/posts/pi-durable/)

## 7. Issue connectors: Linear and GitHub first

Keep Linear as the implemented connector while extracting its contract. Add GitHub Issues as the second implementation; GitLab and Jira remain future extensions behind the same boundary, without exposing nonfunctional connection choices as ready.

Normalize WorkItem identity as `{source, installationOrWorkspace, externalId}` plus display key and source URL. GitHub issue number alone is not unique. Preserve repository/node identity and actor/app provenance; do not conflate a PR with its issue-shaped API representation or a merged PR with issue completion.

Each connector defines eligibility, pagination completeness, labels and workflow-state mapping, authenticated comment/state events, review/owner-decision semantics, issue links, and notification acceptance. GitHub cannot inherit Linear label groups, state transitions, or notification guarantees by name. Project policy states who may authorize each action and how that authorization is verified.

Use journaled idempotent writes and reconnectable credential handles. A revoked or expired connection blocks dependent work and keeps observation unknown; reconnecting must revalidate account/scope without reassigning existing records. UI connection summaries expose identity and readiness, never token material.

Migration preserves existing Linear records and their original IDs, links, decisions, journals, and workflow history through an explicit compatibility mapping. Test readers before writes, retain backups and migration receipts, and prevent old writers from stripping new fields. Do not require owners to recreate tickets to onboard another connector.

## 8. Delivery slices and acceptance gates

| Order | Deliverable | Required tests and stop criteria |
| --- | --- | --- |
| 1 | Shared first-run questions and pure setup proposal | Interactive, flag and JSON paths agree; non-TTY never hangs; malformed answers fail; no context/credential/host initialization or filesystem mutation; unsupported choices remain explicit |
| 2 | Definition/binding/connection identity and observation model around current Orca install | Migration fixtures preserve Linear data; shared binding counted once; discovery never adopts/enables; partial inventory remains unknown; replay produces no duplicate dispatcher |
| 3 | Claude routines assisted/native scheduler adapter | Version/capability detection; create/list/update/run transcript fixtures and native receipts; reconciliation after response loss; refuse unavailable CRUD; reject sub-hour cadence; no local state assumed reachable |
| 4 | Explicit cloud execution bridge/deployment and activation | Scoped connection/auth tests; occurrence deduplication; crash before/after admission; expired lease rejection; cancellation/liveness proof; durable run/artifact provenance; stop if authority, credentials, or execution access is unproven |
| 5 | GitHub issue connector and project setup | Colliding external IDs; actor authorization; pagination gaps; label/state mapping; notification/review behavior; reconnect and idempotent writes; preserve all legacy Linear records |
| 6 | Unified dashboard and additional native adapters | Planned/created/observed/unknown rendering; physical/logical count integrity; project isolation; cross-frontend operation equivalence; adapter conformance before enablement |

Slices 3 and 5 can develop independently after slice 2; activation of slice 3 depends on slice 4. The present wizard is slice 1 only. A displayed plan is never recorded as a created job, an observed host session is never assumed to own a workspace, and cleanup still requires the existing delivery, ownership, content, and worker evidence.

Use fakes and temporary state roots for automated tests. Add a bounded, explicitly configured host acceptance run only after offline contracts pass; verify the exact native IDs and receipts, then reconcile its final state. Do not use the operator's existing routines as test fixtures or broaden application merge/deployment authority through onboarding.
