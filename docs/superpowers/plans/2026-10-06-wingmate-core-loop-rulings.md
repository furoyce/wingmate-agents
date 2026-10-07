# Slice-1 rulings — Wingmate core loop

Decisions made while executing `2026-10-06-wingmate-core-loop.md` without stopping to ask (subagent-driven development:
rule, record, keep going). Each states what it costs if it is wrong, so the owner can audit and reverse it. Source of
truth: the git-ignored SDD ledger `.superpowers/sdd/2026-10-06-wingmate-core-loop/progress.md`; this file is its durable
digest (2026-10-07).

## Numbered rulings

| # | Ruling | Why | Cost if wrong |
|---|---|---|---|
| R1 | The outbox refreshes the Linear status comment only when it executed or failed an intent; events and tick transitions still refresh it. | Otherwise one Linear write per tick per working issue (§11.2, rate limits). | A staler status comment between events. |
| R2 | Test fakes: `FakeGit.push` records the real HEAD; `FakeGh.prCreate` returns the open PR for the same head. | The real adapters behave this way; Task 11's replay tests need it. | None outside tests. |
| R3 | Biome ignores `spikes/`. | Throwaway Task 0 scripts print with `console.log`. | Lint does not cover spikes. |
| R4 | Model per role: cheap tiers for transcription tasks, opus for Tasks 9–10 and their reviews; the final review on Fable with an Opus fallback (amended after a Fable usage limit). | Least capable model that fits each role. | Process cost only. |
| R5 | Plan code blocks are authoritative on behaviour and names; implementers adjust imports and trivial types as `tsc` dictates and report behavioural deviations. | The plan's blocks were written before compilation. | A reviewer sees an unexplained diff from the plan. |
| R6 | Folder-trust dialog: `terminalWait` reports `blockedReason`; on `agent-trust-workspace` the launch sends Down, then Enter, and waits again; `doctor` adds a non-blocking `claude_trust` check. | The dialog blocks every first launch in a repo and defaults to "No, exit". | Answering a different dialog (mitigated: the screen must contain "trust this folder"). |
| R7 | The Orca adapters follow the observed result nesting (spike §4). | Live shapes differ from the plan's assumptions. | Contract tests against the captured fixtures fail loudly. |
| R8 | Codex runs with `-c approval_policy=never`. | Accepted by both `codex` and `codex exec`. | None observed. |
| R9 | Codex reads outside the worktree are not blocked, so the pilot cascade is `[claude]` and Codex is reviewer-only (read-only sandbox, no network); simulations still cover a `[claude, codex]` handoff. | D14 extension found in Task 0. | Fewer providers in the pilot until the owner decides. |
| R10 | Keep 2 claims per tick within the 180 s tick budget; verify the automation's 240 s precheck timeout at install read-back, else apply 1 claim / 50 s. | Spike row 7. | One disabled automation to edit. |
| R11 | The agent `PATH` includes the Homebrew prefix; the kit gitconfig via `GIT_CONFIG_GLOBAL` is mandatory. | git and gh live under the sandbox-denied home directory. | Agents cannot run git. |
| R12 | Network control is `strictAllowlist: true` plus `deniedDomains`, with WebFetch and WebSearch denied; `doctor` validates the settings and probes that a non-allowlisted host is blocked. | `allowedDomains` alone is advisory under bypassPermissions (spike §3.4a). | Coordinators lose WebFetch/WebSearch they did not need. |
| R13 | Accepted Task 0's exploratory TUI turn ($1.37) and Claude Code's own trust rewrite in `~/.claude.json`. | Needed to characterise the trust dialog. | None beyond $1.37. |
| R14 | The logger redaction-depth finding was treated as Important, not Minor. | Global constraint: logs never contain secrets. | A few extra redact paths. |
| R15 | When Orca teammate panes broke (`tmux: terminal_exited`), implementers and reviewers ran as forks with explicit independence instructions. | Otherwise the plan stalls on an environment fault. | Weaker reviewer independence for those rounds; the final review re-examined the files. |
| R16 | The tick lock's heartbeat compares the on-disk token before each write and flips `lost()`; the tick checks it before every external action and ends `lock_lost`. | A tick frozen for more than 15 min is reclaimed and would otherwise resume as a second holder. | One extra read per heartbeat. |
| R17 | The tick's Linear client uses a 20 s timeout and 2 retries. | The defaults (30 s × 5 plus backoff, about 165 s) exceed the 180 s tick budget. | A slow but healthy Linear call fails a tick sooner; the next tick retries. |
| R18 | The secret scanner splits `NAME=value` and `NAME:value` before the key-context check. | Dotenv-style assignments were a false negative, and publish is where the scanner gates pushes. | Slightly more false positives on shell-like lines. |
| R19 | Approver comments during `review` classify as notes; the review-feedback message is built from comment events. | Resolved a Task 8 review question. | Not recorded in the ledger. |
| R20 | `attention` is a set (each code added once); `lastSeenUpdatedAt` advances after overrides are processed. | A persistent unauthorized label would otherwise grow attention every tick, and history would be re-read from claim time forever. | A missed override if Linear's `updatedAt` were non-monotonic (not observed). |
| R21 | From Task 9's review onward, each task loop ran as a Workflow with explicit per-role models. | Workflow agents need no panes and allow per-role models. | Fall back to forks (R15). |
| R22 | Role agents are launched by the coordinator through `orca terminal create` with per-role sandbox settings, then bound with `worker-start --terminal`; `--worktree new-child` is refused. Spec §8.1 amended. | The safety controls of §13.3(b)(c), the basis of D14, outrank §8.1's literal `worker-start --agent`, which would launch role agents without the kit's per-role settings. | One more launch path to maintain; Orca's terminal-bound dispatch is verified live only in slice 2. |
| R23 | Task 9's third fix round folded in the reviewers' safety items: kit dir readable but never writable in the sandbox, GitHub token variables blanked, more git paths denied, JSON refusals for internal errors, stricter shell quoting, a tracked `settings.local.json` left alone, repeated flags accumulated. | Each closed an agent-reachable gap cheaply. | Not separately recorded (folded into a fix round). |
| R24 | Claude pins the `--settings` file at launch, so sibling-worktree denies refresh only at (re)launch; accepted as a pilot residual under D14, refreshed before every launch. | Claude Code has no live settings reload. | A worktree created after an agent launched is not denied to that agent until its relaunch. |
| R25 | Task 9's safety Minors C1–C10 ran as phase 0 of Task 10 (spawn anchors, coordinator-only spawn, workers `[claude]`, coordinator denies, quoting, ref-name validation). | Each weakened a §13.3 control in a way an agent could reach. | One extra commit to review. |
| R26 | The journal covers Linear writes and the multi-step claim and publish entries; Orca mutations are idempotent through record state. Spec §6.6 and invariant I2 amended. | Slice-1 scope: record state already makes each Orca mutation safe to repeat-check. | A crash between an Orca mutation and its record write could repeat that one mutation, bounded by resume counting. |
| R27 | Task 10's operational Minors C11–C21 ran as phase 0 of Task 11; extra claimed→blocked causes accepted (spec §5.2.1 amended). | Each had live operational impact. | One extra review surface. |
| R28 | Git-trust hardening before any dispatcher git call: verify the gitfile and commondir, use explicit `--git-dir`/`--work-tree`, push to the configured URL, read diffs in text mode including type changes, refuse truncated reads, start the history range at the remote tip, run the repo setup command only on claim-created worktrees, write the allow-deps grant into `launch.json`. | The agent can write its gitfile and commondir and could otherwise point the dispatcher at agent-written git config. | One extra review surface. |
| R29 | `gh` always gets `--repo`; the claim base is GitHub's SHA from `ls-remote`; the OAuth client secret is read from stdin; the default `allowedDomains` are the npm and yarn registries. | Final security residuals of Task 12. | One extra review surface; per-repo domain additions are the owner's call. |
| R30 | `wingmate install` sets `core.useReplaceRefs=false` in each pilot repo and `doctor` blocks without it; agents may not write `refs/replace`; the post-create HEAD is re-read with the dispatcher's pinned git; commit-named refs refuse claims; runbook §16 states the remaining sub-second race. Spec §13.3(b)(h) and D14 amended. | Replace refs could defeat creating the worktree from GitHub's SHA. | One repo-config value per pilot repo (documented, reversible); commit-named refs from tools such as jj refuse claims. |
| R31 | When `~/.claude/settings.json` has no top-level `model`, tier `best` for Claude is the CLI's own default: no `--model`, effort max, recorded as model null and shown as "CLI default". | The live doctor found the key gone; spec §9.2 forbids hardcoding a model id. | The coordinator runs on whatever Claude Code defaults to, visible in the status comment and ledger. |
| R32 | One pre-merge hardening pass beyond the skill's single fix wave, for N1, N2, N3, R31, REL-5 and relaunch's Orca reads. | Each of N1–N3 and R31 would stop the slice-2 live pilot. | One more review cycle. |
| R33 | Parked: a coordinator rebind with an unreadable worker-list can adopt a live role agent after an Orca restart. Slice-2 fix: skip the candidate tier when the worker-list read fails. | Rare double fault; misdirected messages only; no trust-boundary impact. | An answer or note delivered to a reviewer or worker terminal in that window. |
| R34 | Live finding, fixed: doctor's Claude sandbox probe creates its scratch worktree at the commit Orca reports for doctor's checkout (else `origin/main`); a setup step Orca refuses is a failed check naming the step and code; each probe's crash is caught on its own so the Codex verdict is never lost. | The probe's first live run died on `origin/main` (no remote yet) and reported only `runtime_error`, dropping the Codex result. | The scratch worktree holds the checkout's commit rather than GitHub's main; both are owner-controlled in the documented flow. |
| R35 | Live finding, fixed: the probe classifier reads git's "unable to get password from user" as no credential. | Claude Code's shell sets `credential.interactive=false`, so that is git's "no credential" message; the probe could never prove the control. | None found: the message only comes when no complete credential was obtained, and a credential handed out still fails the probe. |
| R36 | Live finding, parked as the first slice-2 prerequisite: `orca` is unreachable from the kit sandbox, so coordinator-run `spawn` (R22) cannot start role agents and an issue stalls at planVerify, then asks. Slice 2 builds the spec's dispatcher-executed spawn; agents are not granted Orca's runtime file. | The kit denies Orca's runtime file, which holds the socket endpoint and an auth token; granting it would let agents start processes outside the sandbox (D14). Building dispatcher spawn is design work beyond slice 1's plan. | The pilot cannot complete an issue end to end until slice 2 lands dispatcher spawn. |

