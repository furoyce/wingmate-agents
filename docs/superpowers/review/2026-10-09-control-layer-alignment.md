# Wingmate control-layer alignment review

Date: 2026-10-09. Scope: core lifecycle, package/Console, uncommitted Orca plugin and cleanup prototype, assessed against the owner's end-to-end automation-management direction.

## Baselines and method

- Committed baseline: `origin/main` at `df9a0d9983dde71128ff89228c794eaba8cab730`, freshly fetched for this review.
- Package/plugin worktree: `/Users/jujufugh/orca/workspaces/wingmate-agents/wingmate-portable-package`, base `68e9103f15130239260e540e27101b22f2a9a933`; plugin changes are uncommitted and not part of remote main.
- Cleanup worktree: `/Users/jujufugh/orca/workspaces/wingmate-agents/orca-linear-wingmate-agents`, base `25c4a8529c56694befd37b3622ddb221290a8fd3`; cleanup command/schema edits are uncommitted.
- Review used source inspection, independent parallel reviews and fake-only cleanup probes. No live cleanup, activation, credential changes, application merges or deployments were performed.

Absolute paths below identify the reviewed local prototypes. Committed files are relative to this repository. Line numbers refer to the observed revision and may move with subsequent edits.

The [preserved evidence summary](2026-10-09-control-layer-evidence.json) includes source hashes, original receipt hashes and synthetic observations so the key evidence does not depend on temporary files remaining available.

## Confirmed shipped Console defects

| ID | Severity | Finding and evidence | Required correction |
| --- | --- | --- | --- |
| UI-1 | High | `src/server/index.ts:99,148` uses wildcard CORS for snapshot/events; `:153–160` accepts action POSTs without Host/Origin/session validation, and parses JSON regardless of content type. An isolated actual-handler probe returned snapshot data to a foreign Origin and accepted a text/plain pause POST, writing the synthetic pause state. | Enforce the local request/session/CSRF boundary and strict request types; route permitted actions through scoped audited operations. |
| UI-2 | Medium | `src/server/snapshot.ts:669` checks pause scope `all`, whereas the core uses `global`. The isolated probe showed `pausedScopes=['global']` with a project still active/enabled. `src/server/html.ts:1085,1734` treats any scoped pause as global. | Share pause scope semantics; global resume must not imply that a separately paused project resumed. |
| UI-3 | Medium | The dashboard header derives health from heartbeat presence, while completion labels include “Merged”/“Shipped” (`src/server/html.ts:1678–1679`) without a merge receipt. Released/source-completed work can be presented as delivery, and queue aggregation (`src/server/snapshot.ts:563`) includes skipped rows in ready counts. | Render observed scheduler health/freshness, respect queue eligibility reasons and distinguish released, source-completed, review-ready and merge-verified outcomes. |
| UI-4 | Medium, source inspection | `src/server/actions.ts:28–46` resolves caller-supplied label/issue targets without configured project/provider scope checks; `:87–128` opens caller-supplied targets and reports success before confirming the child result. | Validate scope and allowed targets in core; distinguish accepted launch from confirmed result; audit mutations. No real promote/open was executed in this review. |

UI-1 is inherited by the in-progress plugin because it opens the same Console; the plugin did not introduce this server behavior. The existing answer endpoint deliberately refuses submissions and should remain closed until a verified identity path exists.

Console probe receipt: `/tmp/wingmate-adapter-review-a8pz4dgw/proof-receipt.json`, SHA256 `848113a7c048b57f619565f6f648169760ae7a4f86fba26b9c88c9414b0ab30d`. The actual `Bun.serve` handler was captured without binding a listener and called with synthetic requests, fresh temporary state, fake configuration and `linearClient:null`. This proves handler acceptance, not a browser-specific cross-network exploit: no browser/PNA behavior was tested. No real state or service was changed; reviewed source hashes remained unchanged.

## Confirmed shipped issue-event authorization defect

**AUTH-1 — High:** `src/machine/reconcile.ts:230–233` treats any history actor with `botActorType === "integration"` as the GitHub integration. That predicate authorizes state events at line 242 and lifecycle events at line 270, rather than only GitHub Done-by-merge as required by the original specification §7.4. A fake unrelated integration moved an idle parked issue to Done: reconciliation returned `authorized=true`, and `advanceAll` persisted `stage=done` with no attention. Application-bot and non-approver-human controls stayed unauthorized/awaiting-human. An unrelated integration changing review to In Progress also classified as authorized; that probe did not execute the resume.

