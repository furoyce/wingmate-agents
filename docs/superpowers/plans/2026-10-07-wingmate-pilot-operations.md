# Slice 2: pilot operations

The owner requested slice-1 validation and continuation into slice 2 on 2026-10-07.
Baseline at `92b4e07`: 803 tests pass; TypeScript and Biome pass. OAuth authentication and live metadata now work.
The initial live queue comparison found no eligible Todo issues. The owner subsequently confirmed both notification channels.

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
  and set Needs-Human. The owner confirmed both notifications; quick doctor recorded confirmation at
  `2026-10-08T03:04:41.910Z` with no blocking failures. Needs-Human was removed and the fixture moved to Done.
- PR #2 merged at `6e08278056d47cd030332587bd5ff167217812a8`; the merged tree matched the tested head.
  The dedicated dispatcher was fast-forwarded and installed disabled. Full doctor on that binary passed its blocking
  sandbox, auth, metadata and install checks; notification confirmation above closes the remaining notification check.
- JRF-401/402 legacy branches had no unique commits and their PRs were merged. Ignored JRF-402 web logs were archived
  with hashes under `~/.local/share/wingmate/evidence/legacy-JRF-402/`; original worktrees, sessions, issue states and
  source logs were preserved. JRF-402 still needs authenticated production acceptance.
- The owner clarified JRF-404: store/display microsecond units while retaining the current 60 Hz simulation. The answer
  was recorded as an owner comment; actual timing precision must be described accurately. The old session was not resumed.
- Scratch JRF-417 was claimed from the sole eligible queue entry into a new clean Bouncr worktree at
  `3ea70aa443e0c5d7997085b6e27c99b847ef342a`; both setup commands passed. The coordinator could not proceed because
  the Bun 1.3.9 executable lost inherited role environment in the unchanged macOS sandbox. Wingmate stopped the cycle
  through its supported stop command before any plan, source changes or reviewer request. This attempt is not acceptance.
- A verified, isolated Bun 1.4.2 compiler preserved role environment and child-process environment under the same sandbox.
  A rebuilt actual CLI returned the expected bounded refusals for incomplete spawn and gate commands with unchanged
  outbox, gates and record snapshots. The system's default Bun was left unchanged. This verifies runtime compatibility,
  not completion of the scratch workflow. Install now requires Bun 1.4.2 or newer; compiled executables disable automatic
  project configuration/environment loading. Doctor requires role-context and child-Git probes before pilot retry.

## Current state

PR #2 engineering validation passed 839 tests with zero failures (73 files, 13,838 assertions), TypeScript, Biome,
diff checks, compiled build and binary config validation. New kits use dispatcher-owned reviewers and method loop;
legacy kits remain compatible. The installed automation remains disabled. PR #3 merged the runtime correction at
`46d8b500d38abc623e66b8ca1a104c4e6ff6ae87`; the merged tree matched the tested head. The dedicated dispatcher was
fast-forwarded and installed disabled at `2026-10-08T03:20:31.069Z`, binary SHA-256
`0d4e5ed2adf9ccad70d59f43dd8a4a7c53ae92993a1b2cb2d4b805a0b27661f5`.
Full doctor at `2026-10-08T03:21:47.992Z` passed every blocking check, including ten blocked and seven required allowed
sandbox paths and notification confirmation. Evidence and hashed receipts are in
`~/.local/share/wingmate/evidence/runtime-fix-20261008/`. JRF-417 was requeued through Todo/Ready; cycle 1 was archived,
cycle 2 reused its clean worktree with a fresh coordinator and refreshed kit, and intake passed. Full scratch completion,
JRF-404 ask/park/resume, native iOS UI relay and the other three repository pilots remain pending.
Do not enable the automation merely because the engineering checks are green.

The runtime correction passed 845 tests with zero failures (73 files, 13,895 assertions) using the isolated Bun 1.4.2
compiler. TypeScript, Biome, diff checks, compiled build and binary config validation passed. Independent review found
no remaining blockers after requiring a valid HEAD before dispatcher gate mutations and testing nonzero child Git exits.

The retry exposed Linear event issues: app-authored comments may appear as ordinary user comments, and the live API
returns history newest first despite `orderBy: createdAt`. Reconciliation must use protected comment receipts and
chronological event selection, without giving app identities or body markers owner authority. The coordinator command
reference also needs complete gate examples and the explicit ask-first intake rule from spec §8.3.
The event and protocol correction passed 852 tests with zero failures (73 files, 13,907 assertions), TypeScript,
Biome and diff checks. Live history ordering was verified through a read-only app query. The scratch coordinator
received one bounded guidance message to finish planning and use the ask-first question; this attempt therefore
includes assisted intake and must not be described as an entirely unassisted workflow.

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