## Accepted deviations (unnumbered)

- Task 3: the schema's default cascade is `["claude"]`; a named `MaxWorking` schema replaces `.unwrap()`.
- Task 5: mapper deviations D1–D6 (static mappers, a Zod envelope, tolerant fleet and worker-stop shapes).
- Task 7: context-aware hex skip in the secret scanner; `providerFromLabels` dropped from the plan (no consumer); a
  corrupt provider settings file resolves to `model_unresolved`.
- Task 9: `--task` is refused `task_unsupported`; `worker-start` also gets `--worktree id:<wt>`; workers run at tier
  standard with no `--model`/`--effort`; Cursor and Antigravity are `launch_unsupported`.
- Task 10 (C20): a Blocked label on a parked record is the §7.4 pause; `block()` clears `paused`.
- Task 11 (D5): publish pushes the exact commit the guards checked (`<sha>:refs/heads/<branch>`); spec §13.3(d) amended.
- Task 12: `notify_test` is blocking (spec §16.1 row 6); install writes the automation disabled and enables it only
  after `doctor` passes; `stop` uses tracked compare-and-write records.
- R32 re-review: zero coordinator candidates means `exited`, not `unverifiable` (required by §5.5, §6.3, S2, S3).

## Parked and deferred

- Parked final-review findings, none pilot-blocking per triage: REL-4, REL-7, REL-8, SEC-4, SEC-5, SEC-6, TES-3–TES-6,
  INT-4, INT-6–INT-10 (INT-11 superseded by REL-2), R33 and the R32 re-review Minors. Details are in
  `final-review-report.md` beside the ledger.