Require the configured integration's actual identity and event-specific authority, and verify linked delivery evidence for merge completion. Do not generalize that authority to reviews, labels or owner answers. This defect is separate from the future automatic-merge feature.

The probe used pinned Bun 1.4.2, fake ports, temporary records, disabled network and `FakeOrca.root=null`. No real worktree, provider, cleanup or source action occurred. The full review receipt SHA256 is `f624e9d433701cb75d70f83a229755bd802459c9b70e0526477d0a817f60a1d6`; it binds 36 inspected source/spec/test/fake files byte-identical to the baseline. Probe results SHA256: `3ec627377917160d8ad01f0ce10750a43e79746e4b47464169b5879cd33acee7`.

## Confirmed cleanup defects — must fix before integration

| ID | Severity | Finding and evidence | Required correction |
| --- | --- | --- | --- |
| CL-1 | High | Cleanup `src/ops/cleanup.ts:59–66` turns failed fleet enumeration into a complete empty inventory; `src/machine/cleanup.ts:62–72` then clears the record as already removed. Fake probe: removed=1, record cleared, actual fake worktree retained, removal calls=0. | Preserve failed/partial inventory; no absence claim or record clearing without successful authoritative proof. |
| CL-2 | High | Cleanup `src/machine/cleanup.ts:33,59` lets `--force` bypass both terminal lifecycle and open PR protection. Fake probe removed a working record with an OPEN PR; no terminal close/process sweep occurred. | Limit grace override to time; preserve active-work and PR protection; prove owned processes stopped before removal. |
| CL-3 | High | Cleanup `src/ops/cleanup.ts:93–125` directly calls cleanup without the dispatcher's grace check. Fake probe removed a just-completed worktree at age zero with 24-hour grace and no force flag. | One shared eligibility calculation for CLI, dispatcher and dry run. |
| CL-4 | High | Cleanup `src/ops/cleanup.ts:159–184` treats unreferenced `wm-*` fleet rows as orphans without repository/project scope or ownership/active/dirty checks. Fake `--project bouncr --orphaned` removed a foreign repository worktree. | Explicit ownership leases and scoped descendants; unregistered worktrees are findings, not deletion targets. |

The local tracked removal path does not explicitly close terminals or sweep background processes. The orphan path swallows close/sweep errors before removal. Dry run returns eligibility before PR/defer/grace evaluation. These are part of CL-2/CL-3's correction criteria.

`immediateOnMerge` is local-only, defaults false under `defaults.cleanup`, and is not enabled by the reviewed configuration. It applies on a later tick to done/cancelled records, accepts CLOSED as well as MERGED PR states, and remains subject to deferred retries. The tested claim of immediate merged-only cleanup is therefore not implemented as described.

Fake receipt: `/tmp/wingmate-cleanup-fake-audit-4gsf7elh/receipt.json`, SHA256 `b44564f6036ff145cc8d1778f37c0e8c722b34b8aa67392eeb124a9cdf6153ef`. Results SHA256 `3ca5196fa1cf4cfcf9a74dc131a3ff75fd63018ee52266c960148312b95cccef`. All four probes used fakes; no real worktree was removed. The temporary receipt is local evidence, not a release artifact.

Two related concerns also exist in committed cleanup and require targeted regression cases during increment A:

- **Medium, source inspection:** `src/machine/cleanup.ts:44–60` clears a worktree reference on complete-fleet absence without verifying that its path is gone. `src/machine/release.ts:85–90` already requires both observations. Cleanup should use equivalent proof before declaring an externally removed worktree gone. This path was not separately exercised against a real host.
- **High, source inspection:** `src/machine/release.ts:107–123` can persist done/cancelled with worker/native execution still marked unverifiable when terminal closure succeeded; cleanup at `src/machine/cleanup.ts:21,68–75` does not examine that uncertainty. Eligibility must require owned worker/native/child termination evidence. This review did not execute a live deletion or reproduce physical file loss.

