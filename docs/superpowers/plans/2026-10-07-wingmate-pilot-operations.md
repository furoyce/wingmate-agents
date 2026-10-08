# Slice 2: pilot operations

## Current state

**DRAFT snapshot at `2026-10-08T23:33:44Z`; final cutoff and formal pilot acceptance remain pending.** The dated checkpoint below is retained
as history. Owner slice-2 acceptance and the assisted pilot continuations remain recorded; independent gates, repository
pilots and formal unassisted/native acceptance under spec §15.1 remain required. Automation is **disabled**.

[PR #14](https://github.com/furoyce/wingmate-agents/pull/14) added five resume-cap contract simulations; its full suite passed
929/0. [PR #15](https://github.com/furoyce/wingmate-agents/pull/15) corrected the role runner's UTC completion timestamp
format. Its generated-runner regression and full 929/0 suite passed; it was installed disabled before PR #16 replaced it.

[PR #16](https://github.com/furoyce/wingmate-agents/pull/16), merged at `6be70d4765ec9d9b6c6bb3c633add4a018f5ef68`,
passed 934/0; focused checks passed 49/49. It prevents a second terminal input after confirmed role-result resumption or
accepted owner-note delivery; deferred notes retain their cursor and working child-Run mailbox notes enqueue without a turn.
It was installed disabled at `2026-10-08T21:35:48.778Z`, binary
SHA-256 `d254e17bd775ecc0f3daf9e0faf54c1da742de93f9d4d46f030269ceeba16a27`, before PR #17 replaced it.

[PR #17](https://github.com/furoyce/wingmate-agents/pull/17), merged at `8771754b96b6af8fe772706c8596cbe9eff65811`
at `2026-10-08T21:51:28Z`, passed 951/0 with 20,072 assertions across 78 files; affected checks passed 103/103.
Gate commands stay pending until the dispatcher saves and acknowledges the canonical decision; coordinators must end
their turn and hold HEAD and plan until acknowledgement. It was installed disabled at `2026-10-08T21:51:49.393Z`
before PR #18 replaced it; earlier stale-gate and intermediate test failures remain qualified in its archive.

The current dispatcher is [PR #18](https://github.com/furoyce/wingmate-agents/pull/18), merged at
`fa4969296e7fe464421f343be9a16e4c074faceb` at `2026-10-08T22:02:27Z`. Its tree
`248e3e05fba7693bff326a85157de31e5316c67b` matches tested head `1bbd3e3b08404d9967e4a7a9713a505825ab6801`.
Final checks passed **958 tests, 0 failed**, with 20,744 assertions across 78 files in 118.52 seconds; focused checks passed
61/61. TypeScript, Biome, build, binary config validation, diff and secret-pattern checks passed. Role/native result
notifications now save either actual terminal-acceptance stage as notified and spend one resume; deferred or unsafe delivery stays pending.

PR #18 was installed **disabled** at `2026-10-08T22:02:40.474Z`, binary SHA-256
`7b4465e6dff920cd3a41b56ecb4130ed2b3cec71abae28da6f558258cdb9a038`. Quick doctor at
`2026-10-08T22:03:01.922Z` returned `ok=true` with 15 checks; only workspace trust and the skipped sandbox probe remain
nonblocking gaps. Actual automation read-back is `enabled=false`; the owner's config with five projects and six repositories,
sealed kits and global runtime defaults remain preserved. The live `22:03:35Z` tick saved `notified=true` after
`input_accepted` without the second-wait timeout; a started turn requires separate proof. This is not a new full sandbox-probe receipt.

JRF-417 remains Review-Ready with [Bouncr PR #3](https://github.com/furoyce/bouncr.lol/pull/3) open and unmerged at
`19c70fb7c0752a2e54f7322cf4a7db80432713c6`. Its assisted intake, review recovery and publication qualifications below remain.

JRF-404's committed checkpoint is `d0b65877d644af60b2988f38abb62fac9082b3db`, tree
`9660eff27eb87b9da510fcc7565f6cf76fac50cc`. At that checkpoint only disclosure/API-doc/test changes followed the assisted
mobile checkpoint `c1cdfc5`; mobile source and plan `3294a40d` were unchanged. Two scoped independent operator audits had cleared
all nine clauses, negative controls and bounds. Coordinator checks passed 64 API tests, typecheck, 35 mobile-verification
checks and source build, all exit 0. The canonical implement PASS was accepted at `2026-10-08T23:12:44.385Z`.

Independent code review `01M4EWTDWZBAV5TPJQK2YAB1NJ` returned **FAIL** at `2026-10-08T23:22:37Z` on `d0b6587`, identifying
real implementation defects: the screen-mount profile mutation controller permits overlapping remounts; an old Game
completion timeout survives unmount/new run; and the progress fixture's inner wait is unbounded. Report SHA-256
`957aa7ee3416520dd3c8d86655007f036773d474260b0000d9cc4993741fca8d` is retained and was delivered by the following tick.
The canonical validate FAIL was acknowledged at `2026-10-08T23:29:50.712Z`, failure count 1. The coordinator is correcting
the three findings; no new committed candidate or validate PASS is claimed. PlanVerify's prior reports/refusals and failure
count 2 remain retained. The code FAIL concerns implementation, not reviewer rerun restrictions.

The earlier unchanged `c1cdfc5` dialog assertions passed 5/5 and production `sessionControl`/`tokenStore`/`sessionRestore`
storage schedules passed 3/3 after timing, rename/consent, dialog-generation, restore and token-ordering corrections. These
are operator-assisted pure regressions, with RED/GREEN evidence retained in the sealed supplemental mobile archive.

PostgreSQL operator checkpoint v5 succeeded at exact `d0b6587`: actual outer and operator exits 0, checks and verification
complete, cleanup verified. Base 49 and candidate 64 API tests, typecheck and builds passed; the progress fixture passed
79/79, and compatibility passed 6/6 with 24 raw-response comparisons. Both negative guard controls refused as expected
(exit 1) and preserved their sentinels. Cleanup reaped the PostgreSQL leader, verified all 44 captured process/group identities
absent, confirmed no listeners, refused connections and successful reuse binds on all five ports, and removed the owned short socket. The borrowed
dependencies and both private copies retained their verified digests. Independent checks matched all 120 raw-manifest payloads
and 85 base / 92 candidate source-export files without environment files. Raw manifest SHA-256
`de7a145b38ddb25d428b1d031279450c7e24fabc4c2089a98a8e89c4ed6aae16`; the sealed v4 failure and v5 success archives below retain both outcomes.

Three final-candidate operator failures remain separate: the first stopped at the exact Homebrew-version-string preflight
before source export or DB execution; v2's base build failed on Turbopack's external `node_modules` symlink restriction, with cleanup verified;
v4 passed all functional checks but exited 1 on cleanup `EPERM`. A bounded reproduction observed `EPERM` before reaping an
owned zombie leader and `ESRCH` after reaping; separate follow-up verified resource absence and removed its owned short socket.
V5's only change is `p.poll()` before that probe, without error suppression. The earlier operator string/dependency-copy adjustments
changed no app source, build config, locks, network or installation. V5 success covers the exact `d0b6587` API/fixture checkpoint
only; it does not establish code, native or whole-candidate acceptance. Corrections and canonical validation remain pending,
with no Bouncr publication or native acceptance claimed.

At earlier source `f67f415583e9d27b325dd1d10621000aa9f12551`, the trusted operator ran a private PostgreSQL 17 fixture: exit
0, **79 checks, 0 failures**, API **59 tests passed**, typecheck passed and the build rerun passed with an explicit synthetic
loopback URL. The initial build without that URL failed and remains archived. The outer wrapper exited 1 after immediate
plain-bind failures on ports 55413/55414. Independent follow-up found no owned PIDs or listeners, refused connections and
successful `SO_REUSEADDR` binds on all three owned ports; the immediate bind failures' cause remains unproved. This is assisted fixture
evidence at the archived source; it does not establish final validation of the complete `d0b6587` candidate.

JR Learning Plus JRF-418 passed all computed gates and published [PR #17](https://github.com/furoyce/jr-learning-plus/pull/17)
at `4f6b72ae337393d06f71f7a3058207077f5133d2`: open, non-draft and unmerged, with the protected record at review and Linear
publication read-back verified. The first Turbo authentication/temp-path failures, quarantined stale gate and prerequisite
implement refusal remain retained; environment guidance preserved the sandbox and no manual PASS or retry reset was used.
The full [CI job](https://github.com/furoyce/jr-learning-plus/actions/runs/37851829969/job/113566344084) completed SUCCESS at
`2026-10-08T22:18:02Z` for that exact PR head. All required steps passed, including workbench and course pages/access boundaries;
the PR body was updated and its exact read-back verified. GitHub's merge-test tree matches the candidate tree (`23ec3dc`).
The PR remains open and unmerged. Vercel reports “Deployment was blocked”; its cause is unverified.

JR Travel Atlas JRF-419 remains genuinely parked after its computed validate FAIL; unchanged full validation still needs an
appropriate isolated runner. Smart Dispatcher JRF-420 remains unqueued and unclaimed, with the same socket, tsx and Git/HOME
compatibility blockers. Neither pilot has gained a gate waiver or publication claim.

No production native execution adapter, immutable artifact producer, isolated native host or app-bound foreground/PID/AX
proof is available. Native policy remains unconfigured and the default adapter refuses execution. Remaining repository
pilots and formal acceptance are required before enabling automation; owner acceptance does not waive those requirements.

New private evidence under `~/.local/share/wingmate/evidence/`:

- `resume-cap-contract-20261008/`: PR #14 source checks; manifest SHA-256
  `4918a67f8737d722742c3174f66c340046f78cff9d43d96c0b4a2f98880b8931`.
- `role-completion-time-20261008/`: PR #15 checks and disabled installation; manifest SHA-256
  `6836266fbd3e8bf398aba5f9dc406774b72b2247de82d9b5f9654a7076b4992d`.
- `single-turn-delivery-20261008/`: PR #16 final 934/0 checks, merge/install/quick-doctor/disabled-automation receipts;
  manifest SHA-256 `e95d7a16bdd3a548f7dd2edbaa37ebf0e7f5de9ff48048f7918291b4b41ab4f3`.
  Earlier 929/1 full and intermediate failed focused runs remain qualified; final 934/0 and settled focused 49/0 are authoritative.
- `gate-ack-20261008/`: PR #17 final 951/0 checks and disabled install/read-back receipts; manifest SHA-256
  `59d653fc02da7859cb498fc1f6945fe5faaa55e2b4cd378f040cf0edb3cb842e`.
- `notification-acceptance-20261008/`: PR #18 final 958/0 checks and disabled install/read-back receipts; manifest SHA-256
  `6a9d650c983db20391c6c0058d2a4829bb4a474eeb9c9b7097837dc7f58cdd45`.
- `JRF-404-postgres-f67f415-20261008/`: committed-source fixture, API/build and cleanup receipts, including the wrapper failure;
  manifest SHA-256 `5b5e4a26099d4a9918b18b6ee0361dea8924cf2ab4e0ad07f1bf438b5931b62d`.
- `JRF-418-reviewready-20261008/`: 93 verified payloads, sealed at `2026-10-08T22:24:38Z`; manifest SHA-256
  `16476350608cc9b6c1e1e78f810a04c413729b17bf7402edc1df8c3aba7ac7c2`. Screening recorded zero credential findings; two public pnpm
  cache-key heuristic matches were explicitly reviewed in the retained, unchanged full CI log.
- `JRF-404-assisted-mobile-c1cdfc5-20261008/`: supplemental mobile evidence, 67 payloads / 179,947 bytes; manifest SHA-256
  `f84e9fa3df8d9161178f7e1014ac3e333acf3d5740545c0f5d92e4855f6213ae`. Ten generated caches were omitted with verified hashes;
  entropy screening recorded zero findings across 68 text files. This does not establish final API/disclosure/native/canonical
  validation or unassisted acceptance.
- `JRF-404-final-postgres-d0b65877d644-preflight-failed-20261008/`: failed preflight only, 24 payloads plus manifest, no source
  export or DB run; manifest SHA-256 `84796dbfb3f47f053640dd5c7a981dff9c3ecaca041cb25aff458de23bb37b79`.
- `JRF-404-final-postgres-d0b65877d644-build-failed-20261008/`: v2's failed base build, 58 payloads plus manifest; SHA-256
  `3b1aa5f63297e4a7b92a6b8b12f29079292b26edb296eeae57ac207d6ee3907e`. Two Git-blob heuristic matches were reviewed;
  credential-pattern matches were zero.
- `JRF-404-final-postgres-d0b65877d644-cleanup-failed-20261008/`: v4's cleanup failure, 117 payloads plus manifest; SHA-256
  `becd50181f1414f6026cdaa0843acb2051717330308cc6deb7832081f4d0d497`. Functional PASS and outer exit 1 remain separate.
- `JRF-404-final-postgres-d0b65877d644-success-20261008/`: sealed v5 operator evidence, 131 payloads plus manifest; SHA-256
  `20eeed053138c5f2bdd1b2bc25ffe6724ba9a933cbdcddbe68284b0aa65d960d`. This covers only the exact `d0b6587` API/fixture
  checkpoint; the canonical code/validate FAILs and pending corrections remain authoritative.

### Earlier operational checkpoint: 2026-10-08T20:50Z

Pilot progress below is a checkpoint at `2026-10-08T20:50Z`; pending reviews may advance afterward.

The owner said, **“I accept the slice 2, please continue.”** The trusted operator relayed that acceptance as assisted
approval/continuation for JRF-404, JRF-419 and JRF-418, with explicit scope and protocol corrections. Their coordinators resumed;
independent plan review and all later gates remain mandatory. This records owner acceptance of the slice and assisted
pilot progress, not formal unassisted or native acceptance under spec §15.1. Automation remains **disabled**.

The latest remote implementation is [PR #12](https://github.com/furoyce/wingmate-agents/pull/12), merged at
`f1542c156b5329b06bd70fd279030d5d680c1676` at `2026-10-08T20:18:31Z`. Its tree
`9769c30a05c6546d3ddb07c2e2c673efdbe40811` matches tested head `382fc66d0c42e8b813d86b071e66b5837633b584`:
924 tests passed, 0 failed, with 16,439 assertions across 76 files. Focused native tests passed 35/35; TypeScript, Biome,
diff and secret checks, compiled build and binary config validation passed. The final suite supersedes earlier checkpoints
and a host-timeout focused run; those qualified logs remain archived. PR #12 journals runtime acquisition uncertainty,
binds execution and recovery to the exact protected runtime lease, separates device cleanup from verified runtime release,
and bounds capture transfer and cleanup time. It adds no production isolation adapter, artifact producer or foreground AX
proof. No live native execution was performed. The remote feature branch was deleted; its Orca worktree was retained.

[PR #11](https://github.com/furoyce/wingmate-agents/pull/11), merged at
`a1df46ffbdad88250238b7074e954e9f3ba9a2f1` at `2026-10-08T20:06:48Z`, preserves tested head
`f5739238d831c312df09411ecab6f93658ec829f` and tree `4a9f4e6dabeb6e7803fc2ea25d888d2e8cf9ca79`.
Its final suite passed 906 tests, 0 failed; focused checks, 13 compiled CLI smoke cases, TypeScript, Biome, build, config,
diff and secret checks passed. Help runs before config loading, while unknown commands and malformed flags still refuse.
The earlier 905-test checkpoint was superseded by the mixed valued/valueless flag regression. Neither release's engineering
checks establish end-to-end pilot acceptance.

PR #9 remains the finish-summary baseline at `90b9f31ebc4ecd8543e265782ef44ae9d2b57062`, tested tree
`5ae196f328b09bdad2c5d6a2e31a7bb6e5261184` and 900 passing tests. Oversized summaries refuse before publication;
whole-word completion excerpts are scanned, and actionable queued refusals preserve the relaunch cap. PR #8 at `09676c9`
clarified read-only reviewer responsibilities without weakening gates or permissions; PR #7 at `3ac9767` pinned the trusted
config path and passed 893 tests.

The current dispatcher is PR #12, installed **disabled** at `2026-10-08T20:19:26.441Z`, binary SHA-256
`dfdae9b281939319c4e9614ad5ff179d395c5d16d01cb6a2c811ee8c1414a412`. Its install receipt and live automation precheck
pin `/Users/jujufugh/.config/wingmate/pilot-projects.yaml`; live read-back confirms automation is disabled. Quick doctor at
`2026-10-08T20:19:48.841Z` returned `ok=true` with 15 checks. This quick check does not rerun the sandbox probes; the prior
full doctor at `2026-10-08T04:14:45.873Z` passed ten blocked and seven required allowed probes. The precheck was previously
executed successfully from `/tmp` with a conflicting inherited `WINGMATE_CONFIG` (idle tick exit 1, as designed).
The previous PR #11 disabled install at `2026-10-08T20:08:03.537Z` and quick doctor at `2026-10-08T20:08:38.702Z` remain
archived. Existing sealed kits were not rewritten by either installation.

The private pilot config selects persistent Node 24 for Bouncr and Node 22 for the other three pilots. Repository-pinned
pnpm executables were bootstrapped into isolated Wingmate toolchain directories: JR Travel Atlas 10.4.1, JR Learning Plus
10.33.0 and Smart Dispatcher 10.30.0. Tarball integrity and exact-version smoke checks passed under Node 22.23.3 with an
empty private pnpm home. The private config was updated for future kits; global Node/Bun/pnpm defaults and target repository
source were left unchanged. Existing sealed kits require a fresh supported cycle to receive the new runtime configuration.

Narrow private evidence is under `~/.local/share/wingmate/evidence/`:

- `native-runtime-lease-20261008/`: final source checks and qualified earlier logs; manifest SHA-256
  `9e0322f7156cb8ad8cab5355aab8a70096901ecc270edbbd98b3738ca686c989`.
- `native-runtime-lease-install-20261008/`: actual PR #12 install, quick doctor and disabled automation/precheck read-back;
  manifest SHA-256 `648153d101a50e9a6285f8fdc8ef635866b8c63835946cd5d280b3217774da74`.
- `cli-help-20261008/`: PR #11 validation; `SHA256SUMS` digest
  `2863739eda1fda529d130f8e60acf7a5c71718e7e063ff6c07f0b0226773ae57`. Its installation archive
  `cli-help-install-20261008/` has manifest SHA-256 `2e217de52537b7a9e49a6dffebc77623712194f4e8e4323652f7371eeb64a200`.
- `pnpm-toolchains-20261008T195245Z/`: isolated bootstrap/version receipts; manifest SHA-256
  `66be0d06affefdfe18af076e79a6da33de468516eb94a3dfc3496362c1a551a7`. `pnpm-config-20261008/` preserves the private
  config change, manifest SHA-256 `e940dc03e2fc809d740c1d5095a28e21dfaa1ac38f65901d89e400539ab29151`.
- `pilot-owner-resume-20261008/`: owner relay, assisted resume receipts and the first independent plan FAILs;
  manifest SHA-256 `592192942a698faf9520f6da79549b2dd284fbcda14a2c52fa22b094b8a02e53`. This snapshot precedes
  revised-plan settlement and is not a completed pilot acceptance receipt.
- `postgres-operator-capability-20261008/`: isolated operator-side PostgreSQL capability probe; manifest SHA-256
  `459cd75b769ffa273d26b21ddf3851aeb4616082df6097b735560f57306e89c7`.
- `JRF-419-scoped-implementation-20261008/`: exact test commit, qualified baseline/head results and initial review
  evidence; manifest SHA-256 `ab538cd7ed2a7d90038559299b98cb5a89d0c94cf572b7794d099f50002b1f61`.
  This snapshot precedes the computed validation failure and later park.
- `smart-sandbox-compat-20261008/`: three synthetic compatibility probes, with generated settings, source/dependency
  hashes and limits; manifest SHA-256 `1007d599fab5910177c8cb34af8b50ff79198fce5225d03bc3c594318d734aa1`.
- `pilot-progress-20261008T2050/`: later Travel validation/park, JRF-404 revision-3 resume and Learning intake/resume
  checkpoint; manifest SHA-256 `09514ebace79a9dc3f8acef4376d9076f4a5edacaa745d8667e5a891780f90c9`.
  Pending reviews remain pending in this snapshot; it is not final pilot acceptance.

Earlier source/install evidence remains under `finish-summary-20261008/`, `finish-summary-install-20261008/`,
`review-guidance-20261008/`, `config-pinning-20261008/`, `runtime-native-20261008/` and `runtime-fix-20261008/`.

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

JRF-404 was manually requeued through trusted owner actions. Manual tick 1 at `2026-10-08T04:42:34.357Z` claimed it
into new worktree `wm-jrf-404` from `3ea70aa443e0c5d7997085b6e27c99b847ef342a`, cycle 1, with fresh coordinator session
`007bf822-8f0f-4b5e-a808-78ea802017d3`; the legacy session was not resumed. It genuinely parked at
`2026-10-08T05:00:19.096Z` on question `01M4CY2BGQ8RNATJ0E35H1N81D`, Linear comment
`5a2a8779-980d-4e15-8add-73b6c1ca2043`. Operator proposal review corrected mixed-version writers and independent cohort
minima, nullable bigint storage, latest-run scope and pause/background/completion timing. Real disposable PostgreSQL
validation and trusted native UI evidence are hard requirements before publication. The original question and sealed kit
were preserved; intake evidence remains in `JRF-404-intake-20261008/`, manifest SHA-256
`9774c1ba28211a01cfb9c59f15efe4813e3f93c0bbf4e47774264b632fb69de3`.

The owner acceptance above was relayed with those corrections. It approves a separate 60 Hz step-timed microsecond cohort,
integer microsecond storage with six-decimal seconds display, current physics and self-reported timing disclosure. Existing
name/avatar opt-in is retained and new accounts default off. The authenticated manual tick at
`2026-10-08T19:45:22.818Z` resumed JRF-404. This is **assisted approval/resume**, not authorization to bypass independent
plan review, DB/native evidence, publication gates or subsequent app release approval.

JRF-404's first independent plan request `01M4EHQ0C078BQK1D8KSAAMMK2` returned FAIL. The retained report identified stale
sync-response merging, pause/reset coverage without an animation tick, default API serialization compatibility, incomplete
native changed-flow checks and contradictory store disclosures. Revision 2 request `01M4EJS9ZHTF96CXBHN4YGZ3Z0` also
returned FAIL, completed at `2026-10-08T20:31:04.153Z` and recorded by the gate at `2026-10-08T20:31:25.553Z`.
It accepted the previous findings 1–4 at design level but required a
consistent local-repair/server-rejection policy, complete disclosure reconciliation and invalid progress-query rejection
before authentication writes. Its exhaustive arithmetic used Node 26.4.0, not the pinned Node 24 fixture runtime.

Revision 3 (`dd2acf297a850f3e4678cb85d5d2ebfca08a97ddadfbc5c7aa729bf3a6657233`) proposes corrections to those three findings.
The coordinator genuinely parked at `2026-10-08T20:37:43.117Z` on question `01M4EKNNDKSRXNTTW8VK9KN66X`, asking for fresh
independent verification before implementation. Assisted owner relay `92cc6eb3-7dbc-49da-84b9-f1dc13f4afd9` was authenticated
at `2026-10-08T20:41:47.911Z`; the same coordinator resumed at `2026-10-08T20:41:48.301Z`. Fresh verifier
`01M4EM2AKS4EHNPBB878C9BJE5` started at `2026-10-08T20:48:23.291Z` on the exact revision-3 hash and unchanged input HEAD.
Both earlier FAILs remain retained. No revision-3 PASS or implementation is claimed at this checkpoint.
Real DB and trusted native evidence remain required before publication. The earlier disposable
DB probe was rejected before execution by a configured permission rule; this neither establishes OS-level PostgreSQL
unavailability nor justifies bypassing real DB validation. A later trusted-operator capability probe verified PostgreSQL
17.11 executables and initialized a newly owned private cluster with an isolated environment. It started no server or
listener and ran no API, migration or repository code. This establishes an assisted fixture path; real multi-connection DB
proof remains unrun and mandatory before publication, with no sandbox permission relaxation.

JR Travel Atlas JRF-419 cycle 1 was claimed at `2026-10-08T19:48:08.385Z`. Its coordinator hit `EPERM` at
`2026-10-08T19:48:41.504Z` while the global pnpm executable tried to switch to the repository-pinned version and create a tool directory under
`~/Library/pnpm/.tools/`.
The operator used the supported stop path. After the isolated pinned-pnpm bootstrap and private runtime config update,
manual claim at `2026-10-08T19:53:48.577Z` started cycle 2 with a fresh kit and coordinator. The unchanged 13-test baseline
passed before its genuine park at `2026-10-08T20:02:24.942Z`; this is runtime baseline evidence, not validation of new tests.

The owner continuation was relayed with the bounded test-only scope: one referral-code regression group, fixed vectors,
per-group pepper reset, format and configuration-error checks, preservation of all 13 existing tests and no production
changes. The optional temporary mutation probe was omitted. Manual tick at `2026-10-08T20:03:02.637Z` authenticated the
continuation and resumed JRF-419 with the requirement that independent plan verification pass before tracked test changes.
Its first independent request `01M4EJ12VP7VHT3BCAW98DPDAT` returned FAIL because pre-commit `base..HEAD` checks could not
verify the proposed uncommitted tests. That failure remains retained. The revised plan separates working-tree checks from
post-commit preservation/format checks at the exact final HEAD. Fresh request `01M4EJJCWF6T6HM0DW7VANS1NM` returned PASS,
completed at `2026-10-08T20:21:39.102Z` and recorded by the gate at `2026-10-08T20:21:54.654Z`. The protected
plan-verification gate is PASS, with its prior failure count of 1 retained. This remains **assisted intake and review recovery**.

The coordinator committed only `server/invite-codes.test.ts` at `e40b4a0594bce849ba8695f6296ee720671ab177`: 50 additions,
zero removals, five new tests, clean tracked source/index. Targeted and shuffled checks passed 18/18; the isolated new group
passed 5/5. The full pinned baseline test command had already failed in four existing HTTP listener hooks with `EPERM`
(2,762 passed, one failed test, 243 skipped); the committed run adds five passing tests and retains the same listener
failures. Baseline and head type checks and builds passed. The implement gate passed at `2026-10-08T20:29:51.037Z`.
Independent code review returned PASS at the unchanged commit, completed at `2026-10-08T20:37:29.476Z`; this is
source-review approval only. The actual CLI-computed validate failed at `2026-10-08T20:39:03.405Z` on the same full-suite
listener errors. The coordinator genuinely parked at `awaiting-human/validate` on question `01M4EKXGM6VA2Q90WW79KZ1T5E`
at `2026-10-08T20:40:56.531Z`, asking for an isolated runner. No validation, UI, security or publication PASS is claimed.

Independent audits of installed Claude 2.1.295 found `sandbox.network.allowLocalBinding=true` grants all-interface
listeners and direct access to every host-local service. The operator therefore preserved the sealed settings and full
validation command, and sent bounded guidance to complete only the approved tests and runnable checks, then stop before
finish if isolated full validation is unavailable. The send client timed out before returning a receipt; a subsequent
read-back confirmed the full guidance in the new session conversation with no draft. No resend was made. This is additional
operator assistance; neither a narrower replacement command nor a manual PASS satisfies the gate.

JR Learning Plus JRF-418 was queued through incremental `agent-ready` and Ready labels, then correctly deferred at the
provider cap. Manual tick at `2026-10-08T20:37:27.571Z` parked JRF-404 and claimed JRF-418 into fresh worktree `wm-jrf-418`
from remote base `5e27d01c286bd206f19babec199ac7edaac81fe3`; its coordinator started at `2026-10-08T20:37:55.825Z`.
Trusted frozen setup exited 0. It genuinely parked at intake on question `01M4EM2WJ4311W5R5PDQQFNTXV` at
`2026-10-08T20:48:15.539Z`. Assisted owner reply `a16f7fc7-cc41-408a-a5ae-10e0e35024c2` retained the six requested
pricing scenarios and one-file scope, corrected plan verification to precede source edits, and separated working-tree
from committed checks. The reply was authenticated at `2026-10-08T20:49:26.464Z`, and the same coordinator resumed at
`2026-10-08T20:49:26.829Z`. Full remote CI / verify at the exact published head remains an operator check; no source,
pinned gate or remote CI result is claimed yet.

Smart Dispatcher JRF-420 remains prepared but unclaimed in Todo without Agent labels.
Smart's Crew preflight exited 0 at `db16d95`; its `myFiles` was empty, so this did not reserve the
planned files. An assisted early-draft operator procedure is arranged for its first-commit draft-PR convention and
append-only `WORK_LOG.md` coordination. Wingmate publishes at finish and can reuse an existing draft, but does not refresh
its body or mark it ready; those operator actions are not automated acceptance.

A bounded synthetic probe under freshly generated strict sandbox settings confirmed three Smart compatibility blockers:
an owned Unix-socket listen returned `EPERM` (exit 2), normal tsx 4.21.0 CLI startup failed at its IPC listener with `EPERM`
(exit 1), and a child Git command that removed `GIT_*` variables while retaining the real HOME failed to read the denied
owner `.gitconfig` (exit 128). Claude supplied its own temporary path for tsx. These are three compatibility probes, not
full Smart tests or a full credential-isolation audit. No socket exception, broader local-network grant, HOME workaround,
source change or gate waiver was applied. Smart remains unclaimed until its validation environment can run the unchanged
required commands within an appropriate isolation boundary.

No isolated native host, immutable artifact producer, production execution adapter or app-bound foreground bundle/PID/AX
proof has passed acceptance. PR #12 strengthens the disabled foundation; native policy remains unconfigured and the default
adapter refuses execution. See [native prerequisites](../../native-ui-relay.md). Real disposable DB and trusted native
validation remain JRF-404 publication blockers. Complete the remaining formal scratch/native acceptance and repository
pilots before enabling the five-minute automation. Owner slice acceptance and assisted resumes do not waive those gates.

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