- Spec features absent from slice 1 (runbook §16): resetting a reused worktree to its base (§5.4 step 3), Codex
  session-id capture, the 24 h question reminder, the soft budget notice, automatic Run adoption by coordinator handle,
  per-package checks for `allow-deps` (§13.3 e), evidence copy every tick, re-pointing notes queued while no Run exists,
  `launch.json` reinstall after a provider handoff, live verification of the park/resume process sweep.

## Owner decisions open

0. Role agents: approve dispatcher-executed spawn as the first slice-2 work item (R36). The interim alternative, letting
   the coordinator gate planVerify and the reviews itself, needs a protocol and gate change and gives up independent
   verification.
1. Codex: widen beyond reviewer-only, or exclude it (`verifyCross: false`) — R9.
2. Orca-issued tokens visible in agent shells (`ORCA_AGENT_HOOK_TOKEN`, `ORCA_AGENT_LAUNCH_TOKEN`,
   `ORCA_AGENT_TEAMS_TOKEN`, `CLAUDE_CODE_MESSAGING_TOKEN`): `doctor` names them, never their values; blanking them may
   break Orca's agent status hooks, so verify live first.
3. Per-repo additions to the sandbox `allowedDomains` — R29.
4. The pinned gate commands per pilot repo in `config/projects.yaml`.
