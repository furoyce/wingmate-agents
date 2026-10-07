# Slice 2: pilot operations

The owner requested slice-1 validation and continuation into slice 2 on 2026-10-07.
Baseline at `92b4e07`: 803 tests pass; TypeScript and Biome pass. The live Linear queue comparison,
OAuth metadata and notification acceptance remain pending credentials and the owner's queue confirmation.

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
- OAuth credentials are still absent. No live Linear write, notification test, issue pilot, automation enable,
  GitHub push or merge has been performed for slice 2.

## Current state

Engineering work is implemented on `wingmate-slice-2`. Final validation: `bun test` passed 813 tests with zero failures
(70 files, 12,717 assertions); `bunx tsc --noEmit`, `bunx biome check .`, `git diff --check`, compiled build and binary
`--help` passed. New kits use dispatcher-owned reviewers and method loop; legacy kits remain compatible. The feature
branch has not been pushed, merged or installed. OAuth setup is the next operational step; then run doctor and the
pilot acceptance checklist above. Do not enable the automation merely because the engineering checks are green.
