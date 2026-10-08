# Native iOS relay foundation

Native iOS UI execution is **unavailable in the default runtime**. This change supplies strict local requests, protected provenance and evidence checks, dedicated-device ownership, cleanup/recovery, and gate integration. It does not provide an isolated build producer, an isolated execution host, or an adapter that proves foreground app/process identity for AX and screenshots. It is not a passing native UI pilot, and Bouncr's native policy remains unconfigured.

CoreSimulator on the credentialed owner's Mac is not an execution sandbox. A receipt for an isolated build does not make the resulting app safe to launch there. The default `nativeUiHost` returns no execution-isolation attestation and no app-bound observations; even a configured policy and valid artifact cannot bypass that refusal. No agent-facing command runs repository build scripts on the host or creates build attestations.

## Required trusted components

Before enabling a native policy, implement and review all three components:

1. An isolated build producer, outside the agent's writable worktree and launch environment, that builds the requested committed HEAD without owner credentials or unrestricted host access. It must produce the artifact receipt below and make the admitted artifact immutable for its entire verification/install lifetime.
2. An isolated execution adapter implementing `NativeUiPort`, including the actual `simctl` and emulator transports. Its trusted attestation must match `executionIsolationHash`. It must isolate the app's filesystem, network, helper processes and credentials; replacing only the attestation while retaining shared-host transports is invalid. Recovery cleanup must reach the same isolated runtime, including after a configuration change.
3. An app-bound observation adapter returning the configured foreground bundle ID, the PID returned by launch, and fresh AX snapshots from the owned device. Both observations surrounding each screenshot must prove the same app/process. It must establish the version-matched Orca AX envelope and normalized frame contract. The relay never treats arbitrary visible text or successful `simctl launch` as foreground proof.

Missing components are a hard blocker to native UI completion. Do not bypass them with manually written receipts, a developer's stale installed app, an owner Simulator, a coordinator-written PASS, or a host build command. A native UI change cannot use NA to skip the blocker.

## Trusted policy and artifact contract

The optional repository `ui.native` policy pins the Simulator runtime and device type, bundle ID, trusted producer ID, build isolation hash, execution isolation hash, launch argv, test environment, and timeout. The kit receives only the policy hash. It does not receive trusted environment values. Policy changes invalidate previous proof.

The native timeout is 10–100 seconds, default 90 seconds. Configuration admission additionally reserves 10 seconds for dispatcher preparation, 40 seconds for cleanup, and 35 seconds for coordinator delivery inside the tick budget (`max(30, precheckTimeoutSec - 60)` seconds). The default 240-second precheck accommodates the 90-second native timeout; a 100-second native timeout needs at least a 245-second precheck. A busy tick can defer execution until a later tick has sufficient time.

The trusted producer writes only the fixed protected location:

```text
<state>/native-artifacts/<Orca repository UUID>/<source HEAD>/<native policy SHA256>/
  app.app/
  receipt.json
```

`receipt.json` has the strict fields `version: 1`, `provenance: "dispatcher-isolated-build"`, `producer`, `isolationHash`, `sourceHead`, `policyHash`, `bundleId`, `appHash`, and `builtAt`. There is deliberately no CLI shortcut to mint or approve this receipt. The dispatcher rehashes the app and verifies its bundle ID before allocation. `appDigest` hashes directory names, relative file names, executable bits and content; symlinks and special files are refused. Verification is bounded to 20,000 total entries, 32 directory levels and 1 GiB, with deadline checks between entries and 64 KiB reads. A producer must use the same digest implementation.

The producer and execution adapter must prevent mutation of admitted artifacts during verification and installation. Likewise, committed-HEAD/clean-index checks occur at checkpoints; they cannot replace an immutable execution snapshot. Shared writable sources and artifacts are an unacceptable basis for a production adapter.

## Coordinator flow

After committing source, completing validation, and entering the UI stage, the coordinator writes a recipe under `.wingmate/`, for example:

```json
{
  "kind": "ios",
  "steps": [
    { "expectText": "Fixture screen" },
    { "tapText": "Continue" },
    { "expectText": "Fixture complete" },
    { "screenshot": true }
  ]
}
```

Use labels from the actual offline test app. Recipes allow 1–20 strict steps and require at least one text assertion. They cannot select a device, executable, app path, bundle, URL, command, raw coordinates or arbitrary emulator operation. Text assertions require exactly one visible match; taps additionally require an enabled target. Missing startup text is polled with fresh, app-bound snapshots for at most five seconds, within the overall deadline.

```text
wingmate issue <id> ui-smoke --recipe .wingmate/native-recipe.json
```

This writes a local intent and returns a request ID. The coordinator must **END ITS TURN**. It must not call Orca, attach to a Simulator, install or launch an app, or write its own UI verdict. The dispatcher waits for a complete fleet, an idle coordinator, no outstanding reviewer wave and sufficient tick time. It binds the request to issue, worktree, cycle, attempt, committed HEAD, recipe and policy.

After dispatcher notification, inspect the mirrored structured receipt and evidence, then request gate acceptance:

```text
wingmate issue <id> gate ui --request <request-id>
```

Manual native `--verdict PASS` is refused. The dispatcher independently verifies protected success, app identity, evidence hashes, cleanup, current HEAD, policy and attempt. Publish repeats these checks against the exact captured commit and diff it will push, even if the worktree's HEAD subsequently moves; tracked source/index cleanliness remains required for PASS. Agent gate requests cannot supply that internal publish snapshot. `.wingmate/native-ui.json` and mirrored files are advisory; changing them cannot create a protected PASS. Commit any new source changes and request a fresh smoke. Unchanged configured UI paths can still use `gate ui --verdict NA --note "no UI change"`; the dispatcher independently checks the committed diff.

## Ownership, recovery and stop

The dispatcher allocates a fresh device, journals allocation uncertainty before `simctl create`, and journals the exact returned UDID before boot/install/helper operations. Every operation uses that explicit UDID and owned worktree. It never uses `booted`, `all`, or the owner's existing device. Helpers receive only the environment required by their trusted adapter; the default fixed system helpers do not inherit owner credentials.

Cleanup runs even when a stop, lost lock or deadline abort interrupts an action. It stops only the owned helper and shuts down/deletes only the owned device. Exact-device absence is verified; an already absent device is safe to settle, while unavailable verification remains unresolved. Cleanup helpers have five-second command bounds including subprocess timeout grace inside the cleanup reserve. An allocation interrupted before its UDID was journaled remains uncertain and requires owner investigation; recovery never guesses a device to delete.

Interrupted runs settle FAIL and are never replayed as a second create/install/launch. Recovery checks protected ownership across stage, attempt and policy changes. Stop reports unresolved resources. Completed proof is saved before advisory copying; retry can restore hash-verified mirrored receipts/artifacts without replaying device actions. Pending and completed-but-unnotified current-wave jobs suppress watchdog relaunch. Paused ticks and exhausted resume budgets wait; a later eligible tick resumes the coordinator once. A new cycle does not inherit an old advisory job's request veto.

## Validation boundary

Simulation tests cover strict recipes, default isolation refusal, artifact provenance and bounds, source/index changes, ownership persistence, foreground binding, startup polling, protected gates, tampering, replay repair, requeue, interrupted execution, actual pause, resume budget, cleanup and stop. They inject an isolated runtime and do not launch a real app.

A bounded API-contract probe created one dedicated empty Simulator, attempted an AX read, and cleaned up its device/helper. The read failed and did not establish a usable AX envelope. Existing owner devices and their states were preserved. This probe establishes cleanup discipline only; it supplies neither build provenance nor native pilot evidence.
