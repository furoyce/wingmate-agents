# Native iOS relay foundation

Native iOS UI execution is **unavailable in the default runtime**. This change supplies strict local requests, protected provenance and evidence checks, dedicated-device ownership, cleanup/recovery, and gate integration. It does not provide an isolated build producer, an isolated execution host, or an adapter that proves foreground app/process identity for AX and screenshots. It is not a passing native UI pilot, and Bouncr's native policy remains unconfigured.

CoreSimulator on the credentialed owner's Mac is not an execution sandbox. A receipt for an isolated build does not make the resulting app safe to launch there. The default `nativeUiHost` cannot acquire or resolve an isolated runtime lease and refuses every execution, observation, capture and cleanup transport; even a configured policy, supplied binding and valid artifact cannot bypass that refusal. No agent-facing command runs repository build scripts on the host or creates build attestations.

## Required trusted components

Before enabling a native policy, implement and review all three components:

1. An isolated build producer, outside the agent's writable worktree and launch environment, that builds the requested committed HEAD without owner credentials or unrestricted host access. It must produce the artifact receipt below and make the admitted artifact immutable for its entire verification/install lifetime.
2. An isolated execution adapter implementing `NativeUiPort`, including the actual `simctl` and emulator transports. Its trusted attestation must match `executionIsolationHash`. It must isolate the app's filesystem, network, helper processes and credentials; replacing only the attestation while retaining shared-host transports is invalid. Recovery cleanup must reach the same isolated runtime, including after a configuration change.
3. An app-bound observation adapter returning the configured foreground bundle ID, the PID returned by launch, and fresh AX snapshots from the owned device. Both observations surrounding each screenshot must prove the same app/process. It must establish the version-matched Orca AX envelope and normalized frame contract. The relay never treats arbitrary visible text or successful `simctl launch` as foreground proof.

Missing components are a hard blocker to native UI completion. Do not bypass them with manually written receipts, a developer's stale installed app, an owner Simulator, a coordinator-written PASS, or a host build command. A native UI change cannot use NA to skip the blocker.

## Production adapter prerequisites

