# Slice 2: pilot operations

The owner requested slice-1 validation and continuation into slice 2 on 2026-10-07.
Baseline at `92b4e07`: 803 tests pass; TypeScript and Biome pass. OAuth authentication and live metadata now work.
The live queue comparison found no eligible Todo issues; notification receipt still needs the owner's confirmation.

## Engineering sequence

1. Close R33: an unreadable worker list must prevent the fallback coordinator adoption in advance as well as reconcile.
2. Close R36: spawn becomes a local outbox intent. Only the dispatcher selects providers, checks quota and kit
   integrity, and launches role processes. The agent sandbox never receives Orca runtime access.
3. Use noninteractive, sandboxed terminal jobs for roles. Their stdout and exit status are captured by a dispatcher-owned
   runner outside the agent sandbox, under the issue kit. This is the spec §16.1 unsupervised-terminal fallback, explicitly
   labelled `terminal-job`; these jobs are Wingmate requests, not Orca Dispatches. Orca's injected worker lifecycle cannot
   operate without runtime access. This preserves independent review and read-only Codex execution without impersonating
   a worker's `worker_done`.
4. Persist request identity, cycle/attempt, input commit, role, provider, terminal/pane, settlement and notification state.
   Never automatically repeat an uncertain terminal create. Bound live roles and defer new starts on partial/paused ticks.
5. Capture the final provider result, reject malformed/failed/truncated output, publish file receipts, and resume the idle
   coordinator once a wave settles. Dependencies refer to Wingmate request IDs. Gates are cross-checked against the
   dispatcher's own settled results at the same commit; coordinator-written receipts remain advisory.
6. Record measured role usage when returned by the CLI and elapsed-time provenance otherwise. Add simulations for the relay,
   retries, quota, dependencies, stale results, cancellation and gate forgery. Re-run the full checks and live doctor.

## Pilot acceptance (spec §15.1)

After OAuth setup: compare dry-run queues; install disabled; verify doctor and automation read-back; confirm notifications;
complete a scratch Bouncr/iOS issue, then JRF-404's ask/park/resume; inspect JRF-401/402 before cleanup; roll out one issue each
to Smart Dispatcher, JR Learning Plus and JR Travel Atlas. Enable the five-minute automation only after these checks.
Live acceptance cannot be reported complete from simulations or missing credentials.

## Validation evidence

- Slice-1 merged tree `92b4e07`: 803 tests, TypeScript and Biome passed on 2026-10-07.
- R33 regression and dispatcher relay simulations pass, including file-only enqueue, one launch, final-result capture,
  dependency/quota deferral, uncertain-create recovery, cancellation, forged gates, stale plans and altered reports.
- Live noninteractive reviewer probe on 2026-10-07: both installed Claude and Codex read a fixture, failed to write to
  the read-only checkout, exited 0 and produced a parsed PASS. Claude reported 116,692 tokens including cache usage,
  $0.2955962; Codex reported 36,920 tokens and no dollar field. No unexpected write occurred. Raw CLI receipts were
  kept mode 0600 under `/tmp/wingmate-slice2-{claude,codex}-smoke.json`; the scratch fixture was removed. This verifies
  role CLI execution and parsing, not a live Orca launch or Linear workflow.
- Existing publish regression verifies reviewers against the exact commit selected for pushing, even if local HEAD
  moves during the guard reads. Review checks now use that same pinned commit.
- OAuth credentials were transferred from the owner's local file without printing their values, and stored in
  `~/.config/wingmate/credentials.json` with mode 0600. The original file is mode 0600 and locally excluded from Git.
  The app actor is Wingmate in the configured JRF workspace. The baseline dispatcher installed successfully disabled;
  all five pilot repositories now have `core.useReplaceRefs=false`, with no unsafe repository credential settings.
- Live saved-view creation exposed Linear's requirement that the creator own a new view. Install now leaves ownership
  with the app. Both shared views were created, favorited, and their board/list defaults configured; the owner is
  subscribed to issue additions in "Wingmate · Needs you".
- Missing ungrouped `allow-deps` was created in team JRF through the signed-in Linear interface and verified through
  the app API. Required workflow types and project IDs match the config. Doctor metadata now passes.
- Baseline full doctor sandbox probes passed: Claude blocked all ten denied probes and allowed the five required ones;
  Codex network isolation passed with the previously accepted outside-worktree read residual. Orca is unreachable from
  the kit sandbox. Bouncr web folder trust and the initial heartbeat remain warnings.
- Live scan and an independent Orca read agreed: the pilot queues contain no eligible Todo issues. Bouncr has JRF-403
  in Todo without an Agent label; the other three projects have no Todo issues. Legacy JRF-401/402/404 remain outside
  Todo and were not claimed.
- Notification fixture JRF-416 was created as the app, the owner subscribed, and doctor posted its notification test
  and set Needs-Human. Receipt confirmation remains pending. No issue pilot or automation enable has been completed.

## Current state

Engineering validation: `bun test` passed 839 tests with zero failures (73 files, 13,838 assertions);
`bunx tsc --noEmit`, `bunx biome check .`, `git diff --check`, compiled build and binary `config validate` passed.
New kits use dispatcher-owned reviewers and method loop; legacy kits remain compatible. The owner requested PR and
merge of these changes. The disabled baseline install has been validated live; install this code before running the
pilot acceptance checklist above. Do not enable the automation merely because the engineering checks are green.

## Parallel validation fixes

- Pending reviewer waves defer coordinator notes, nudges and stage recovery while preserving owner overrides,
  integrity and hard-budget checks. Settled results reset stage timers. Trusted exit receipts clear launch uncertainty.
- A hard token budget uses the measured lower bound when aggregate usage is incomplete; display totals remain unknown.
- Dispatcher reviewer requests reject `--prefer` synchronously because review policy selects the provider.
- Setup accepts one argv or a sequence; commands stop on failure and share the setup/tick deadline. Bouncr installs
  both packages with `npm ci`, then runs API typecheck through its package script in the correct working directory.
- Code/security reviews require clean committed tracked source/index at launch, settlement and gate verification.
  These checks are checkpoints, not an immutable snapshot: concurrent edits restored between checks remain a residual
  of sharing the worktree. Immutable review snapshots or separate isolation are needed to eliminate that race.
