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

Remote `main` includes the dispatcher role relay (PR #2, 839 tests), Bun correction (PR #3, 845), Linear reconciliation
and ask-first guidance (PR #4, 852), disabled native UI foundation (PR #5, 871), per-repository trusted runtimes
(PR #6, 888), and configuration pinning (PR #7, 893). Each merge preserved the exact tested tree. The latest implementation
merge is `3ac97673c2a414816b4cf3d18d7e5aed9f779ce7`, matching tested head `3404f142da717ccc9653c1e9c90882b94efdf7cb`;
893 tests, TypeScript, Biome, diff checks, compiled build and binary config validation passed.

The dedicated dispatcher was fast-forwarded and installed **disabled** at `2026-10-08T04:13:25.276Z`, binary SHA-256
`0b27200c41d74e49f0c988048e4dbdb3b7d375aea77edba40bb177dfd7dc3f5b`. Its install receipt and live automation precheck
pin `/Users/jujufugh/.config/wingmate/pilot-projects.yaml`. This owner-controlled private config selects persistent Node
24 for Bouncr API and Node 22 for the other three pilots, leaving global Node/Bun defaults unchanged. Full doctor at
`2026-10-08T04:14:45.873Z` passed every blocking check, including ten blocked and seven required allowed sandbox probes.
Executing the actual precheck from `/tmp` with a conflicting inherited `WINGMATE_CONFIG` also succeeded with an idle tick
(exit 1, as designed). Hashed receipts and the full test log are under
`~/.local/share/wingmate/evidence/config-pinning-20261008/`; earlier runtime/native evidence is under
`~/.local/share/wingmate/evidence/runtime-native-20261008/` and `runtime-fix-20261008/`.

JRF-417 cycle 2 reused its clean worktree with a fresh coordinator and refreshed kit after cycle 1 was archived.
Normal guidance followed by interrupt steering was proven on screen during intake; this is **assisted intake**.
The coordinator parked at `2026-10-08T03:40:46.731Z` on question `01M4CSJ27VZ2K6P1ZP20KXHNC0`. The owner approved
the one-file/seven-test plan in thread reply `27fbe379-7d4b-48a1-9dfd-947db2349b3c`; tick 18 at
`2026-10-08T04:00:14.794Z` authenticated the answer and resumed the existing coordinator. The independent plan review
passed, and the coordinator committed only `api/tests/friendCode.test.ts` at
`19c70fb7c0752a2e54f7322cf4a7db80432713c6`. Coordinator checks passed under Node 24.21.0: API 56/56, API typecheck
and mobile verify. The first independent code review returned FAIL because mobile verify rebuilds files and the reviewer
is read-only; it found no implementation defect. Preserve that failed result and require a fresh independent review,
followed by the CLI-computed pinned gates. Operator guidance was applied to distinguish read-only review from workspace
rebuild validation; the coordinator preserved the first report and queued fresh request `01M4CVTW4ZXY3YS9Q5DFGY9740`
at the same commit. This is assisted review recovery. Full scratch completion is still pending at this checkpoint.

The current legacy kit uses an explicit official `/tmp` Node 24 PATH prefix; its sealed settings were not rewritten.
A bounded sandbox probe confirmed parent/child Node, npm and Git under those unchanged settings. The sandbox's codesign
check reported an invalid signature, while independent owner-side verification of the identical binary passed and matched
the official archive. Preserve that qualification rather than claiming reproduced binary corruption. Receipts are in
the private runtime/native evidence directory above.

Native policy remains unconfigured. The default adapter refuses execution; the isolated producer, execution host and
foreground bundle/PID/AX contracts remain unimplemented. See [native prerequisites](../../native-ui-relay.md).
JRF-404's resolved timing clarification does not replace its new ask/park/resume cycle or native UI proof.
JR Learning Plus pilot JRF-418 and JR Travel Atlas pilot JRF-419 are scoped Todo tickets without Agent labels, so they
remain unclaimed. Smart Dispatcher still needs its Crew overlap/reservation preflight before its pilot is queued.
Its proposed dispatch-logic test has no observed collision, but concurrent append-only `WORK_LOG.md` entries and the
repository's draft-PR-at-first-commit convention need an explicit trusted operator procedure. Wingmate publishes at
finish and can reuse an existing draft, but does not refresh its body or mark it ready. Do not count a clean Crew run
on an unchanged checkout as a reservation for future files, or claim that those lifecycle steps are automated.
Complete scratch acceptance, JRF-404's lifecycle check and the other repository pilots before enabling automation;
engineering checks and planning results alone do not establish end-to-end acceptance.

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
