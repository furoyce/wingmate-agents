# Wingmate runbook

This runbook is for operating the dispatcher day to day. For the one-time Linear setup and credential rotation, see
[linear-app-setup.md](linear-app-setup.md). Section numbers like §13.3 refer to the
[design spec](superpowers/specs/2026-10-05-wingmate-agents-design.md).

Conventions used throughout:

- `wingmate` is `~/.local/bin/wingmate`, the binary `install` built.
- `<state>` is `~/.local/share/wingmate`.
- `<ID>` is an issue identifier such as `JRF-404`.
- Commands that read the config (`stop`, `pause`/`resume`, `status --project`, `install`, `doctor`) must run where
  `config/projects.yaml` is. That means the `wingmate-dispatcher` worktree or any checkout of this repository.
  Alternatively, set `WINGMATE_CONFIG=<path>`.

Contents:

1. [What runs where](#1-what-runs-where)
2. [Daily routine](#2-daily-routine)
3. [Answering a question](#3-answering-a-question)
4. [Requesting changes after review](#4-requesting-changes-after-review)
5. [Stopping](#5-stopping)
6. [Re-queuing a blocked issue](#6-re-queuing-a-blocked-issue)
7. [Attention codes: claims, launches, liveness](#7-attention-codes-claims-launches-liveness)
8. [Attention codes: input, outbox, publish, cleanup](#8-attention-codes-input-outbox-publish-cleanup)
9. [Publish refusals](#9-publish-refusals)
10. [Why an issue is not picked up](#10-why-an-issue-is-not-picked-up)
11. [Incidents: Linear and Orca](#11-incidents-linear-and-orca)
12. [Incidents: tampering and the journal](#12-incidents-tampering-and-the-journal)
13. [Incidents: worktrees, trust dialog, notifications](#13-incidents-worktrees-trust-dialog-notifications)
14. [Cost](#14-cost)
15. [Upgrading](#15-upgrading)
16. [Known limitations and D14 residuals](#16-known-limitations-and-d14-residuals)
17. [Command reference](#17-command-reference)

## 1. What runs where

**The dispatcher.** It is the Orca automation `wingmate-dispatcher`, which runs every 5 minutes (`*/5 * * * *`) in the
long-lived `wingmate-dispatcher` worktree:

- Its precheck runs `<state>/bin/wingmate-<version> tick --precheck`, with a timeout of
  `defaults.dispatcher.precheckTimeoutSec` (default 240 s).
- The precheck never exits 0, so the automation's agent never starts. It exits 1 after acting or when idle, and 2 on an
  error or while paused.
- Orca's run history for the automation shows each run's precheck output: the tick summary as JSON (`outcome`,
  `reason`, the lists of issues acted on, `skipped`, `attention`, `quota`, `counts`). Whether Orca keeps that output for
  every run has not been checked live yet (spike results row 7).

**One tick** goes through these steps:

1. It takes the lock `<state>/tick.lock`.
2. It reconciles Linear, the Orca fleet and the local records.
3. It applies owner overrides, then works through the agents' outbox intents, answers, liveness, timers, kit integrity
   and budgets.
4. It removes worktrees of finished issues once their grace time has passed.
5. It claims at most `claimsPerTick` (default 2) eligible issues, within the concurrency caps.
6. It writes the queue and the heartbeat.

A tick has `defaults.dispatcher.precheckTimeoutSec` less 60 s (180 s by default), counted from the precheck's start. No
Orca wait runs past that deadline, no claim starts with less than 90 s left, and an external action after it ends the
tick with `tick_deadline` (section 11), so Orca never has to kill the precheck.

**Agents.** Each claimed issue gets one Claude coordinator in an Orca terminal of its own `wm-<id>` worktree. The
coordinator is sandboxed by settings the dispatcher writes under `<state>/kit/<ID>/`. Agents hold no credentials:
publishing, Linear writes and pushes are the dispatcher's.

**Files.** Everything is under `<state>`, except the two secrets under `~/.config/wingmate/`, which the agents' sandbox
cannot read:

| File | What it holds |
|---|---|
| `~/.config/wingmate/credentials.json` (0600) | The OAuth app's id and secret, and the cached app token. |
| `~/.config/wingmate/linear-token` (0600, optional) | Your personal key. Only `scan` and `tick --dry-run` use it, and only while `credentials.json` does not exist. |
| `heartbeat.json` | The latest heartbeat, from a `scan` or a `tick`. |
| `last-tick.json` | The latest tick's heartbeat. |
| `queue.json` | The last tick's queue, with a skip reason for each issue. |
| `queue.dryrun.json` | The plan that `scan` or `tick --dry-run` wrote. |
| `records/<ID>.json` | One record per issue. Past cycles are in `records/archive/`. |
| `journal/<entry id>.json` | One file per journaled external write (§6.6). |
| `ledger/global.jsonl`, `ledger/<ID>.jsonl` | The append-only event log. |
| `logs/wingmate.log` | The pino JSON log. |
| `install.json`, `doctor.json` | The current install, and the last doctor report (including the notification test). |
| `stop-requested.json`, `pause.json` | The stop flag and the paused scopes. |
| `kit/<ID>/`, `bin/` | The agents' settings, and the compiled binary. |

## 2. Daily routine

1. Run `wingmate status`. It prints Markdown; `--md` gives the same output, `--json` gives JSON. The report shows:
   - the dispatcher line: the latest heartbeat's kind, outcome, reason, time, duration and exit code;
   - a `Quota:` line when a provider's quota snapshot is stale (section 7);
   - the paused scopes, whether a stop is requested, and any state files that did not parse;
   - one row per active issue: Stage, Pipeline, Provider, Age, Waiting on, Cost, PR and Attention;
   - the last tick's queue, with skip reasons.

   Add `--project <key>` to see one project, or `--cost` to add the cost block (section 14).
2. Open **Wingmate · Needs you** in Linear. It lists the issues carrying `Needs-Human` (answer them, section 3),
   `Blocked` (section 6) or `Review-Ready` (review the PR, section 4).
3. Run `wingmate doctor --quick`. It runs every check except the live sandbox probe, which costs a `claude -p` run.
   - `FAIL` lines are blocking: `install --enable` refuses while any remains.
   - `warn` lines are not blocking. `heartbeat_fresh` warns when no tick has run for 15 minutes; `journal_clean` warns
     and names poisoned journal entries.
4. Act on any code in the status report's Attention column (sections 7 and 8).

A healthy dispatcher shows a heartbeat less than 5 minutes old with outcome `idle` or `work`. The reasons
`partial_fleet` and `gap` mean the tick was reconcile-only: it re-read everything but started no agent. A `gap` is the
first tick after more than 15 minutes without one.

## 3. Answering a question

A question arrives as a comment titled "**Wingmate needs your decision** on `<ID>`", with numbered options. The issue
carries `Needs-Human`. Meanwhile the coordinator is parked: its session is idle, no other process of the issue runs,
and it costs nothing.

To answer:

- Reply on the issue as yourself, with a number or free text, either in the question's thread or as a new comment.
- The next tick, within 5 minutes, picks the reply up. It writes the reply into the worktree's `.wingmate/inbox/`,
  points the coordinator at it, and swaps `Needs-Human` for `In-Agent`.
- Do not edit Wingmate's comments: status, question, blocked or completion. Your edits are never read, and Wingmate
  overwrites the status and completion comments.

The code accepts a comment as an answer only when all of these hold:

- it was created after the question;
- its author is in `workspace.approvers`. Anyone else's comment gets attention `unverified_input(<comment id>)` and is
  never forwarded;
- no agent of the issue was working in the 60 seconds before it. Otherwise the issue is blocked
  `self_answer_suspected`. To confirm the reply as the answer, post a comment whose first line is just `continue`
  (case does not matter). The tick then takes your most recent flagged comment as the answer.

Delivery limits:

- A tick delivers one answer per issue. If the coordinator's turn does not visibly start, the issue gets attention
  `resume_unconfirmed` and the next tick re-checks the pane before sending anything again.
- After two failed deliveries of the same answer, the issue is blocked `resume_failed`. Fix the terminal or worktree,
  then comment `continue`.

If the coordinator decides your reply does not answer the question, it asks again: it edits the question comment and
mentions you once more. Slice 1 sends no reminders and has no Console. To stop the issue instead of answering, add the
`human` label (section 5).

## 4. Requesting changes after review

A finished issue sits in **In Review** with `Review-Ready`, its PR attached and one completion comment.

**To request changes:**

1. Write your feedback as comments on the Linear issue. While the issue is in review, comments are collected, not
   delivered.
2. Move the issue from In Review back to In Progress. Any started state other than In Review works.

The next tick handles it as a resume (one of `resumesPerTick`); it does not happen while paused:

- `Review-Ready` becomes `In-Agent`, the stage becomes `working` at `implement`, and the gates from `implement` to
  `pr` reset, both on Wingmate's record and in the coordinator's own `.wingmate/gates.json`. The coordinator re-gates
  from `implement` with fresh evidence; the delivered note tells it so.
- Every comment an approver (you) made since the finish is delivered to the coordinator as feedback.
- The next `finish` pushes to the same branch, so the same PR updates, and edits the same completion comment.

Wingmate does not read reviews left on GitHub or in Linear Reviews.

**To accept:** approve and merge the PR on GitHub as usual. Linear's GitHub integration moves the issue to Done.
Wingmate then releases the issue (stage `done`) and removes its worktree after `cleanup.worktreeGraceHours` (default
24 h), once no open PR references the branch. If an open PR still references it, the issue gets attention
`cleanup_failed` and removal is retried daily.

**To drop the work:**

- Move the issue to Canceled. It is released and its worktree is removed after the grace hours.
- Or add `human`. It is released and its worktree is kept.

Moving an issue to Todo or Backlog releases it only while it is claimed, working or waiting on a question, not while
it is in review.

## 5. Stopping

| Control | What it does | When it takes effect |
|---|---|---|
| `wingmate stop --issue <ID>` / `--project <key>` / `--all` `[--reason <text>]` | Kill switch: stops agents and blocks the issues `owner_stop`. | At once, with no tick needed. |
| The `human` label (Agent group) | Releases that one issue. | At the next tick (5 minutes or less). |
| `wingmate pause [--project <key>]`, and `wingmate resume [--project <key>]` (or `pause --off`) | Makes ticks reconcile-only. | At the next tick. |
| Disabling the Orca automation | Stops new ticks. Running agents keep going. | At once. Run `wingmate stop` first. |

**How `wingmate stop` works:**

1. It reads the config first. If it cannot, it prints `stop flag NOT written: nothing was stopped (…)` and exits 2. Run
   it where `config/projects.yaml` is, or set `WINGMATE_CONFIG`.
2. It writes its entry to `<state>/stop-requested.json` before it contacts Linear or Orca. A running tick aborts
   before its next external action: `--all` aborts the whole tick (outcome `stopped`), while `--project` and `--issue`
   abort only their issues. Every later tick honors the flag too.
3. Without waiting for the tick lock, it stops each issue's agents:
   - workers: `worker-stop`, then `worker-abandon` when the worker is not proven exited;
   - the terminals of the issue worktree and its child worktrees;
   - a process sweep: SIGTERM, a 5-second wait, then SIGKILL.

   With `--all` it also sweeps any `wm-` worktree with a working agent that no record covers.
4. It blocks each active issue `owner_stop`: the `Blocked` label and one blocked comment. If Linear is unreachable,
   the issue is blocked on disk and the output says `Linear label and comment follow on the next tick for: …`.
5. It then clears its flag entry, printing `stop flag cleared`, and exits 0. It keeps the entry instead, prints
   `stop flag KEPT …` and exits 1, when an issue was `not blocked: <ID>:<code>`. Ticks stay stopped for that scope:
   fix the failure and re-run the same stop. A stop that finishes also clears older entries it covers, including one a
   crashed stop left behind.

   A line `could not verify stopped: …` (for example while Orca is down) also exits 1. Close what it names in Orca.

To resume a stopped issue, re-queue it (section 6).

**The `human` label.** At the next tick the issue is released: its agents stop, Wingmate's Lifecycle label is removed
(`Ready` comes back if the issue had it at claim), the stage becomes `released`, and Wingmate posts one comment. The
worktree is kept.

**Pause.** `wingmate pause` makes every tick reconcile-only: outcome `paused`, and the precheck exits 2.

- While paused, there are no claims, no answer deliveries, no relaunches, nudges or handoffs, and no publishing (a
  `finish` waits).
- Your Linear overrides and stops still apply.
- `pause --project <key>` does the same for that project's issues only, and skips its queue as `paused`.
- `pause` and `resume` touch only `<state>/pause.json`: no Linear or Orca call.

## 6. Re-queuing a blocked issue

A blocked comment reads "**Wingmate blocked `<ID>`** — `<reason>`: detail. Retained: branch, worktree. Next action for
you: …".

To re-queue:

1. Fix the cause, using the table below.
2. In Linear, remove `Blocked`, keep the issue's Agent label (`agent-ready`, `claude` or `codex`, added by an approver)
   and move the issue to **Todo**.

The next tick claims it as a new cycle. The old record is archived, the status comment is kept, and the worktree is
reused if it still exists. A reused worktree does not run the repository's setup command again.

For `budget`, `resume_failed` and `self_answer_suspected`, there is a shortcut: as an approver, post a comment whose
first line is just `continue`. The issue then resumes in place.

| Reason | Meaning | What to do |
|---|---|---|
| `owner_stop` | `wingmate stop` blocked it. | Re-queue it when you want the work to continue. |
| `launch_failed` | The coordinator never started: a claim step failed twice (a launch attempt cut off by the tick's deadline during its wait counts; one cut off before it began to wait does not), or the brief and one start nudge got no turn. | Look at the coordinator terminal in Orca (a dialog, an error), then re-queue. |
| `setup_failed` | The repository's `setup` command failed. The comment shows only the exit code. A setup cut off by the tick's time is not a failure: it is retried once (attention `setup_timed_out`). | Fix `setup` in `config/projects.yaml` or in the repository, then re-queue. |
| `base_mismatch` | The base did not verify as GitHub's base commit. A new claim checks it in the repository's main checkout before Orca creates the worktree, so nothing was created or run. A re-queue that reuses a worktree checks it there, before anything runs. The comment names both commits and says which case it is: **behind GitHub** (a stale clone, attention `base_mismatch`); **not in the history of GitHub's** base, does not resolve, or a ref named after that commit or a replace ref (`refs/replace/…`) exists (possibly rewritten, attention `base_diverged`); or it **cannot be verified** (no such branch on GitHub, no usable main checkout in Orca). | Behind GitHub: run `git fetch origin` in the main checkout, then re-queue. Possibly rewritten: do not fetch first. Section 12 keeps the evidence. Cannot be verified: fix `repos.<name>.base` or the repository's main checkout in Orca, then re-queue. |
| `kit_tampered` | A kit file changed, the worktree's `.git` file or `commondir` was redirected (`git_dir_tampered`), or a new worktree did not start at the verified commit (its HEAD read with Wingmate's own git), its HEAD or the replace refs could not be read, or a replace ref appeared while Orca created it. | Section 12. Treat it as a possible escape. |
| `cascade_exhausted` | A handoff was due (the coordinator exited twice, or asked for a handoff) and no untried provider was available. With the Claude-only cascade, every handoff ends here. | Look at the worktree, then re-queue when ready. |
| `grace_expired_no_cascade` | A stage passed its cap and grace with no activity, and no provider was left to hand off to. | Look at the work, then re-queue. |
| `provider_unavailable` | During a handoff, the next provider's model could not be resolved. | Set the provider CLI's default model, then re-queue. |
| `budget` | Usage went over `budgets.hardTokens`. | Comment `continue` to lift the cap. |
| `publish_guard` | A second publish refusal in this cycle. | Read the finding in `.wingmate/inbox/publish-*.md` (section 9), fix it, then re-queue. |
| `resume_failed` | The coordinator did not accept an answer twice. | Fix the terminal or worktree, then comment `continue`. |
| `self_answer_suspected` | A comment arrived while an agent was active. | Comment `continue` to take your latest flagged comment as the answer. |
| `worktree_gone` | The worktree of a parked issue was removed. | Re-queue: the new cycle uses a new worktree. Wingmate never re-creates the removed one. |

## 7. Attention codes: claims, launches, liveness

Attention codes show up in two places:

- the Attention column of `wingmate status` (and `issues[].attention` in `--json`);
- the tick summary's `attention` list, which carries only codes new in that tick.

The Linear status comment does not show them.

Codes without † clear themselves once the condition passes. Codes marked † stay on the record until the next cycle.

| Code | Meaning | What to do |
|---|---|---|
| `claim_step_failed` | A claim, replay or reroute step failed. The next tick replays it once, and a second failure blocks `launch_failed`. | Usually nothing. If it persists, run `doctor --quick` (`orca_reachable`) and read `ledger/<ID>.jsonl`. |
| `claim_failed` (summary only) | The claim threw. The half-made claim keeps its slot and is replayed next tick. | As for `claim_step_failed`. |
| `launch_not_ready` | The coordinator's screen did not become ready within the launch waits: 120 s, then up to 180 s more (120 s more after answering the folder-trust dialog), never past the tick's deadline. The next tick waits again; a second launch attempt that does not start the coordinator blocks `launch_failed`, even when the precheck was cut off during that wait. | Look at the terminal in Orca (section 13, trust dialog). |
| `launch_unconfirmed` | The brief was accepted, but no turn started. Later ticks accept the agent's own `stage.json` as proof; otherwise they send one start nudge, then block `launch_failed`. | Look at the terminal if it persists. |
| `relaunch_failed` | Starting a successor session failed in Orca. The relaunch still counts. | Check Orca. A further exit leads to a handoff or a block. |
| `setup_timed_out` | The repository's `setup` command did not finish before its timeout, which ends 30 s before the tick's deadline. It was stopped, and the next tick runs it again once; a second cut-off blocks `launch_failed`. | Warm the repository's package store in its main checkout, or raise `defaults.dispatcher.precheckTimeoutSec` (section 16). |
| `launch_argv_missing` † | The record has no launch argv to relaunch from. | Re-queue the issue. |
| `model_unresolved` † | The tier-best model could not be resolved (the provider CLI's default model). The replay or reroute waits. | Set `model` in `~/.claude/settings.json`; `doctor` checks this under `providers`. |
| `liveness_unverifiable` | Orca could not tell whether the coordinator is alive. Nothing is done about it while this lasts. | Check Orca (`doctor --quick`, `orca_reachable`). |
| `coordinator_ambiguous` | Orca no longer lists the coordinator's terminal or pane (after a restart), and more than one terminal of the issue worktree runs a live Claude or Codex agent that is not a reviewer or worker of the issue. Wingmate does not guess: liveness is unverifiable, and nothing is relaunched or created. | Close the terminals in that worktree that are not the coordinator (section 13). |
| `cap_passed` | A stage ran past its cap (`timers` in config) and got a nudge, or the coordinator idled through two nudges. The grace clock (`graceMin`, default 30) runs, and activity clears the code. If the grace expires with no activity, the issue is handed off or blocked. | Nothing, if the issue is progressing. |
| `worktree_gone` | The worktree is gone from disk. A parked issue is blocked; a working one counts as exited. | Section 13. |
| `integrity_unverifiable` | This tick could not run the kit integrity check (git unreadable in the worktree). That is never a block; it is retried every tick. | Run `git -C <worktree> status` if it persists. |
| `base_mismatch` † | The claim's base check failed and the issue is blocked: a clone behind GitHub, or a base that could not be verified. | Section 6. |
| `base_diverged` † | The claim's base check found a local base ref outside GitHub's history, one that names no commit, a ref named after GitHub's commit (`refs/heads/<commit>`, `refs/tags/<commit>`, …) that Orca could take for the base, a replace ref (`refs/replace/…`; any one refuses claims, yours included), or a `commondir` file in the main checkout's `.git`. The issue is blocked `base_mismatch`. | Possible tampering: section 12, before any fetch. |
| `blocked_unposted` | The issue is blocked on disk, but the `Blocked` label and comment are not posted yet (Linear was unreachable). The next tick posts them. | Nothing, unless Linear stays down (section 11). |
| `release_unverifiable(…)` † | A release, block, handoff or stop could not prove everything stopped. `terminals`: the bulk terminal close failed; a failed release is retried, and its code clears once a retry closes them. `run`: the Run's workers could not be listed. Dispatch ids: workers fenced with `worker-abandon` without proof they exited. | Check those terminals or workers in Orca and stop them by hand. |
| `tick_error` (summary only) | Processing this issue threw an unexpected error. It is retried next tick, and the ledger records the code. | If it repeats, read `logs/wingmate.log` and `ledger/<ID>.jsonl`. |

**`quota_stale`** is per provider, not per issue: Orca's quota snapshot for a provider Wingmate can start (to
coordinate, review or work) is older than `quota.maxSnapshotAgeMin` (360 min). It still counts as available (§9.1).
Every tick summary and heartbeat carry it as `quota: { <provider>: { attention: ["quota_stale"], ageMin } }` (`{}`
when every snapshot is fresh), and `status` prints `Quota: <provider> quota_stale (snapshot <n> min old)`. Orca
refreshes the snapshot on its own schedule (`orca account list` triggers no refresh), so there is nothing to run;
meanwhile the 80% and 90% caps rest on that old reading.

## 8. Attention codes: input, outbox, publish, cleanup

| Code | Meaning | What to do |
|---|---|---|
| `resume_unconfirmed` | An answer was delivered, but no turn start was seen. The next tick re-checks the pane, and a second failed delivery blocks `resume_failed`. | Nothing yet. |
| `possible_self_answer` | A comment arrived while an agent was active during a question. The issue is blocked `self_answer_suspected`. | Comment `continue` (section 3). |
| `unverified_input(<comment id>)` † | The commenter is not in `workspace.approvers`. Their comment is never forwarded. | Repost the content yourself if it matters. |
| `unauthorized_state_change` † | A state change was ignored: it came from someone who is not an approver, or arrived while an agent of the issue was working. | Redo the change yourself while no agent works. |
| `unauthorized_label_change` † | The same, for a label change. | The same. |
| `possible_self_close` | The issue went to Done or Canceled while an agent was active. Agents stopped once; the record and worktree are kept, and the close is not applied. | If you meant it, reopen the issue and close it again: a newer close made while no agent works releases it. If not, move it back to its previous state, which clears the code. |
| `inbox_unsafe` † | The worktree's `.wingmate` or `.wingmate/inbox` is a symlink or not a directory, so nothing was delivered. | Treat it as tampering: `wingmate stop --issue <ID>`, then inspect. |
| `outbox_unsafe` | `.wingmate/outbox` or one of its subdirectories is a symlink or not a directory, so no intent was read. | The same. |
| `intent_invalid` † | An outbox intent failed validation, or named another issue. It was moved to `outbox/invalid/`. | Usually the agent retries. The ledger has the error. |
| `intent_failed` † | An intent failed three counted times and was moved to `outbox/failed/`. | Read the `intent_failed` ledger events for the code, then comment on the issue or re-queue it. |
| `workers_live` † | An `ask` or `finish` was refused, and consumed, because workers were still live. | Nothing: the coordinator settles its workers and retries. |
| `stage_prerequisite` † | A `gate` named a stage whose earlier gates Wingmate's record does not show as passed (the coordinator's own `gates.json` lagged the record). The intent was dropped, uncounted, and the coordinator was pointed at the stage to re-gate. In a reconcile-only tick it waits instead. | Nothing, unless it repeats: then read the `intent_failed` ledger events. |
| `secret_detected` † | A note, question or follow-up from the agent held a secret-like token, so it was not posted. | Inspect the worktree. If a real credential leaked, rotate it. |
| `plan_verify_unverified` † | The `planVerify` gate comes from the coordinator's own report. Checking it against Orca's `worker-show` comes in slice 2. | Nothing (it is informational). |
| `publish_step_failed` | A publish step failed: push, PR, attachment, completion or Linear state. The finish retries on later ticks with its progress kept. | Read `ledger/<ID>.jsonl`; check `gh auth status` and the repository's `origin` (section 9). |
| `journal_poisoned` † | The publish journal entry failed three times and is never replayed. | Section 12. |
| `reroute_unknown_repo` † | The coordinator asked to move to a repository the project does not configure. The request was refused. | Nothing, or add the repository to the config. |
| `cleanup_failed` | After Done or Canceled the worktree was not removed: an open PR references its branch, or Orca refused. Removal is retried daily. This also covers a rerouted-from worktree that could not be removed. | Merge or close the PR, or remove the worktree in Orca yourself. |

## 9. Publish refusals

When the coordinator runs `finish`, the next tick checks the commit against these guards, in order:
`nothing_to_publish`, `path_guard`, `secret_detected`, `dependency_policy`, `validate_stale`. It then pushes that exact
commit to the configured GitHub URL, opens or reuses the PR, attaches it, and posts the completion comment.

A refusal pushes nothing:

- The finding goes to `.wingmate/inbox/publish-<id>.md`. Findings name patterns and paths, never values.
- The `security` gate becomes FAIL (`publish_guard:<code>`), and the pointer reaches the coordinator in the same tick.
- A second refusal in the same cycle blocks the issue `publish_guard`.

| Refusal | Meaning | Fix |
|---|---|---|
| `nothing_to_publish` | The branch has no commits beyond its base. | The coordinator commits its work, or asks you. |
| `path_guard` | A changed path matches `forbiddenPaths`: in the net diff or in any pushed commit, either side of a rename, deletions included. Nothing lifts this guard. | The commits are rewritten without the path. Change protected files yourself. |
| `secret_detected` | A secret-like token appears in an added line, a pushed commit or its message, or the PR or completion text. | The unpushed commits are rewritten (amend or squash); a fix committed on top does not clear it. Rotate the secret if it is real. |
| `dependency_policy` | A manifest or lockfile changed without an approver-granted `allow-deps`. The grant counts when it was added before the claim, or while the issue waited on a question. With the grant, any dependency change passes: slice 1 does not check the packages themselves (section 16). | Add `allow-deps` while the issue is parked, or drop the dependency change. With `allow-deps`, review the lockfile diff yourself. |
| `validate_stale` | `validate` is not PASS at the commit to publish, or its report does not show exit 0 for every pinned gate command. | The coordinator re-runs `gate validate` at HEAD. |
| `diff_too_large` | The diff or the pushed history exceeds the 8 MiB that the guards read in full. | Make the branch smaller (drop generated or binary files). |
| `push_rejected` | The push was rejected as non-fast-forward. Wingmate never force-pushes. | Put the new commits on top of the remote tip, or ask you. |

Some errors are not refusals: they fail the finish instead, and nothing is delivered to the coordinator.

- A failure inside a journaled step (push, PR, attachment, completion, Linear) gives attention `publish_step_failed`.
  After three failures the entry is poisoned (attention `journal_poisoned`), and a later retry starts a fresh entry.
- The pending `finish` is retried on later ticks.
- A "counted" error also counts against the intent itself: after three counted failures the intent is quarantined
  (`intent_failed`), and the coordinator must run `finish` again.

| Error | Counted | Meaning |
|---|---|---|
| `remote_mismatch` | yes | The repository's `remote.origin.url` does not name `repos.<name>.github`, or the configured value is not a GitHub URL. Fix one or the other. |
| `push_unconfirmed` | yes | After the push, GitHub does not show the pushed commit on the branch. |
| `branch_invalid` | yes | The record's branch breaks git's ref-name rules; refused before anything runs. Re-queue. |
| `git_failed`, `gh_failed`, `gh_shape`, `linear_*` | no | Infrastructure trouble, retried every tick. Check `gh auth status`, the network and Linear. |
| `gh_repo_invalid` | no | `repos.<name>.github` is not `owner/name`. Fix the config; until then every retry fails the same way. |

A redirected worktree `.git` file or `commondir` (`git_dir_tampered`) blocks the issue `kit_tampered` instead.
`base_mismatch` is refused at claim time, not at publish (section 6).

## 10. Why an issue is not picked up

`status` (the last tick's queue) and `queue.dryrun.json` (from `scan` or `tick --dry-run`) give each labeled issue in
the pilot projects either `eligible` or one of these reasons. Most reasons carry a detail in parentheses.

| Reason | Meaning |
|---|---|
| `not_todo` | Not a pilot project, not in an unstarted state (the detail names the state), or no Agent label. |
| `archived` | Archived or trashed. |
| `paused` | `wingmate pause`; the detail is `global` or the project. |
| `conflicting_agent_labels` | More than one Agent-group label. |
| `human` | The Agent label is `human`. |
| `unsupported_provider` | An Agent label that is not `agent-ready`, `claude` or `codex`. |
| `veto_label` | It already carries `In-Agent`, `Needs-Human`, `Review-Ready` or `Blocked`. |
| `has_open_children`, `prerequisite_open` | An open sub-issue, or an open blocking issue (named in the detail). |
| `live_owner` | A working agent in an Orca worktree linked to the issue, or an active Wingmate record. |
| `label_by_unlisted_actor` | The Agent label was added by someone not in `workspace.approvers`, or by a bot. |
| `provider_unavailable`, `quota` | The provider is outside `coordinatorCascade` (`codex` in the pilot), its quota is unreadable, or its quota is over the 80% weekly or 90% session cap. |
| `model_unresolved` | The provider CLI has no default model. |
| `cap_worktrees`, `cap_inflight`, `cap_global`, `cap_project`, `cap_provider` | A concurrency cap (§9.5): 8 live `wm-` worktrees, 6 in flight, 3 working (1 per project, 2 per provider). The detail names what holds the slot. |

The tick summary's `skipped` list adds five more reasons that never reach the queue file:

- `claims_per_tick`: an eligible issue waits for the next tick;
- `tick_budget`: an eligible issue, or the retry of a claim that has not started its coordinator yet, waits for the
  next tick because less than 90 s of this tick were left (a retry deferred this way is not counted);
- `reconcile_only`: a reconcile-only tick claims nothing;
- `stop_requested`: a stop covers the issue;
- `record_changed`: another writer, such as `wingmate stop`, changed the record during the tick.

## 11. Incidents: Linear and Orca

**The Linear app token is expired, or minting fails.** Wingmate re-mints the app token when fewer than 24 hours remain,
or after a 401.

- If minting fails while a tick builds its context, the precheck prints
  `{"outcome":"error","reason":"linear_token_mint_failed"}` and exits 2. No heartbeat is written, so `status` keeps
  showing the last good one and `heartbeat_fresh` starts to warn.
- A Linear failure while a tick reconciles ends with outcome `linear_error` and the code as `reason`. Agents keep
  running.

To fix it:

1. Run `wingmate doctor --quick`; `linear_auth` shows the detail.
2. Check network access to `api.linear.app`.
3. If the secret was rotated, or the app was removed from the workspace, re-run
   `pbpaste | wingmate install --client-id <id> --client-secret -` (see
   [linear-app-setup.md](linear-app-setup.md)), then `wingmate install --enable`.

`linear_app_required` means `credentials.json` is missing: install the app.

**Personal-key dry runs fail.** The reasons are `linear_credentials_missing`, `linear_token_file_mode`,
`linear_token_invalid` and `linear_http`. The setup guide's last section explains each one.

**Orca is down.**

- While the Orca app is not running, the automation does not run, so nothing ticks. There is nothing to do.
- When Orca is back, its missed-run grace decides whether a missed run still happens. The setting is
  `--missed-run-grace-minutes`, from `defaults.dispatcher.missedRunGraceMinutes` (default 10). The first tick after a
  gap of more than 15 minutes is reconcile-only (reason `gap`); the next tick is normal.
- If Orca runs but its CLI fails, ticks end `orca_unreachable` (exit 2).
- If the fleet read is partial, ticks are reconcile-only (reason `partial_fleet`), and issues show
  `liveness_unverifiable`. `wingmate doctor --quick` reports this under `orca_reachable`.
- Coordinators in Orca terminals keep running while the dispatcher cannot see them.
- `wingmate stop` still blocks every issue on disk while Orca is unreachable. It reports `could not verify stopped: …`
  and exits 1. Close those terminals once Orca is back.

**A tick ran out of time (`tick_deadline`).** `status` shows `tick error (tick_deadline)` and the precheck exited 2.
The tick passed its deadline (the precheck timeout less 60 s) and stopped before its next external action, after
writing its heartbeat. What it was doing resumes next tick: a launch cut short while it waited for the coordinator's
screen counts as one of its two attempts, so a launch that never gets its screen ready blocks `launch_failed` on the
next tick but one. A launch cut short before it began to wait does not count, and a retry that a tick has less than
90 s left for waits for the next tick (`tick_budget` in the summary), also uncounted.

- Once, after a slow tick (a cold `pnpm install` in a repository setup, a slow Linear or Orca): nothing to do.
- Every tick: look at the issue in `claimed` with the oldest timers (`wingmate status`) and its `ledger/<ID>.jsonl`.
  Warming the package store of a repository with a long setup helps; so does a longer
  `defaults.dispatcher.precheckTimeoutSec` (`wingmate install` writes it into the automation).
- If `heartbeat_fresh` warns while Orca's run history shows the precheck timing out, a tick was killed in a call that
  hung past the 60 s margin. Read `logs/wingmate.log` for the last call it started.

**Linear is down or rate-limited.** Ticks read first and abort before writing. A failed write is not replayed as such:
the operation that made it is retried on a later tick and works out again from Linear what to write. Questions, blocked,
handoff, release and completion comments, and follow-up issues are keyed: a retry sends the id of the first attempt and
first looks that id up in Linear, so each is posted once, even when Linear took a write whose answer was lost. A block
decided while Linear was down shows `blocked_unposted` until its label and comment are posted. There is nothing to do.

## 12. Incidents: tampering and the journal

**`kit_tampered` or `git_dir_tampered`.** The issue is blocked `kit_tampered` and its agents are stopped. The detail
names up to five changed paths, or the git link that moved. `git_dir_tampered` is the internal refusal raised when the
worktree's `.git` file, or its gitdir's `commondir`, no longer names the recorded git directories.

1. If you suspect more than one issue, or the detail says a new worktree did not start at the verified commit, its HEAD
   or the replace refs could not be read, or a replace ref appeared (a hook may have run as you), run
   `wingmate stop --all` and follow the rotation steps in [linear-app-setup.md](linear-app-setup.md).
2. Inspect the worktree:
   - `cat <worktree>/.git` should read `gitdir: <common dir>/worktrees/<name>`;
   - `cat <common dir>/worktrees/<name>/commondir` should name the common dir;
   - run `git -C <worktree> status`, and compare `.wingmate/` with `<state>/kit/<ID>/`.
3. Remove the worktree in Orca: Wingmate removes worktrees only after Done. Then re-queue the issue (section 6).

**`base_diverged`: a base ref outside GitHub's history.** The issue is blocked `base_mismatch`: the local `origin/<base>`
names a commit outside GitHub's history or none, or a ref stands in for GitHub's commit, either one named after it
(`refs/heads/<commit>`, `refs/tags/<commit>`, …) or a replace ref (`refs/replace/…`). Nothing was created or run. An
agent may have rewritten `packed-refs`: keep the evidence before anything fetches.

1. Copy `<common dir>/packed-refs` aside (the next step names it), and `<common dir>/refs/replace/` if it exists.
2. Unless the detail names replace refs or refs named after the commit (the base itself verified), check ancestry first:
   `grep '"base_mismatch"' <state>/ledger/<ID>.jsonl` gives `local`, `remote` and `verdict` in full;
   `git -C <main checkout> merge-base --is-ancestor <local> <remote>` exits 0 when the clone is only behind GitHub,
   1 or an error when the ref left GitHub's history. A ref that does not exist at all (no `show-ref` or `packed-refs`
   line) is only missing: fetch and re-queue.
3. Run `wingmate stop --all` and follow the rotation steps. Only then, in the main checkout, run `git fetch origin` and
   delete each ref the detail points at that you did not make (`git for-each-ref 'refs/**/<commit>'` lists those named
   after the commit). Any replace ref refuses claims in this repository, yours included: `git for-each-ref refs/replace/`
   lists them and `git update-ref -d <ref>` deletes each, as it deletes any ref. Then re-queue (section 6).

**A journal entry is poisoned.** `doctor` reports `journal_clean: poisoned: <ID>/<kind>`, and a publish also shows
`journal_poisoned`. A poisoned entry is never replayed.

1. Find it with `grep -l '"state": "poisoned"' <state>/journal/*.json`. Each file is one entry, with `issue`, `kind`,
   `key`, `steps` and `error`.
2. Fix the cause that `error` names.
3. For a publish whose `finish` is still pending, every tick retries with a fresh entry. That entry skips what GitHub
   already has: the pushed commit, and the branch's open PR. If the intent was quarantined (`intent_failed`), ask the
   coordinator to run `finish` again by commenting on the issue, or re-queue it.
4. Claim entries never reach the poisoned state: two failures block the issue `launch_failed` first.
5. Leaving a poisoned entry in place is safe: it is never replayed, and `journal_clean` is only a warning. To clear
   the warning once the issue has moved on, rewrite the entry's state atomically:
   `jq '.state = "abandoned"' <file> > <file>.tmp && mv <file>.tmp <file>`. Never edit journal files in place.

To read an issue's record, use `wingmate status --json` or `<state>/records/<ID>.json`. `wingmate issue <ID> show`,
run inside the issue worktree, shows that worktree's `.wingmate/` mirror and its pending intents.

## 13. Incidents: worktrees, trust dialog, notifications

**Somebody removed a worktree by hand.**

- Wingmate never re-creates it. The issue gets `worktree_gone`. A parked issue is blocked `worktree_gone`. A working
  one counts as exited, and a relaunch is impossible, so with the Claude-only cascade it ends blocked
  `cascade_exhausted`.
- Re-queue the issue for a new cycle. Its branch is still in the repository.
- After Done or Canceled, a worktree removed by hand is simply recorded as removed.

**Orca restarted while coordinators were running.** If Orca re-attaches the running terminals under new handles, the
next tick finds each coordinator by its pane, or else as the one terminal of the issue worktree that runs a live
Claude or Codex agent other than the issue's role agents (reviewers and workers), and follows it (ledger
`handle_rebound`). A terminal's title is never used: Orca shows the title the agent sets, not `wingmate <ID>`. A
relaunch adopts such a terminal (`terminal_adopted`) instead of starting a second coordinator. When more than one
terminal could be the coordinator, Wingmate does not guess: the issue shows `liveness_unverifiable` and
`coordinator_ambiguous`, and nothing is relaunched. Close the terminals that are not the coordinator (a session of
your own, a stray agent), and the next tick follows the one that is left. Whether Orca keeps terminals, pane keys and
their agent state across a restart has not been checked live (section 16). If a coordinator did end with the restart,
it is relaunched once as for any exit.

**The folder-trust dialog appears.**

- Claude may show "Is this a project you created or one you trust?" for a new worktree path, and the default answer is
  "No, exit". The launch answers it once (Down, Enter) for a worktree Wingmate created, and records
  `trust_dialog_answered` in the ledger. It never sends the brief into the dialog.
- If the screen is still not ready, the issue shows `launch_not_ready`, then is blocked `launch_failed`. Answer the
  dialog in the issue's Orca terminal, then re-queue.
- To prevent this, keep `doctor`'s `claude_trust` check clean: run `claude` once in each pilot repository's main
  checkout and trust it.

**The notification test fails.** `notify_test` stays FAIL, and `install --enable` refuses, until the test is
confirmed.

- `not run`: run `wingmate doctor --notify-test <ID>`.
- `asked on …`: wait for both notifications, then run `--confirm-notify`.
- `could not be posted: <code>`: the scratch issue is wrong (`notify_issue_active`, `notify_issue_missing`,
  `notify_issue_not_pilot`, `notify_issue_closed`) or Linear failed (`linear_*`).

If nothing arrives:

- check Linear → Settings → Notifications;
- check your subscription to "Wingmate · Needs you";
- if the app's comments do not notify at all, configure Linear's own team or project Slack notifications. Wingmate
  holds no Slack credential.

Then repeat the test on an open scratch issue.

## 14. Cost

`wingmate status --cost` adds a 7-day block covering the records, active and archived, that were updated in the last 7
days. It shows the total and a breakdown by provider, by project and by provenance, each with dollars, tokens, agent
minutes and sessions.

The provenance values follow §9.7:

- `measured-transcript`: usage read from the provider's local transcripts.
- `timed`: agent minutes only, from Orca's state intervals. The cost is unknown.
- `unknown`: no usage. It is shown as "—", never as 0.

**In slice 1 nothing records per-session usage yet.** Transcript collection comes in slice 4. As a result:

- the status comment's Cost row reads "— (unknown)";
- `--cost` shows no sessions;
- an optional `budgets.hardTokens` cap never triggers, because the token count stays empty.

Until then, these are the real spend signals:

- Claude's status line in each coordinator terminal;
- the provider quota windows from `orca account list` (claims stop at 80% weekly or 90% session usage);
- the full `doctor`, which spends one `claude -p` probe (about $0.75 in the 2026-10-06 spike).

## 15. Upgrading

1. Bring the dispatcher worktree up to date. The `wingmate-dispatcher` worktree, which `install` created from
   `origin/main`, is on Orca's branch `wingmate-dispatcher`:

   ```sh
   git -C <dispatcher worktree> fetch origin
   git -C <dispatcher worktree> merge --ff-only origin/main
   ```

2. Rebuild and re-point. Run this from that worktree or any checkout of this repository:

   ```sh
   wingmate install --enable
   ```

   `install` does the following:

   - it runs `bun install --frozen-lockfile` and `bun build --compile` in the dispatcher worktree, writing
     `<state>/bin/wingmate-<version>`. A running tick keeps its old binary; a new file replaces the old one by rename;
   - it points `~/.local/bin/wingmate` at the new binary;
   - it edits the automation's precheck to the new path;
   - it keeps `core.useReplaceRefs=false` set in each pilot repository's own config (a deliberate setting: Orca's
     checkouts then follow no replace ref an agent plants; doctor's blocking `replace_refs_disabled` reads it back). It
     writes only where the value is not false already, because that config is in every issue's integrity set: a change
     there blocks the repository's active issues `kit_tampered` at their next tick;
   - it updates the saved views, when the OAuth app is installed.

   `--enable` then runs the full doctor and switches the automation back on only when every blocking check passes.

A plain `wingmate install`, without `--enable`, leaves the automation **disabled** until you run
`wingmate install --enable`. Run `wingmate doctor --quick` afterwards: `binary_installed` and `automation_present`
must be `ok`.

## 16. Known limitations and D14 residuals

These are the D14 residuals: places where the agent trust boundary is weaker than the design intends.

- **Codex is reviewer-only.** Codex sandboxes do not block reads outside the worktree (§13.3 c), so Codex runs only as a
  read-only verifier or reviewer. `coordinatorCascade` and `workers` stay `[claude]` until you accept the D14 extension.
- **Agent settings are pinned at launch.** A running Claude session keeps the sandbox settings it started with. Deny
  entries for sibling worktrees created later reach it only at its next launch or relaunch.
- **Orca may be reachable from the sandbox.** If `doctor` reports `orca_from_sandbox` reachable, an agent can start
  processes outside its sandbox through Orca.
- **A `ui-smoke` page can reach the internet.** `ui-smoke` opens the agent's local dev server in Orca's embedded
  browser, which runs outside the agent sandbox with ordinary network access. Script in a page the agent wrote can send
  whatever the agent can read (source, ticket text) to any host, and the sandbox's network allowlist never sees it.
  Until the tab is limited to loopback, treat a `ui` PASS on a `ui.kind: web` repository as the agent's claim, and read
  every page and script the PR adds under the UI paths before you merge. Whether a dev server can even listen inside the
  sandbox (`sandbox.network.allowLocalBinding`, which the kit does not set) is also unverified: check it before the
  first web UI issue.
- **Orca restarts are unverified.** Coordinators are followed across re-issued terminal handles by pane key, or as
  the worktree's one live agent that is not a role agent (section 13). Check this on the first Orca restart of the
  pilot: `ledger/<ID>.jsonl` shows `handle_rebound`, and `wingmate status` shows the issue still working, with one
  coordinator terminal in its worktree. If Orca re-attached the terminal but lists no agent in its pane, Wingmate takes
  the coordinator for exited and starts a successor beside it: close the older one by hand.
- **Do not run your own Claude or Codex session in an issue worktree.** When Orca re-issues a coordinator's terminal,
  Wingmate finds the coordinator as the worktree's one live agent; your session beside it makes that ambiguous
  (`coordinator_ambiguous`, no relaunch until you close it), and once the coordinator has ended, your session would be
  taken for it.
- **Your user-level Claude `env` reaches every agent session unless blanked.** Claude Code applies the `env` block of
  `~/.claude/settings.json` to every session and its commands, the agents' too. The kit's settings set to empty every
  key there whose name says credential (`TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, `_KEY`, `CREDENTIAL`) and the GitHub
  and Linear token variables. Wingmate reads only the names, never the values, and refreshes the list before each
  launch. Claude's own `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` are left alone.
  doctor's sandbox probe fails when a variable the kit blanks is still set inside the sandbox
  (`credential_env_empty: still set for agents although the kit blanks them: …`) and refuses `install --enable` then.
  The likely sources are an `export` in your shell configuration that the agents' shells pick up, or a Claude Code that
  did not apply the kit's `env` block. Remove the export, or move the key out of the user-level `env`, for example
  into the settings of a project that is not a pilot repository. Any other variable whose name looks like a
  credential is listed as a note (`note: credential-named variables agents can see, not blanked by the kit: …`) and
  does not fail the check. When doctor runs from an Orca terminal, the note lists Orca's and Claude Code's own
  per-terminal variables (`ORCA_…`, `CLAUDE_CODE_…`, `GIT_CONFIG_KEY_0`). Agents can read every name in the note: if
  one is a real secret (exported by your shell), remove it from the shell agents start in.
- **Your git hooks do not run on the dispatcher's push.** For example, Git LFS `pre-push` does not run, so LFS objects
  are not uploaded. Push them yourself, or keep LFS files out of agent work.
- **PRs are not opened while paused.** A `finish` waits for a tick that may resume work.
- **Setup runs only in worktrees the claim created, and within one tick.** The repository's `setup` command never runs
  in a reused worktree (a re-queue). A replay of the claim that created the worktree runs it, even after a crash right
  after the create. Its timeout ends 30 s before the tick's deadline, so it gets about one to two minutes. A setup cut
  off there twice blocks the issue `launch_failed` (attention `setup_timed_out`). Before the pilot, warm each
  repository's package store (for pnpm, run `pnpm install` once in its main checkout), or raise
  `defaults.dispatcher.precheckTimeoutSec`.
- **Orca checks out the base a moment after the check (spec D14).** Before Orca creates a worktree, the claim verifies
  GitHub's commit in the main checkout and refuses any ref named after that commit (in any namespace) and any replace
  ref there. `install` sets `core.useReplaceRefs=false` in each pilot repository, so replace refs, packed or loose,
  cannot redirect Orca's checkout. After the create, Wingmate reads the new worktree's HEAD with its own git (not Orca's
  cached head) and lists replace refs again; a read that fails blocks the issue too. What remains is a sub-second race:
  a compromised agent of the same repository, running at that moment, plants a ref named after the commit between the
  check and Orca's checkout (agents can write `packed-refs` and most loose refs). Orca, running as you outside the
  sandbox, then checks out the agent's tree, and a hook in it (under a relative `core.hooksPath`, as husky sets) can run
  during the checkout. The HEAD re-read blocks the issue before the kit, the setup or a terminal, but cannot undo that
  hook. The dispatcher's own git reads (base checks, publish guards) ignore replace refs; the agent's `gate` runs in its
  sandbox and is advisory: the dispatcher re-checks at publish.
- **gh's and git's credential isolation is file-scoped.** Agents get an empty gh config dir and a gitconfig that resets
  `credential.helper`, but no OS credential store is closed off by Wingmate. A GitHub credential the sandbox can reach
  in the macOS keychain would answer gh's or git's own lookup. doctor's sandbox probe asks both from inside the sandbox
  (`gh_stored_token`, `git_credential_fill`, network-free) and fails if either hands back a credential. Re-run
  `wingmate doctor` after you re-authenticate gh or change git's credential helper. doctor's blocking
  `repo_credential_config` also fails while a pilot repository's own `.git/config`, which every agent of the repository
  can read, holds a `credential.*` setting, or a remote URL or `insteadOf` rewrite with a credential in it. Move such
  settings to your global git config and keep tokens out of remote URLs.
- **Agents can write the object store.** git does not re-check object contents when it checks files out, so objects an
  agent alters under names in GitHub's commit change what Orca's checkout of that commit writes, as a replace ref would,
  with no ref involved: no claim check sees it, and `core.useReplaceRefs=false` does not help. `git fsck` reports them.

The rest are slice-1 gaps:

- **No Console.** Blocked comments that suggest confirming in the Console mean: comment `continue`.
- **No 24-hour reminder for an unanswered question.**
- **Usage and cost are not measured** (section 14).
- **Mention markup is unverified.** The @mention markup in questions has not been checked live; your subscription to the
  issue is what carries the notification.
- **`planVerify` is not cross-checked against Orca** (`plan_verify_unverified`).
- **`ui-smoke` records screenshots only.** The redacted console and network capture of §13.3(f) is not built yet.
- **`allow-deps` admits any dependency change.** §13.3(e) wants each changed package checked when the grant is given:
  registry, exact version, a publish date at least 14 days old, at least 1,000 weekly downloads unless named in the
  grant, no install script outside `allowedBuildScripts`, and the `pnpm audit --prod` or `npm audit` result (§8.2 stage
  6). None of that is built in slice 1, so with the grant, the publish guard passes any manifest or lockfile change and
  the PR shows no evidence about the packages. Lifecycle scripts stay off by default during installs in the worktree
  (the kit writes `ignore-scripts=true` into each package root's `.npmrc`, which an agent could edit). Grant `allow-deps`
  only when you will review every added or upgraded package in the lockfile diff yourself: age, popularity and install
  scripts. The checks come in slice 2 or 4.
- **Deny rules are prefix matches.** An agent can get around them with `sh -c` or absolute paths. The sandbox is the
  hard layer.
- **A stale clone blocks claims.** After you merge a Wingmate PR on GitHub, the next claim in that repository blocks
  `base_mismatch` until `git fetch origin` runs in its main checkout. Fetch only when the comment says "behind GitHub"
  (the local commit is an ancestor of GitHub's). Anything else goes to section 12 first: a fetch overwrites the evidence.
- **The main checkout must be a plain clone.** A new claim checks its base in the repository's main checkout. If that
  checkout's `.git` is a gitfile or a symlink, every new claim there blocks `base_mismatch` (cannot be verified).
- **The commit author fields are not secret-scanned.** The author, committer and extra commit headers are a small
  unscanned channel.

## 17. Command reference

| Command | Exit codes |
|---|---|
| `wingmate status [--json\|--md] [--cost] [--project <key>]` | 0; 2 on a usage error. |
| `wingmate stop --issue <ID> \| --project <key> \| --all [--reason <text>] [--json]` | 0 when stopped and the flag cleared; 1 when something was not blocked, not verified, or the flag was kept; 2 on a usage error or an unreadable config. |
| `wingmate pause [--project <key>] [--off] [--json]`; `wingmate resume [--project <key>] [--json]` | 0; 2. |
| `wingmate doctor [--quick] [--notify-test <ID>] [--confirm-notify] [--rotate] [--json]` | 0 when ok; 1 when a blocking check failed (or `--rotate` did not finish its stop); 2. |
| `wingmate install [--enable] [--client-id <id> --client-secret -] [--json]` | 0; 1 when doctor refused `--enable`; 2. |
| `wingmate scan [--json]` | 0 when a tick would act; 1 when idle, paused or stopped; 2 on an error. Writes `queue.dryrun.json` and `heartbeat.json`. |
| `wingmate tick [--precheck] [--dry-run] [--json]` | Never 0. 1 after acting, idle, `lock_held`, `lock_lost` or `stopped`; 2 on `error`, `orca_unreachable`, `linear_error` or `paused`. |
| `wingmate config validate \| show [--file <path>]` | 0; 2. |
| `wingmate issue <ID> <verb> …` | The coordinator's verbs, run inside the issue worktree; `show` and `log` read its `.wingmate/`. |

Notes:

- `scan --dry-run` is accepted and means the same as `scan`.
- `tick` and `scan` always print JSON; `--json` changes nothing.
- An error that escapes a command prints `<code>: <message>` and a `next:` line on stderr, and exits 2.
- `doctor`'s checks are:
  - blocking: `config_valid`, `linear_auth`, `linear_meta`, `orca_reachable`, `providers`, `replace_refs_disabled`,
    `repo_credential_config`, `binary_installed`, `automation_present`, `sandbox_settings`, `sandbox_probe` and
    `notify_test`. `codex_sandbox` is
    blocking whenever Codex can run at all (`verifyCross`, or `codex` in the cascade or the workers), which it can in
    the pilot;
  - warnings only: `claude_trust`, `heartbeat_fresh`, `journal_clean`, `orca_from_sandbox` and `d14_extension`, plus
    `sandbox_probe` when skipped by `--quick`.