A candidate route is a dispatcher-owned broker controlling disposable macOS VMs on an Apple Silicon host. [Apple Virtualization](https://developer.apple.com/documentation/virtualization/running-macos-in-a-virtual-machine-on-apple-silicon) and [Tart's macOS/Xcode images](https://tart.run/quick-start/) provide infrastructure options, not an implemented Wingmate adapter. Provision sufficient storage for the guest image, Xcode, Simulator runtimes and build caches before attempting this route. A Docker/Linux container does not supply the required macOS execution environment.

Implementable components have separate responsibilities:

- **Broker and isolation profile.** Pin the guest image, tool/helper versions, mount rules and network policy. Derive the isolation attestation from the enforced profile. Keep owner credentials, keychains, SSH agent forwarding and host home directories outside the guest; expose no writable host source/state mounts. Restrict guest access to the host, LAN and external services, with only a narrow authenticated control channel. Default Tart NAT permits host access and is insufficient by itself; [its network documentation](https://tart.run/faq/#connecting-to-a-service-running-on-host) describes that boundary. Implement every `NativeUiPort` transport, including artifact installation and screenshot transfer, in that isolated runtime; returning a lease while retaining shared-host transports is invalid.
- **Build producer and immutable admission.** Export the exact committed tree and declared submodule/LFS inputs. Run locked dependency setup and repository build scripts inside an unprivileged build guest, without owner signing or cloud credentials. Use a separate clean execution guest, or restore its trusted image before importing the app, so build scripts cannot replace observation helpers. Import a bounded app tree into the protected artifact store, apply `appDigest` and the receipt contract below, and hold an immutable snapshot or equivalent read-only lease through verification and installation. Build asynchronously before the UI tick; the native execution deadline is not a build budget.
- **Runtime ownership and recovery.** The dispatcher journals acquisition uncertainty before asking for a runtime and persists an adapter-issued binding (`version`, opaque non-secret `id`, attested `profileHash`) before any device allocation. All transports receive that exact binding. The production adapter must durably resolve it to the original runtime after restart or policy/connection changes, independently of current configuration, and refuse unknown or expired leases before action. It must also support read-only lookup of an interrupted acquisition and exact, idempotent lease release. The lease ID does not supply a production VM transport or prove isolation by itself. Cleanup must remain bounded and available after stop/lost-lock/deadline, with unresolved leases and allocations reported honestly.
- **Foreground and AX observations.** Establish a versioned, bounded envelope that binds each fresh snapshot to the configured bundle and the exact launch PID, including both checks surrounding a screenshot. The version-matched Orca emulator guide (`orca skills get orca-emulator`) documents local-Mac control, a 500-node cap and normalized top-left frames; it does not establish a foreground bundle/PID contract. An inspection of bundled `serve-sim` 0.1.47 found native `axFrontmost` and `axDescribe` primitives that are candidates for a guest broker. Their live envelopes and freshness are unproven here. Validate them on the pinned guest, including Home, another foreground app, a same-bundle PID restart and helper failure. A remembered foreground event or successful launch is insufficient.

## Minimal native acceptance sequence

These are future acceptance steps, not completed pilot evidence:

Reviewers inspect committed source and validation/build evidence, independently run safe read-only checks, and report checks they cannot rerun. They never perform workspace-mutating builds or request broader writes; inability to rerun such a command alone is not a product defect. Missing isolated provenance or inadequate evidence can still require FAIL. After an independent code-review PASS, the coordinator/CLI validate gate still executes every pinned command; native app build provenance remains the isolated producer's responsibility.

1. Provision the isolated worker and pin its profile. Verify that guest code cannot read owner files/credentials, mutate broker/helpers or reach disallowed host/network services. Prepare a committed offline fixture and dependency inputs; keep the application native policy unconfigured.
2. Build that exact fixture commit in the isolated producer. Admit its immutable app and genuine producer receipt, verify all content/source/policy bindings, and demonstrate that attempted mutation during verification/install cannot change the installed artifact.
3. In a fresh execution guest, create and journal one dedicated device. Establish the actual foreground/AX envelope and coordinate contract with the fixture, then prove that wrong bundle/PID, background state, stale observations and helper errors refuse evidence.
4. Exercise the Wingmate recipe, protected receipt, gate and publish checks. Inject stop, lost lock, deadline and dispatcher interruption; verify exact-owned cleanup and recovery across a policy change, preserve unrelated devices, and refuse uncertain creates without guessing. Demonstrate that stale HEAD/policy or edited advisory evidence cannot produce PASS.
5. Measure execution, transfer, cleanup and notification against the existing tick reserves, with guest preparation/build outside that critical path. Review the real evidence and recovery results before configuring a native policy or claiming native pilot acceptance.

Until all components and acceptance steps pass, retain the default unavailable runtime and Bouncr's unconfigured native policy.

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

The dispatcher journals `runtimeAcquireUncertain` and incomplete cleanup before acquisition. A null acquisition result must explicitly prove this request reserved no resources; a thrown/interrupted result remains uncertain. Read-only lookup uses the protected request ID, worktree and original profile, with frozen inputs and exact response matching. It distinguishes verified absence from an unavailable registry and never acquires a replacement. A recovered or newly acquired strict binding is saved before any cleanup/device transport. The dispatcher verifies resolution against every binding field, journals allocation uncertainty before `simctl create`, and journals the exact returned UDID before boot/install/helper operations. Every operation uses that runtime binding, explicit UDID and owned worktree. It never uses `booted`, `all`, or the owner's existing device. Helpers receive only the environment required by their trusted isolated adapter. Stop guards apply before lease acquisition, device/helper actions and screenshot capture; exact-owned cleanup remains available after an abort.

The capture port receives the owned runtime/device/worktree, a deadline and a 16 MiB byte limit. An adapter must enforce that limit during transfer and return PNG bytes, rather than writing a dispatcher-local path from a guest. The dispatcher independently checks the Buffer, limit and PNG signature, verifies foreground identity before and after capture, and only then writes protected evidence. The existing app-bound AX/foreground contract still requires a real trusted implementation and guest acceptance evidence.

Cleanup runs even when a stop, lost lock or deadline abort interrupts an action. Device cleanup and runtime release have separate protected completion flags; overall cleanup requires both and no acquisition uncertainty. A pre-device artifact, bundle or resolution failure still releases the acquired runtime or remains unverifiable. Cleanup stops only the owned helper and shuts down/deletes only the owned device. Exact-device absence is verified; an already absent device is safe to settle, while unavailable verification remains unresolved. Verified device settlement is saved before releasing the exact lease. The adapter must attest actual lease-owned resource termination or a durable verified released tombstone; unknown/expired/unavailable leases cannot imply success. A lost release acknowledgement can retry that exact idempotent settlement without reopening device transports. An allocation interrupted before its UDID was journaled remains uncertain and requires owner investigation; it blocks lease release and recovery never guesses a device to delete or returns a potentially dirty guest to a pool.

One shared 40-second cleanup deadline covers lookup, resolve, device cleanup, release and state progress. Lease operations receive at most five seconds each and device cleanup at most 25 seconds, all as total wall budgets inclusive of subprocess cancellation/drain grace. The reusable device helper uses at most three-second child timeouts and reserves the existing two-second post-kill drain grace for each of its at most five commands. The normal resolve/device/release path therefore leaves five seconds of the reserve for state progress. Late acknowledgements remain unverifiable. The admission constants and default 90-second native timeout at a 240-second precheck are unchanged.

Interrupted runs settle FAIL and are never replayed as a second create/install/launch. Recovery resolves only the recorded binding across stage, attempt, policy and current-connection changes; it never acquires a replacement. Unavailable, expired or mismatched leases, and legacy records with an owned UDID but no lease, remain unverifiable and require owner action. Stop reports unresolved resources. The full binding stays out of advisory mirrors; a protected receipt binds its hash to the job's source, policy, request and ownership context. Completed proof is saved before advisory copying; retry can restore hash-verified mirrored receipts/artifacts without replaying device actions. Pending and completed-but-unnotified current-wave jobs suppress watchdog relaunch. Paused ticks and exhausted resume budgets wait; a later eligible tick resumes the coordinator once. A new cycle does not inherit an old advisory job's request veto.

## Validation boundary

Simulation tests cover strict recipes, default isolation refusal, artifact provenance and bounds, source/index changes, runtime binding persistence and propagation, changed-connection recovery, unavailable/expired/substituted leases, bounded capture bytes, foreground binding, startup polling, protected gates, tampering, replay repair, requeue, interrupted execution, actual pause, resume budget, cleanup and stop. They inject a synthetic runtime and do not launch a real app or establish operational isolation/native acceptance.

A bounded API-contract probe created one dedicated empty Simulator, attempted an AX read, and cleaned up its device/helper. The read failed and did not establish a usable AX envelope. Existing owner devices and their states were preserved. This probe establishes cleanup discipline only; it supplies neither build provenance nor native pilot evidence.
