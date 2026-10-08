# Slice 2: pilot operations

## Current state

The latest remote implementation is [PR #9](https://github.com/furoyce/wingmate-agents/pull/9), merged at
`90b9f31ebc4ecd8543e265782ef44ae9d2b57062` at `2026-10-08T04:58:31Z`. Its tree
`5ae196f328b09bdad2c5d6a2e31a7bb6e5261184` matches tested head `688b239b013e64493fa5be129c90ecfcc718a538`:
900 tests passed, 0 failed, with 14,408 assertions across 76 files; TypeScript, Biome, diff checks, compiled build and binary
config validation passed. Oversized finish summaries now refuse instead of silently truncating; the exact whole-word
completion excerpt is scanned before posting, and queued refusals deliver an actionable correction without bypassing
the existing relaunch cap. The feature branch was deleted on GitHub; its Orca-managed worktree was retained.

PR #8 merged at `09676c9f1f2c89d4fb5c810960c9e69cdb6ba41e`, preserving tested head
`815f5329632b72db665c074f7f7760b042b9aabe` and tree `6e485363fd018a5f124df643270aeb4d788bcef0`.
PR #8 updated the reviewer prompts and coordinator protocol to clarify read-only review responsibilities without changing
gates, sandbox permissions or sealed kits, and documented the unimplemented native infrastructure. Its focused existing
suite passed 72 tests; TypeScript, Biome, diff checks, compiled build and binary config validation passed.
The prior implementation baseline (PR #7 at `3ac9767`)
passed the full 893-test suite. Engineering validation is not end-to-end pilot acceptance.

The current dispatcher is PR #9, installed **disabled** at `2026-10-08T05:01:44.678Z` while JRF-404 was parked, binary SHA-256
`bd30f46bce1c6739e2f16f2c272254490cd74b8d36bcbe5120d949a180f8d3ab`. Its install receipt and live automation precheck
pin `/Users/jujufugh/.config/wingmate/pilot-projects.yaml`. This owner-controlled private config selects persistent Node
24 for Bouncr API and Node 22 for the other three pilots, leaving global Node/Bun defaults unchanged. Quick doctor at
`2026-10-08T05:02:48.364Z` passed all blocking checks. The prior full doctor at `2026-10-08T04:14:45.873Z` passed ten blocked
and seven required allowed sandbox probes. The actual precheck previously succeeded from `/tmp` with a conflicting
inherited `WINGMATE_CONFIG` (idle tick exit 1, as designed). Latest release logs are under
`~/.local/share/wingmate/evidence/finish-summary-20261008/`; its `SHA256SUMS` digest is
`684049e68dec44806906cbcea1e5e6b26b1145cda6073335902c67485851a611`. Install, quick-doctor and disabled-automation/precheck
receipts are under `finish-summary-install-20261008/`, manifest digest
`86e1b2448f4c93f9a8612e778f53230e51e300f38a734723aeac6f33bdec132f`. Prior evidence remains under
`review-guidance-20261008/`, `config-pinning-20261008/`, `runtime-native-20261008/` and `runtime-fix-20261008/` in the same
private evidence directory. Existing sealed kits remain unchanged.

JRF-417 cycle 2 reused its clean worktree with a fresh coordinator and refreshed kit after cycle 1 was archived.
Normal guidance followed by interrupt steering was proven on screen during intake; this is **assisted intake**.
The coordinator parked at `2026-10-08T03:40:46.731Z` on question `01M4CSJ27VZ2K6P1ZP20KXHNC0`. The owner approved
the one-file/seven-test plan in thread reply `27fbe379-7d4b-48a1-9dfd-947db2349b3c`; tick 18 at
`2026-10-08T04:00:14.794Z` authenticated the answer and resumed the existing coordinator. Independent plan review passed,
and the coordinator committed only `api/tests/friendCode.test.ts` at `19c70fb7c0752a2e54f7322cf4a7db80432713c6`.
Coordinator checks passed under Node 24.21.0: API 56/56, API typecheck and mobile verify.

The first independent code review returned FAIL solely because mobile verify rebuilds files and the reviewer is
read-only; it found no implementation defect. That failed report remains visible. Operator guidance separated source
and evidence review from workspace rebuild validation; fresh request `01M4CVTW4ZXY3YS9Q5DFGY9740` returned PASS at the
same commit. The CLI-computed validate gate passed every pinned command, and UI was correctly NA for the test-only diff.
This is **assisted review recovery**, not an unassisted acceptance claim.

The first security review also returned FAIL, based on a review-spec requirement to reject typed look-alike/invisible
characters rather than normalize them. Independent reconciliation checked the approved contract: canonical codes must be
rejected when invalid, while typed input follows the existing normalization rules. Production normalization and routes
are unchanged by this one-file test commit. Preserve the failed result and disclose the existing non-ASCII cases;
this correction does not approve every existing normalization choice. The review spec was clarified with operator assistance, and fresh independent
security request `01M4CWN8Q7THDFPZNBCAE10F06` returned PASS at the unchanged commit. Tick 37 settled its protected report;
tick 38 passed the computed security/publish checks and opened [Bouncr PR #3](https://github.com/furoyce/bouncr.lol/pull/3)
at exact head `19c70fb7c0752a2e54f7322cf4a7db80432713c6`. The protected record is at `review` and Linear read-back confirms
In Review with Review-Ready. A nonpartial bounded read returned five comments and one attachment, with no more pages,
verifying the exact PR attachment and one completion comment bound to its confirmed dispatcher creation receipt.
This demonstrates **assisted scratch publication**; formal unassisted and native acceptance
remain incomplete. The dispatcher's truncated PR body was preserved and repaired by the trusted operator, with final
read-back at the same head; this is additional publication assistance, without source or gate changes. Narrow hashed
evidence, both review FAILs and the original/final PR bodies are preserved under
`~/.local/share/wingmate/evidence/scratch-JRF-417-20261008/`.
Parented follow-up JRF-421 is Backlog without an Agent label and separately tracks the
non-ASCII normalization policy decision.

JRF-417's legacy kit uses an explicit official `/tmp` Node 24 PATH prefix; its sealed settings were not rewritten.
A bounded sandbox probe confirmed parent/child Node, npm and Git under those unchanged settings. The sandbox's codesign
check reported an invalid signature, while independent owner-side verification of the identical binary passed and matched
the official archive. Preserve that qualification rather than claiming reproduced binary corruption. Receipts are in
the private runtime/native evidence directory above.

JR Learning Plus JRF-418, JR Travel Atlas JRF-419 and Smart Dispatcher JRF-420 are prepared Todo pilots without Agent
labels and remain unclaimed. Smart's actual Crew preflight exited 0 at `db16d95`; its `myFiles` was empty, so this was
not a reservation for the planned scope. An assisted early-draft operator procedure is arranged for the repository's
first-commit draft-PR convention and append-only `WORK_LOG.md` coordination. Wingmate publishes at finish and can reuse
an existing draft, but does not refresh its body or mark it ready; those operator steps are not automated acceptance.

The native infrastructure question remains pending: no VM is configured and no isolated producer or production adapter
has passed acceptance. Native policy remains unconfigured and the default adapter refuses execution; foreground
bundle/PID/AX contracts remain unimplemented. See [native prerequisites](../../native-ui-relay.md).

JRF-404 was manually requeued through trusted owner actions, with read-back confirming Todo + Ready and the retained
agent-ready label. Manual tick 1 at `2026-10-08T04:42:34.357Z` claimed it into new worktree `wm-jrf-404` from
`3ea70aa443e0c5d7997085b6e27c99b847ef342a`, Wingmate cycle 1, with fresh coordinator session
`007bf822-8f0f-4b5e-a808-78ea802017d3`. The legacy session was not resumed. Manual tick 2 at
`2026-10-08T05:00:15.300Z` collected its ask and genuinely parked the coordinator at `2026-10-08T05:00:19.096Z`, question
`01M4CY2BGQ8RNATJ0E35H1N81D`, Linear comment `5a2a8779-980d-4e15-8add-73b6c1ca2043`. The proposal is
`.wingmate/question.md`; no implementation plan exists yet.

Independent operator review added `.wingmate/approval-review.md`, correcting mixed-version writers and step-timed cohort
minima, nullable bigint storage, latest-run scope and pause/background/completion timing. It requires real disposable DB
validation and trusted native UI evidence before publication. At this checkpoint, the owner has been asked to approve
the corrected scope; no answer has arrived, no approval or resume is claimed, and the record remains `awaiting-human`. The original question
and sealed kit are unchanged. This is **operator-assisted proposal review**, not completed lifecycle or native acceptance.
The original proposal, corrections, parked-record projection and qualified probe facts are preserved under
`~/.local/share/wingmate/evidence/JRF-404-intake-20261008/`, manifest digest
`9774c1ba28211a01cfb9c59f15efe4813e3f93c0bbf4e47774264b632fb69de3`.

The fresh session confirmed plain, unprefixed Node 24.21.0 and npm 11.19.0. Baseline suites have **not** run. The disposable
DB probe was rejected before execution by a configured permission rule, with no fuller reason recorded; no retry ran.
This does not establish OS-level PostgreSQL unavailability or justify bypassing the validation requirement. Complete the
remaining scratch/native acceptance, JRF-404's authenticated answer/resume check and the other repository pilots before
enabling automation. Automation remains disabled, and JRF-418/419/420 remain unclaimed without Agent labels.

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
- The initial live scan and an independent Orca read agreed: at that time the pilot queues contained no eligible Todo
  issues. Bouncr had JRF-403 in Todo without an Agent label; the other three projects had no Todo issues. Legacy
  JRF-401/402/404 were outside Todo and were not claimed.
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