Released and archived retained workspaces intentionally fall outside current automatic done/cancelled cleanup. Their absence from an active record is not proof they are disposable. Add an ownership/retention view and explicit policy instead of sweeping their name prefixes.

## Capability and alignment gaps

| Area | Verified state | Design consequence |
| --- | --- | --- |
| Existing pipeline | Records already include intake, plan, planVerify, implement, validate, ui, security and pr; role/native job evidence exists. | Extend the existing state machine; do not build a parallel orchestrator. |
| Approval enforcement | `src/kit/protocol.ts:9` instructs ask-first coordination; `src/machine/outbox.ts:120–155` validates gate prerequisites/reviewer evidence without requiring a scope/plan-bound owner decision. Authentication applies to replies when questions exist. | Add a core decision prerequisite for managed progression/publication. Preventing pre-approval file edits additionally requires a read-only planning/writable implementation capability boundary. |
| Automatic completion | Publication reaches review; `src/machine/advance.ts:106` handles authorized source completion. Runtime does not read `project.done` for automatic merge/deploy; `GhPort` has no merge or required-check/review proof operation. | Separate delivery facts, approved merge actions and retention. |
| Work-item identity | `RecordSchema` is version 1, source `linear-issue`, keyed on display identifier; coordinators/role jobs are Claude/Codex enums. | Introduce migration and adapter contracts before claiming GitHub issue or general-provider support. |
| Scheduling | One shared five-minute Orca precheck; no general automation registry or native schedule import. | Keep scheduler, run and agent as separate records; preserve one wake-up owner initially. |
| Onboarding | `onboard --project KEY` reads configuration and emits a plan. Install prepares Git settings/views and one disabled dispatcher. | Add a versioned plan/apply/sync workflow, not a second installer hidden in the plugin. |
| Maintenance configuration | Proposed `projects.<key>.maintenance` keys are absent and stripped by the current Zod project parser. | Reject unsupported new keys; implement the schema and logical routines before documenting runnable configuration. |
| Maintenance execution | Watchdog/cleanup are dispatcher steps; repo and dependency/security audit schedules and a separate maintenance capacity pool are absent. | Reuse lifecycle protections; add audit profiles and capacity accounting explicitly. |
| Surface ownership | Portable skill/CLI/Console are committed; native plugin remains a separate local change. | All surfaces use core records and operations; package contents are not proof of runtime readiness. |

## Validation performed

In the cleanup prototype with pinned Bun 1.4.2, `bun test tests/unit/cli/cleanup.test.ts tests/unit/config/load.test.ts` passed 8 tests (five cleanup and three configuration), and `bun run check` passed. Those tests do not cover the four confirmed defects or verify immediate-on-merge behavior. The supplied compiled-binary orphan-discovery claim was not rerun against the live host.

Existing regression coverage was inspected for preservation: `tests/sim/paths.test.ts` (cleanup grace/open PR and remove replay), `tests/unit/machine/reconcile.test.ts` (author-change controls), `tests/unit/machine/answerDelivery.test.ts` (authenticated reply delivery), `tests/sim/gateAcknowledgement.test.ts` (gate replay/head/FAIL), and `tests/unit/machine/publish.test.ts` (pinned checks/exact-head publication/replay). The documentation-only change does not justify claiming a new full-suite runtime validation; new fake probes above target gaps in that coverage.

## Review disposition

Three parallel reviews covered core/lifecycle/cleanup, package/plugin/Console, and the proposed shared model. Independent design review requested five contract clarifications: many logical routines sharing one physical scheduler binding; bounded tick completion versus long-lived workflows; schedule-revision cutover/deduplication; one mutating workspace owner; and review-only/all-required-PR completion. All five were incorporated and re-reviewed with no remaining blocking design contradictions.

The aligned implementation order is: existing authorization/Console boundary and truthful status, cleanup correctness, registry/identity, lifecycle visibility, onboarding/maintenance, issue/delivery adapters, then additional hosts. The thin plugin approach is aligned; a plugin shell does not resolve inherited core defects or provide missing provider capabilities.

This change contains design and review documentation only. The defects remain unfixed; the proposal does not change operational policies or activate automation. Existing runtime checks passing should not be interpreted as coverage of the reproduced defects.
