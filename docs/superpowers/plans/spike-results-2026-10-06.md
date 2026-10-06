# Spike results — 2026-10-06 (Task 0, spec §16.1)

Produced by the scripts in `spikes/` (see `spikes/README.md`); fixtures are in `tests/fixtures/orca/`. Every value
below was observed on this machine on 2026-10-06 unless a row says *default applied*.

**Environment.** Orca CLI 1.4.220 (runtime `c75f606e-8651-49ea-afcd-1514da5b1aa5`) · Claude Code 2.1.291 · Codex CLI
0.160.1 · Bun 1.3.9 · macOS (Darwin 25.5.0) · repo `wingmate-agents` (Orca repo id
`1f1e7f87-e283-4432-beaf-92efba56ddb9`, main checkout `~/orca/projects/wingmate-agents`, worktrees under
`~/orca/workspaces/wingmate-agents/`). The Claude model was resolved from `~/.claude/settings.json` (`model`):
`claude-fable-5-1[1m]`, passed as `--model 'claude-fable-5-1[1m]'` (the `[1m]` suffix selects the 1M-context variant: TUI
shows `0k/1000k`; the stream-json init event reports `model: "claude-fable-5-1"`). Codex used its configured default
model (`gpt-6.1-sol` in the exec banner).

## 1. Results table (one row per §16.1 item)

| # | Item | Command(s) | Observed | Consequence for the plan |
|---|------|-----------|----------|--------------------------|
| 1 | Terminal-agent launch (`terminal create --command`, `tui-idle`, `send --wait-submit`, `--effort max`, resume) | `bun spikes/orca-launch-spike.ts` | **Verified, with one new blocker.** `terminal create` ✓; `terminal wait --for tui-idle` returned `satisfied:true` — except on the first launches, before Claude's folder-trust dialog had ever been answered for this repo, where it returned `satisfied:false` with `blockedReason:"agent-trust-workspace"` (default option of the dialog: **"No, exit"**; §3.2 says what is and is not known about where trust is stored). After the dialog is answered (Down, Enter) `satisfied:true`; `send … --wait-submit 15` receipt `stages:["input_accepted","turn_started"]` in ~2 s; `--effort max` accepted; `claude --resume <id>` restores the transcript in the same worktree. | No default applied. **Task 8 must branch on `blockedReason`** (the spec's "wait once more with 180000" does not help: the wait returns early, not on timeout) and must never send the brief into the dialog (Enter selects "No, exit" and the agent exits). `result.terminal.handle` / `.paneKey` are nested (not `result.handle`). §3.1, §3.2. |
| 2 | `worktree ps` / `terminal list` vocabulary: working, turn-ended, exited, unverifiable | same script; `bun spikes/orca-vocab-capture.ts` | **Verified for working / idle / exited.** working = `agents[].state:"working"`; turn ended = `state:"done"`; exited = handle absent from `terminal list` **and** the `agents[]` entry removed. **The spec's "`worktree ps` retains `done` entries for closed tabs" was NOT reproduced** (natural `/exit`, `terminal close --terminal`, `terminal close --worktree … --all` all remove the entry). Fixtures captured. `unverifiable` cannot be produced by a spike. | `exited` default holds ("absent from `terminal list`"); the "ignore retained entries" clause is harmless but moot. `unverifiable`: *default applied* (spec §5.5 definition). `agentIdentity` is **optional** on rows (absent on plain shells). §3.3, §4. |
| 3 | `spawn` from a terminal coordinator (`run-create` binds the terminal; `worker-start --run <id> --worktree current` at depth 1) | — | **Not exercised.** Needs a coordinator agent turn, a Run and a worker (persistent orchestration records); outside Task 0's brief and its approved side effects. Only the vocabulary of existing workers was captured (`projection.liveness.verdict` ∈ `exited`, `unverifiable`; no `live` row among the newest 100). | *Default applied*: force method `loop`; verifiers run as unsupervised terminals (`terminal create --command` + `send`), ledgered as such. |
| 4 | Claude sandbox via `--settings` outside the worktree | `bash spikes/claude-sandbox-spike.sh`; `claude sandbox status`; follow-up `bash spikes/claude-network-spike.sh deny` and `… strict` | **Verified** for: settings load from outside the worktree (`claude sandbox status` with `--settings` → `enabled:true`, `strictMode:true`, `autoAllowBashIfSandboxed:true`, each with `source:"policy"`; without it `enabled:false`), `denyRead ~/` (`Operation not permitted`), `allowWrite`/`denyWrite` globs, worktree write, **`git commit` in a linked worktree under the §13.3(b) common-dir allow-list**, write to `<common>/hooks/pre-commit` blocked, `gh api user` fails. (`strictMode:true` appears exactly when the file sets `allowUnsandboxedCommands:false`: minimal probe files without it report `strictMode:false`; no per-command opt-out of the sandbox was attempted.) **`allowedDomains` alone does not block anything:** with only `allowedDomains: ["registry.npmjs.org"]`, `git ls-remote https://github.com/git/git.git HEAD` (public) **returned a ref** under `-p --permission-mode bypassPermissions` (the brief's private-repo check (2) failed only on auth, so it alone would have *looked* like a pass). **Follow-up (§3.4a, two more runs): `deniedDomains` and `strictAllowlist: true` are both enforced from the `--settings` file.** Listed hosts (exact and the `*.githubusercontent.com` wildcard) are refused with `CONNECT tunnel failed, response 403`; with `strictAllowlist` *every* unlisted host is (github.com, example.com, pypi.org), the allowed registry answers `200`, a per-command `allowed_domains` widening is refused and a proxy-ignoring client cannot resolve hosts. `allowManagedDomainsOnly` is read from managed settings only (a no-op from `--settings`: source reading, not run). | **Task 9 sets `sandbox.network.strictAllowlist: true`** with `allowedDomains` = registries/provider hosts, and puts the GitHub/GitLab/Vercel/Supabase/Neon hosts in `deniedDomains` as defense in depth (deny is evaluated first; this exact combination was not run as one probe). The §16.1 default (`doctor` fails, `install --enable` refused) therefore no longer applies to the network control. For `doctor` (Task 12): `claude --settings <file> doctor` must print no "Invalid settings" section (an invalid value silently drops the whole sandbox block), `claude sandbox status` must report `enabled:true, strictMode:true`, and a sandboxed probe must show `<sandbox_violations> deny network-outbound github.com:443 (host is not on the allow list)`. In-process tools (WebFetch/WebSearch, MCP) are **not** gated by the sandbox; deny them in `permissions.deny` if fetch-URL exfiltration matters. Other §13.3(b) facts for Task 9/12: `$(brew --prefix)` must be in `allowRead`; the `GIT_CONFIG_GLOBAL` kit file is mandatory. |
| 5 | Codex flags and sandbox | `bash spikes/codex-flags-spike.sh` | **Verified.** `--sandbox read-only|workspace-write` ✓; `-c model_reasoning_effort=xhigh` ✓ (banner `reasoning effort: xhigh`); `-c project_doc_max_bytes=0` ✓ (AGENTS.md codeword did not reach the model; no control run); `-c sandbox_workspace_write.network_access=false` ✓ (`curl: (6) Could not resolve host`). **`codex exec` rejects `--ask-for-approval`/`-a`** (`error: unexpected argument '--ask-for-approval' found`); the interactive `codex` accepts it; the `exec` equivalent `-c approval_policy=never` works (banner `approval: never`). **Reads outside the worktree are NOT blocked** (credentials canary printed under `--sandbox read-only`). | **D14 extension: Codex sessions can read the owner's files** — for the owner's confirmation per §13.3(c). Until confirmed the §16.1 default holds: Codex limited to verifier/reviewer roles, cascade `[claude]`, `verifyCross:false` available per project. Task 9 builds the Codex argv for the **interactive** form (accepted: `codex -C <dir> --ask-for-approval never --sandbox … -c …`). |
| 6 | Linear app actor / label group / mention markup / `client_credentials` / notification test | — | **Not exercised** (needs the owner's OAuth app; Task 0's brief defers it to Task 12's `doctor`). | *Default applied*: subscription as the only delivery path; plain-text names; `doctor` blocks `install --enable` until the notification test passes. |
| 7 | Automation precheck running the whole tick (`--precheck-timeout 240` honored; stdout stored on skipped runs) | — (read-only: `orca automations list`, `agent-context`) | **Not exercised** (needs creating an automation). Facts: `--precheck` and `--precheck-timeout` exist on both `automations create` and `automations edit`; existing automations show `precheck: { command, timeoutSeconds }` with `timeoutSeconds` 60 and 120 (or `precheck: null`). | *Default applied*: `claimsPerTick` 1 and tick budget 50 s until Task 12/13 verifies 240. |
| 16.2 | Claude `--effort max` accepted | launch spike | **Accepted.** `claude --help`: `--effort <level> (low, medium, high, xhigh, max)`; TUI header `Fable 5.1 with max effort · Claude Max`, footer `◈ max · /effort`. | No default (`high`) needed. |

## 2. What went wrong on the way (and why the spikes differ from the brief)

1. **First live run hit the trust dialog.** Run 1 of `orca-launch-spike.ts` (as the brief writes it) launched Claude in a
   fresh worktree; `terminal wait --for tui-idle` returned `satisfied:false`, `blockedReason:"agent-trust-workspace"`;
   the script then sent the prompt + Enter into the dialog and the agent exited ("No, exit" is the default option).
   I explored the dialog manually in a second scratch worktree, then codified it. The final script run (run 2) found
   the dialog **already gone** (see §3.2), so the script's "answer the dialog" branch was exercised by the manual
   exploration and by run 1's detection, not by the final run. Three scratch worktrees were therefore created and
   removed (the brief allows one).
2. **Brief's check (4) cannot pass as written.** `git -C . commit --allow-empty -m probe .` fails with `error: pathspec
   '.' did not match any file(s) known to git` in a repo without tracked files, sandbox or not (verified offline). The
   trailing `.` reads as sentence punctuation; the spike drops it.
3. **Check (2) cannot prove the network allowlist** (private repo ⇒ fails on auth either way). Controls (7) public
   repo and (8) allowed domain were added; (7) is what exposed the failed allowlist, and the follow-up in §3.4a found the settings that do
   enforce a network control.
4. **git dies under `denyRead ~/`** (`fatal: unable to access '/Users/jujufugh/.gitconfig': Operation not permitted`;
   verified offline with `sandbox-exec`). With `GIT_CONFIG_GLOBAL` pointing at a readable kit file git works (a
   warning remains: `unable to access '~/.config/git/ignore'`). The brief's script lacked the §13.3(b) environment.
5. **`git`, `gh`, `jq`, `bash` live under `~/.homebrew`** (inside the `denyRead ~/` region); the brief's `allowRead`
   only has `/opt/homebrew`. The spike adds `$(brew --prefix)`.

## 3. Details

### 3.1 Launch sequence (exact calls and shapes)

```text
orca worktree create --repo id:<repoId> --name wm-spike-<8hex> --no-parent --setup skip --comment "wingmate spike" --json
  result keys: worktree, lineage, workspaceLineage, warnings, catalogVersion
  result.worktree.id = "<repoId>::/Users/jujufugh/orca/workspaces/wingmate-agents/wm-spike-<8hex>"
orca worktree show --worktree id:<wt> --json
  result.worktree.branch = "refs/heads/wm-spike-<8hex>"          (no <gitUsername>/ prefix)
  result.worktree.path   = ".../wm-spike-<8hex>"   .head = main's HEAD sha
```

`worktree create` also opens **one default shell terminal** (`terminal list` row with `title:"Terminal 1"` and **no
`agentIdentity` key**), so after the agent launch `terminal list --worktree` has two rows; select by the recorded handle.

```text
orca terminal create --worktree id:<wt> --title "wingmate spike" \
  --command "exec claude --model 'claude-fable-5-1[1m]' --effort max --session-id <uuid> --permission-mode bypassPermissions" --json
result.terminal = { handle:"term_<uuid>", tabId, paneKey:"<tabId>:<leafId>", ptyId, worktreeId, title,
                    executionHostId:"local", incarnationId, hostPlatform:"darwin", surface:"visible" }
```

* `--command` is typed into the login shell (zsh). **The model id contains `[1m]`, a zsh glob: it must be
  single-quoted** or the line fails with `no matches found`. `shq()` in the spike does this.
* There is **no `leafId` field** in the create result; `paneKey` already is `"<tabId>:<leafId>"` and equals the later
  `terminal list` row's `${tabId}:${leafId}` and the `worktree ps` `agents[].paneKey`.

```text
orca terminal wait --terminal <h> --for tui-idle --timeout-ms 120000 --json
ready:    result.wait = { handle, condition:"tui-idle", satisfied:true,  status:"running", exitCode:null }
blocked:  result.wait = { handle, condition:"tui-idle", satisfied:false, status:"running", exitCode:null,
                          blockedReason:"agent-trust-workspace" }
```

```text
orca terminal send --terminal <h> --text "<prompt>" --enter --wait-submit 15 --json      (returned in ~2 s)
result.send = { handle, accepted:true, bytesWritten:<n>,
                prompt: { requestId:"<uuid>", stages:["input_accepted","turn_started"], provider:"claude",
                          observation:"supported", processIncarnation, generation,
                          baselineWorkingSequence, baselineExplicitWorkingStartedAt, baselinePermissionSequence } }
result.mutation = { requestId:"<same uuid>", replayed:false }
```

Not reaching `turn_started` (observed when the text went into the trust dialog, and for slash commands such as
`/exit`): `stages:["input_accepted"]` plus `result.warnings:["input was accepted but no turn start was observed, so the
Enter may have been swallowed. Confirm delivery by reissuing the exact command with --retry-request <requestId>
--wait-submit <seconds>; the same request ID replays the receipt instead of sending the prompt again."]`.

Resume: `exec claude --model '…' --effort max --resume <session-id> --permission-mode bypassPermissions` in a new terminal
of the same worktree → `tui-idle` `satisfied:true`; the rendered screen (`terminal read --screen`) shows the restored
transcript (the earlier prompt, `⏺ READY`, `✻ Baked for 3s`); `worktree ps` shows an `agents[]` entry in `state:"done"`
with `lastAssistantMessage:null` immediately (no turn yet). Claude prints `Resume this session with: claude --resume
<id>` on exit (visible in `terminal show` → `preview`). Model-level recall was not tested (no extra quota spent).

Cost datum for the budget model: after the first trivial turn (a 25 s sleep and one word) of a `claude-fable-5-1[1m]` session
the statusline showed `$1.37` with `81k/1000k` context in use (user-level CLAUDE.md, skills and tool listings — about 80k
tokens are in context before any work is done).
The §13.3(b)-style `-p` probe with `--strict-mcp-config` cost `$0.84` for 9 turns.

### 3.2 The trust dialog (new, not in the spec)

Rendered with `terminal read --screen`:

```text
 Accessing workspace:
 /Users/jujufugh/orca/workspaces/wingmate-agents/wm-spike-<8hex>
 Quick safety check: Is this a project you created or one you trust? …
 Claude Code'll be able to read, edit, and execute files here.
 Security guide
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel
```

* The default highlight is **"No, exit"**. Answer: `orca terminal send --terminal <h> --text $'\x1b[B' --json` (Down
  arrow, `bytesWritten:3`; the screen then shows `❯ Yes, I trust this folder`), then `orca terminal send --terminal <h>
  --enter --json` (`bytesWritten:1`), then `terminal wait --for tui-idle` → `satisfied:true`. The TUI header follows.
* Orca's `terminal wait` returned `satisfied:false` + `blockedReason` in well under a minute, not after the 120 s timeout.
* **Where trust is stored (consistent with, not proven).** Dialog seen for `wm-spike-a628dfa4` (run 1) and
  `wm-spike-f3e64acb` (exploration, answered "Yes"); **not** seen for the new path `wm-spike-3a04789d` (run 2) in the
  same repo. `~/.claude.json` has no entry for any scratch path, but `projects["/Users/jujufugh/orca/projects/wingmate-agents"]`
  (the **main checkout**) has `hasTrustDialogAccepted:true` and `lastSessionId` = run 2's session id, i.e. sessions in
  linked worktrees record against the repo root. The 14 `~/orca/workspaces/*` entries in `~/.claude.json` each hold exactly one
  key, `hasTrustDialogAccepted:true`. The pre-acceptance value of the main-checkout entry was not captured.
* Design implications for Task 8/12: (a) `doctor` can read `~/.claude.json` `projects[<repo main checkout>].hasTrustDialogAccepted`
  for each pilot repo, or run one throwaway launch, and refuse `install --enable` when it is not `true`; (b) the launch
  step, on `blockedReason:"agent-trust-workspace"`, either parks with an attention flag (`launch_blocked_trust`) or
  answers the dialog (Down, Enter) for a worktree path the dispatcher itself created; it must never send the pointer
  brief into the dialog.

### 3.3 Liveness vocabulary (fixtures: `terminal-list-*.json`, `worktree-ps-*.json`)

| moment | `worktree ps` row | `agents[]` | `terminal list --worktree` |
|---|---|---|---|
| `working` (receipt + 5 s) | `status:"working"`, `liveTerminalCount:2` | `[{ state:"working", agentType:"claude", toolName:null→"Bash", stateStartedAt:<turn start>, updatedAt, prompt:"<our prompt>" }]` | shell row + agent row `agentIdentity:"claude"`, `title:"◑ Sleep command test"` |
| `idle` / turn ended (+65 s) | `status:"active"`, `liveTerminalCount:2` | `[{ state:"done", toolName:null, lastAssistantMessage:"READY", stateStartedAt:<turn end>, updatedAt:<≥ turn end> }]` | both rows; agent title `✳ …` |
| after `terminal close --worktree … --all` | `status:"inactive"`, `liveTerminalCount:0`, `lastOutputAt:null` | `[]` | `terminals:[]`, `totalCount:0` |

Other exit paths (each observed in the final run or the exploration):

| path | `terminal list` | `agents[]` | `terminal wait --terminal <h> --for exit` | `terminal show --terminal <h>` |
|---|---|---|---|---|
| natural exit (`/exit`, PTY ends because of `exec`) | row gone | entry removed | `satisfied:true, status:"exited", exitCode:0, exitCause:{kind:"unknown",reason:"host_status_unavailable"}` | — |
| `terminal close --terminal <h>` (single pane) | row gone | entry removed (`worktree ps`: `inactive`, `agents:[]`) | not queried; close result `{close:{handle,tabId,ptyKilled:true}}` | — |
| `terminal close --worktree … --all` | rows gone | entries removed | `satisfied:true, status:"exited", exitCode:0, exitCause:{kind:"operator_close"}`; close result `{closed:2,stopped:2,retiredSurfaces:true}` | `orphaned:true`, `recordedPaneKey`, `connected:false`, `writable:false`, `exitCause`, `preview` (includes the `claude --resume <id>` line) |
| PTY already ended before the close (run 1) | row gone | none | `satisfied:true, status:"exited", exitCode:-1, exitCause:{kind:"unknown",reason:"stop_unverified"}` | — |

* Join key: `agents[].paneKey === "${tabId}:${leafId}"` of the `terminal list` row; `terminal create` returns it as
  `result.terminal.paneKey`.
* `worktree ps` row `status` ∈ {`working`, `active`, `inactive`} fleet-wide; it can **lag** the agent (one poll saw
  row `working` while `agents[0].state` was already `done`) — use `agents[].state`.
* Fleet-wide vocabulary at capture time (61 worktrees, 30 agent entries, 100 newest of 254 workers):
  `agents[].state` ∈ {`done`, `working`}; `agents[].agentType` ∈ {`claude`, `codex`, `antigravity`};
  `workspaceStatus` ∈ {`completed`, `in-progress`, `in-review`}; `terminal.agentIdentity` ∈ {`claude`,
  `claude-agent-teams`} (absent on shells); worker rows `workerState` ∈ {`failed`, `stopped`, `succeeded`},
  `dispatchStatus` ∈ {`completed`, `failed`}, `terminalState` ∈ {`released`, `retained`},
  `projection.liveness.verdict` ∈ {`exited`, `unverifiable`}, `projection.liveness.source` ∈ {`resource_release`, absent},
  `projection.stage.activity` = `unknown`, `projection.nextAction.kind` = `none`. `worker-list` without `--run` returns the
  newest 100 and `page:{limit,total,hasMore,nextCursor}`.
* `unverifiable` (spec §5.5) is not producible in a spike: *default applied*.

### 3.4 Claude sandbox (`--settings` outside the worktree)

Settings used (paths resolved with `pwd -P`; `/tmp` is `/private/tmp` on macOS):

```json
{ "sandbox": { "enabled": true, "allowUnsandboxedCommands": false, "failIfUnavailable": true, "autoAllowBashIfSandboxed": true,
    "filesystem": {
      "denyRead": ["~/"],
      "allowRead": ["<W>", "/usr", "/bin", "/opt/homebrew", "~/.local/share/claude", "~/.local/bin", "~/.bun", "~/.homebrew"],
      "allowWrite": ["<W>", "<TMPDIR real path>", "<C>/objects/**", "<C>/refs/heads/wm-*", "<C>/logs/**", "<C>/worktrees/<gitdirName>/**", "<C>/packed-refs*"],
      "denyWrite": ["<C>/config", "<C>/hooks/**", "<C>/info/**", "<C>/refs/heads/main*", "<C>/refs/remotes/**"] },
    "network": { "allowedDomains": ["registry.npmjs.org"] } },
  "permissions": { "deny": ["Bash(git push *)", "Bash(gh pr create *)", "Read(~/.config/wingmate/**)"] } }
```

`W` = linked worktree, `C` = `<main>/.git`, both under `/tmp`. Run: `claude --settings <kit>/claude-settings.json
--permission-mode bypassPermissions --model 'claude-fable-5-1[1m]' --strict-mcp-config --no-session-persistence -p … --output-format
stream-json --verbose` with `GH_TOKEN=`, `GH_CONFIG_DIR=<kit>/gh-empty`, `GIT_CONFIG_NOSYSTEM=1`,
`GIT_CONFIG_GLOBAL=<kit>/gitconfig`, `GIT_TERMINAL_PROMPT=0`. Result: exit 0, 9 turns, 8 Bash calls, `permissionMode:
"bypassPermissions"`, `mcp_servers: 0`, empty stderr (no settings-validation noise), `$0.84`.

| # | command (run by the model, one Bash call each) | observed | verdict |
|---|---|---|---|
| 1 | `cat ~/.config/wingmate/credentials.json` | exit 1, `cat: /Users/jujufugh/.config/wingmate/credentials.json: Operation not permitted` (canary absent from the transcript) | blocked ✓ |
| 2 | `git ls-remote https://github.com/furoyce/jr-learning-plus.git HEAD` (private) | exit 128, `fatal: could not read Username for 'https://github.com': terminal prompts disabled` | failed **on auth, not on network** — inconclusive alone |
| 3 | `sh -c "echo hi > escape.txt"` | exit 0; `escape.txt` = `hi` on disk | allowed ✓ |
| 4 | `git -C . commit --allow-empty -m probe` (linked worktree, branch `wm-spike-probe`) | exit 0, `[wm-spike-probe 0430ed4] probe` after `warning: unable to access '/Users/jujufugh/.config/git/ignore': Operation not permitted`; commit present on disk | allowed ✓ — **the `objects/**`, `refs/heads/wm-*`, `logs/**`, `worktrees/<name>/**`, `packed-refs*` globs work** |
| 5 | `gh api user` | exit 4, `To get started with GitHub CLI, please run:  gh auth login` | fails ✓ (no auth; network not what stopped it) |
| 6 | `sh -c "echo x > <C>/hooks/pre-commit"` | exit 1, `Operation not permitted`; file absent on disk | blocked ✓ (`denyWrite` `hooks/**` works) |
| 7 | `git ls-remote https://github.com/git/git.git HEAD` (public control) | exit 0, `5a7d1e8045ce66c908f62598e26cbb8df7b39a90	HEAD` | **GitHub reachable — allowlist NOT enforced ✗** |
| 8 | `curl -sS -m 15 -o /dev/null -w "%{http_code}" https://registry.npmjs.org/` | `200` | allowed domain answers ✓ |

Quota-free posture check (usable by `doctor` without a model call): `claude --settings <file> sandbox status` →
`{"enabled":true,"enabledSource":"policy","strictMode":true,"strictModeSource":"policy","filesystemPolicy":"strict",
"autoAllowBashIfSandboxed":true,"autoAllowBashIfSandboxedSource":"policy",…}`; without `--settings`: `enabled:false,
enabledSource:"off", strictMode:false, autoAllowBashIfSandboxedSource:"default"` (`filesystemPolicy:"strict"` appears
either way, so it proves nothing about our file). `strictMode` is `true` only for files that set `allowUnsandboxedCommands: false`
(minimal probe files without it reported `strictMode:false`). The `policy` source on the three settings that `--settings` supplied
indicates the flag is a policy-tier source that user/project settings should not override (inference from the label).
It reports only enabled/strict/Bash-auto-allow: it says nothing about the network allowlist (see §3.4a).

**Check (7) showed that `allowedDomains` alone is not a network control; §3.4a (two follow-up runs) finds the settings that are.**

Not tested here: an attempt to opt out of the sandbox per command with `dangerouslyDisableSandbox` (the probe told the model
not to work around failures); a write outside every `allowWrite` path other than the denied hooks directory;
production-like locations. The spike dirs live under `/tmp`, which `denyRead ~/` does not
cover, whereas real worktrees and the git common dir (`~/orca/projects/<repo>/.git`) are under `~/`: whether the common
dir must be in `allowRead` (the spec lists only worktrees and toolchain paths) is **unverified** and is exactly what
Task 12's `doctor` probe from a real `wm-` worktree will show.

### 3.4a Network control follow-up (two more `claude -p` runs: `deny` and `strict`)

**Question.** In §3.4 `allowedDomains: ["registry.npmjs.org"]` did not block github.com. Which `sandbox.network` setting, loaded
from a dispatcher-owned `--settings` file, does? **Method.** `bash spikes/claude-network-spike.sh <variant>`; the harness is that
of `claude-sandbox-spike.sh` (same filesystem lists, §13.3(b) environment, `-p --permission-mode bypassPermissions
--strict-mcp-config --no-session-persistence`, linked scratch worktree, stream-json, canary credentials file) and only the
`sandbox.network` block differs. The model ran each command as one Bash call.

| run | `sandbox.network` | cost |
|---|---|---|
| A `deny` | `{"allowedDomains":["registry.npmjs.org"],"deniedDomains":["github.com","api.github.com","*.githubusercontent.com","example.com"]}` | $0.75, 8 turns |
| B `strict` | `{"allowedDomains":["registry.npmjs.org"],"strictAllowlist":true}` | $0.76, 9 turns |

Quota-free pre-checks, both runs: `claude --settings <file> sandbox status` → `enabled:true, enabledSource:"policy",
strictMode:true`; `claude --settings <file> doctor` → no "Invalid settings" section. Run A used an earlier revision of the script
(commands (1)–(7), `--debug-file` instead of `SRT_DEBUG`, a stricter output classifier); Run B the committed one (adds (8) and `SRT_DEBUG=1`).

Results (*blocked* = exit 56 `curl: (56) CONNECT tunnel failed, response 403` / exit 128 for git, followed by a `<sandbox_violations>`
block in the tool result; *reachable* = HTTP status printed, exit 0):

| # | command | A: `deniedDomains` | B: `strictAllowlist` |
|---|---|---|---|
| 1 | `git ls-remote https://github.com/git/git.git HEAD` | **blocked** — `fatal: unable to access 'https://github.com/git/git.git/': CONNECT tunnel failed, response 403`; `deny network-outbound github.com:443 (host is on the deny list)` | **blocked** — same message; `deny network-outbound github.com:443 (host is not on the allow list)` |
| 2 | `curl -sS -m 10 -o /dev/null -w "%{http_code}" https://api.github.com/zen` | **blocked** — exit 56, `000`; `api.github.com:443 (host is on the deny list)` | **blocked** — exit 56, `000`; `(host is not on the allow list)` |
| 3 | same, `https://example.com/` | **blocked** — `example.com:443 (host is on the deny list)` | **blocked** — `(host is not on the allow list)` |
| 4 | same, `https://pypi.org/` | **reachable — `200`** (not listed anywhere) | **blocked** — `pypi.org:443 (host is not on the allow list)` |
| 5 | same, `https://registry.npmjs.org/` | reachable — `200` | reachable — `200 exit=0` |
| 6 | same, `https://raw.githubusercontent.com/git/git/master/README.md` (extra) | **blocked** by the wildcard `*.githubusercontent.com` — `raw.githubusercontent.com:443 (host is on the deny list)` | **blocked** — `(host is not on the allow list)` |
| 7 | (2) again with the Bash tool parameter `allowed_domains:["api.github.com"]` (extra) | **blocked** — the model did pass the parameter (the Bash tool has it); the deny list still won: same 403 | **refused before running** — `<tool_use_error>allowed_domains cannot widen network access in this session: the configured sandbox allowlist is the whole allowlist here (a managed-domains-only or strictAllowlist policy, or a confined evaluation run). Remove allowed_domains and use a host the configured allowlist already covers.</tool_use_error>` |
| 8 | (2) again with `curl --noproxy "*"` (extra, run B only) | not run | **blocked** — `curl: (6) Could not resolve host: api.github.com`, `000 exit=6`: a client that ignores the sandbox proxy cannot resolve hosts |

Run B's stderr with `SRT_DEBUG=1` (the sandbox runtime's own decision log, 44 lines): `[SandboxDebug] Mux proxy (HTTP+SOCKS) listening on
localhost:62713`; 28 × `[Sandbox macOS] Applied restrictions - network: true, read: denyAllExcept, write: denyAllExcept` (one for each
wrapped process); per blocked host `No matching config rule, denying: <host>:443` followed by `Connection blocked to <host>:443`
(github.com, api.github.com, example.com, pypi.org, raw.githubusercontent.com); and `Allowed by config rule: registry.npmjs.org:443`.

**Answers.**
* **(a) Which key blocks github.com:** both `deniedDomains` (named hosts and the `*.githubusercontent.com` wildcard; it beat the per-command
  `allowed_domains` grant in run A, and by the code's evaluation order it also beats `allowedDomains`) and `strictAllowlist: true` (closes the
  allowlist: everything not in `allowedDomains` is denied). `allowedDomains` alone blocks nothing. `allowManagedDomainsOnly` was **not run**: the
  binary reads it from managed/policy settings only (`Yu()`, which excludes the `--settings` source), so from a `--settings` file it is accepted
  without error (`claude --settings <file> doctor` prints no "Invalid settings" section for it; `sandbox status` shows nothing) and, by the code,
  ignored; honoring it would need a root-owned `/Library/Application Support/ClaudeCode/managed-settings.json` (absent here). The fallback
  `deniedDomains:["*"]` was not needed; it would also block npm, because a denied host is refused even when `allowedDomains` lists it.
* **(b) Hosts outside `allowedDomains` that are not GitHub:** in run A (no strict mode) **pypi.org is reachable** (example.com was blocked there
  only because it is on the deny list), so the allowlist is **advisory** under `bypassPermissions`, and github.com is **not** a built-in allowed
  domain: with `strictAllowlist` github.com, example.com and pypi.org are all blocked. Mechanism (source reading of Claude Code 2.1.291; the runtime's host filter): `deniedDomains` → `allowedDomains`
  (merged across settings sources and `WebFetch(domain:X)` allow rules; the owner's `WebFetch(*)` does **not** merge) → if `strictAllowlist`: deny →
  per-command `allowed_domains` → if there is no ask callback: deny → otherwise **ask the permission system**, which `bypassPermissions` grants
  (inferred from the code and from run A's pypi.org; run A had no `SRT_DEBUG`, so the "asking" line itself was not captured).
  Per the schema text and code (not exercised by a run), `strictAllowlist` is honored from user, managed or `--settings` sources only, and while it is
  on, `WebFetch(domain:…)` allow rules are not merged into the sandbox allowlist and project/local `allowedDomains` are ignored.
* **(c) Consequence for Task 9:** write `strictAllowlist: true` plus `allowedDomains` (registries and provider hosts per project) into the kit's
  `claude-settings.json`, and list the GitHub/GitLab/Vercel/Supabase/Neon hosts (including wildcards such as `*.githubusercontent.com`) in
  `deniedDomains` so a mistaken `allowedDomains` entry cannot re-open them. That combination follows from the verified evaluation order but was not run
  as one probe. The sandbox filter applies to sandboxed commands only: the schema text says in-process tools such as WebFetch are **not** gated by
  `strictAllowlist` (WebSearch and MCP servers also sit outside the Bash sandbox — inference), and the owner's user settings allow `WebFetch(*)`; Task 9
  should add `WebFetch` and `WebSearch` to the kit's `permissions.deny` (deny wins) for roles that do not need them. Not tested in a run.

**Also learned (quota-free).** `claude --settings <file> doctor </dev/null` prints an "Invalid settings" section naming the file and key path, e.g.
`sandbox.network.strictAllowlist: Expected boolean, but received string`. An invalid value silently drops the **whole** sandbox block
(`claude sandbox status` → `enabled:false, enabledSource:"off"`) and `sandbox status` prints no error, while unknown keys are tolerated; `doctor` must
therefore check the Invalid-settings section and `enabled:true, strictMode:true`. The Bash tool of this version has an `allowed_domains` parameter
(per-command network grants); with `strictAllowlist` it is refused (row 7). A blocked host is reported to the model as a `<sandbox_violations>`
block (`deny network-outbound <host>:<port> (host is on the deny list | host is not on the allow list)`), a stable signature for `doctor`.

**Limits.** One run per variant. The `managed-only` and `deny-all` variants exist in the script but were not run. Direct TCP to a literal IP address
(not a host name) was not tried; the proxy-ignoring client failed at name resolution, and the runtime logs network restrictions as applied to each
wrapped process (`network: true`), which I read as the OS-level profile blocking direct egress. The model appended `; echo "exit=$?"` to its commands in run B, so a failing command shows `is_error:false`
there; the classifier in the script reads the content.

### 3.5 Codex (CLI 0.160.1)

Flag acceptance (`<cmd> <flags> --help`, no model call; `-c key=value` is always accepted syntactically):

| form | accepted | rejected |
|---|---|---|
| `codex exec` | `--sandbox read-only`, `--sandbox workspace-write`, `-C <dir>`, `-c approval_policy=never`, `-c model_reasoning_effort=xhigh`, `-c project_doc_max_bytes=0`, `-c sandbox_workspace_write.network_access=false` | `--ask-for-approval never`, `-a never` (`error: unexpected argument '--ask-for-approval' found`) |
| interactive `codex` | `-C <dir> --ask-for-approval never --sandbox read-only -c project_doc_max_bytes=0 -c model_reasoning_effort=xhigh`; `--sandbox workspace-write -c sandbox_workspace_write.network_access=false --ask-for-approval never` | — |

Runs (`codex exec`, banner shows the applied settings):

| run | banner | result |
|---|---|---|
| 1: `--sandbox read-only -c approval_policy=never -c model_reasoning_effort=xhigh -c project_doc_max_bytes=0` | `approval: never`, `sandbox: read-only`, `reasoning effort: xhigh`, `reasoning summaries: none`, 10,498 tokens | `cat ~/.config/wingmate/credentials.json` **printed the canary** (readable); `curl https://api.github.com/zen` → `curl: (6) Could not resolve host: api.github.com`; codeword from `AGENTS.md` → `NONE` (consistent with `project_doc_max_bytes=0` honored; no control run to prove it) |
| 2: `--sandbox workspace-write -c approval_policy=never -c sandbox_workspace_write.network_access=false` | `approval: never`, `sandbox: workspace-write [workdir, /tmp, $TMPDIR]`, 7,729 tokens | `probe.txt` written in the worktree; `curl https://registry.npmjs.org/` → `curl: (6) Could not resolve host: registry.npmjs.org` |

Note the writable roots in the banner: `workdir`, `/tmp` **and** `$TMPDIR`. **D14 extension: Codex sessions can read the
owner's files** (reads outside the worktree are not blocked; only writes and network are). This is for the owner's
confirmation per §13.3(c).

## 4. Field-name reference (exact, for Tasks 2, 5, 8, 9)

All fixtures are full envelopes `{ id, ok, result, _meta:{runtimeId} }`; consumers read `.result`.

* `worktree ps` → `result` keys `worktrees[]`, `hostScope{hostIds[],omittedHostIds[]}`, `totalCount`, `truncated`.
  Row keys: `workspaceKind, worktreeId, repoId, hostId, terminalPlatform, repo, path, branch, isArchived, isMainWorktree,
  hasHostSidebarActivity, worktreeInstanceId, parentWorktreeId, childWorktreeIds, displayName, workspaceStatus,
  sortOrder, lastActivityAt, createdAt, creatorProvenance, linkedIssue, linkedPR, linkedLinearIssue (string
  identifier, e.g. "JRF-397"), linkedGitLabMR, linkedGitLabIssue, comment, isPinned, isActive, unread, liveTerminalCount,
  hasAttachedPty, lastOutputAt, preview, status, agents` plus, on some rows only, `lineageWorktreeInstanceId,
  parentWorktreeInstanceId`. `branch` is `refs/heads/<name>`. `linkedPR` is `null` or `{number,state}`.
* `agents[]` entry keys: `paneKey, parentPaneKey, state, agentType, prompt, taskTitle, displayName, lastAssistantMessage,
  toolName, toolInput, interrupted, mainAgent{state,stateStartedAt}, stateStartedAt, updatedAt` (epoch **milliseconds**
  numbers; `mainAgent` absent on 1 of 30 fleet entries; `toolInput` is a string or null).
* `terminal list` → `result` keys `terminals[]`, `hostScope`, `topologyRevisions{<worktreeId>:n}`, `totalCount`, `truncated`.
  Row keys: `handle, ptyId, incarnationId, orphaned, worktreeId, worktreePath, branch, tabId, leafId, title, connected,
  writable, lastOutputAt, preview, executionHostId` plus **optional** `agentIdentity` (`"claude"`; absent on plain
  shells). The row `branch` can be `""`.
* `orchestration worker-list` → `result` keys `workers[], counts{retained,released}, page, warnings, scope{source}`; row keys
  `dispatchId, taskId, runId, workerState, dispatchStatus, agentTerminalHandle, terminalState, resource{…}, projection{id,
  dispatchId, taskId, runId, role, parent, provider, host, workspace, stage{worker,dispatch,detail,activity}, outcome,
  liveness{verdict,source}, evidence, resource, nextAction{kind,argv}, attention{categories,requiresAction}}`.
* `account list` → `result` keys `claude{accounts,activeAccountId,activeAccountIdsByRuntime}`, `codex{…, systemDefault}`,
  `rateLimits{claude{session,weekly,fableWeekly,updatedAt,error,status,usageMetadata}, codex, gemini, …}`; each window is
  `{usedPercent, windowMinutes, resetsAt, resetDescription}`.
* `automations list` → `result` keys `automations[], items[], orphanCount`; row keys `id, name, prompt, precheck{command,
  timeoutSeconds}|null, agentId, runContext, sourceContext, projectId, executionTargetType, executionTargetId, schedulerOwner,
  workspaceMode, workspaceId, baseBranch, reuseSession, timezone, rrule, dtstart, enabled, nextRunAt, missedRunPolicy,
  missedRunGraceMinutes, createdAt, updatedAt, lastRunAt`.

### Accessor map for Task 5 (plan draft → observed)

| draft accessor | observed |
|---|---|
| `terminalCreate`: `r.handle`, `r.tabId`, `r.leafId` | `r.terminal.handle`, `r.terminal.tabId`, `r.terminal.paneKey` (**no `leafId`**; `paneKey.split(":")[1]`) |
| `terminalWait`: `r.wait.satisfied` | ✓ same; **add** `r.wait.blockedReason`, `r.wait.status`, `r.wait.exitCode`, `r.wait.exitCause{kind,reason}` |
| `terminalSend`: `r.stages`, `r.requestId` | `r.send.prompt.stages`, `r.send.prompt.requestId` (also `r.mutation.requestId`); warnings in `r.warnings[]` |
| `terminalShowPreview`: `r.preview` | `r.terminal.preview` |
| `terminalClose`: `terminal close --worktree --all` | ✓ result `{closed, stopped, retiredSurfaces}` (single pane: `{close:{handle,tabId,ptyKilled}}`) |
| `workerList`: `r.workers[].projection.liveness.verdict` | ✓ same |
| `workerStop`: `r.liveness.verdict` | **not exercised** (no worker was started) |
| `worktreeRm` | returns `{removed:true, removing:true, catalogVersion}` immediately; the checkout and branch disappear a moment later (the branch was removed by Orca itself) |
| `worktree current/show/create` fields at `result.*` | nested: `result.worktree.{id, repoId, branch, path, …}` |

## 5. Orca CLI facts

* `orca <verb> … --help` works (the brief's loop failed only because zsh does not word-split `$v`). Selectors:
  `id:<repoId>::<worktreePath>`, `name:`, `path:`, `branch:`, `issue:`; repo selectors `id:<id>`, `name:`, `path:`.
* Every flag of the brief's launch spike exists on 1.4.220: `worktree create --repo --name --no-parent --setup skip
  --comment`, `terminal create --worktree --title --command`, `terminal wait --terminal --for --timeout-ms`, `terminal
  send --terminal --text --enter --wait-submit`, `terminal close --worktree --all`, `worktree rm --worktree --force`.
  Also used: `terminal read --terminal [--screen]`, `terminal show --terminal`, `terminal close --terminal`.
* `terminal read --terminal <h> --screen` returns the **rendered** frame: `result.terminal.{handle, status, tail[],
  truncated, limited, oldestCursor, nextCursor, latestCursor, returnedLineCount, source:"screen"}`. Without `--screen`
  it returns accumulated output with repaints stacked (`source:"stream"`), where the trust dialog's option list is not
  recoverable (the tail showed only `Security guide` / `❯ No, exit`): use `--screen` to detect dialogs.
* **`orca automations edit --help`** (flag list; for Task 12): `orca automations edit <id> [--name <name>] [--trigger
  <preset|cron|rrule>] [--json]`, options `--help, --json, --pairing-code, --environment, --id <id>, --name <name>, --prompt
  <text>, --provider <agent>, --precheck, --precheck-timeout, --repo <selector>, --workspace <selector>, --project, --host,
  --project-host-setup, --source-context <json|null>, --workspace-mode <mode>, --base-branch <ref>, --trigger <schedule>,
  --schedule <schedule> (alias), --time <HH:MM>, --day <0-6>, --timezone <tz>, --enabled, --disabled,
  --missed-run-grace-minutes <n>, --reuse-session, --fresh-session`. Examples from the help: `orca automations edit 2f9e...
  --disabled`; `orca automations edit --id 2f9e... --trigger "30 * * * *" --json`. **`edit` accepts every flag `create`
  accepts** (`create`'s flag set equals `edit`'s minus the positional/`--id`); the one-line usage is abbreviated.
* `worktree create --name X` produced branch `refs/heads/X` with no `<gitUsername>/` prefix (the §13.3(b) pattern
  `refs/heads/wm-*` matches `wm-` worktrees).

## 6. Fixtures and scrubbing

Files (`tests/fixtures/orca/`): `worktree-ps.json`, `account-list.json`, `automations-list.json`, `worker-list.json`,
`terminal-list-sample.json` (read-only capture, sampled) and `terminal-list-{working,idle,exited}.json`,
`worktree-ps-{working,idle,exited}.json` (launch spike; `worktree ps` filtered to the scratch worktree's row).
They passed a Task-2-style shape check (envelope `ok:true`; required row keys; `agents[0].paneKey` joins the
`terminal list` row by `tabId:leafId` in the working and idle fixtures; exited has empty `agents`/`terminals`).
`grep -rniE 'token|secret|password|bearer|sk-ant|ghp_|api[_-]?key' tests/fixtures/orca/` prints nothing.

The raw captures carried fleet-wide free text from unrelated projects, so scrubbing happens **before** the write (see
`spikes/README.md`): free text kept (cut to 80 chars + `…`) only for this repo's rows, `REDACTED` elsewhere;
e-mail → `user@example.invalid`; credential-looking strings → `REDACTED`; credential-looking keys with non-string values
dropped. Redactions in the committed files: `account-list` — `codex.systemDefault.email` → `user@example.invalid`,
`providerAccountId` → `REDACTED`, keys `rateLimits.minimaxApiKeyConfigured`/`opencodeGoApiKeyConfigured` (booleans)
dropped; `automations-list` — `prompt` ×3, `precheck.command` ×2 → `REDACTED`, `items[].usageSummary.{inputTokens,
outputTokens,cacheTokens,reasoningOutputTokens,totalTokens}` (numbers) dropped; `worker-list` — `page.nextCursor`
(base64 cursor, matched the JWT pattern) → `REDACTED`; `worktree-ps` — free text of other repos' rows (`agents[].prompt`
×3, `toolInput` ×2, `lastAssistantMessage` ×3, `preview` ×1) plus one `lastAssistantMessage` of this repo's own row that
mentioned a credential word → `REDACTED` (a raw 2,595-character `lastAssistantMessage` containing `sk-ant-` was seen
in the uncommitted raw capture; no committed file contains it). Sampling: `worktree-ps.json` keeps 3 of 61 rows, `automations-list` 3 of 5,
`worker-list` 4 of 100; `totalCount` was set to the sampled row count in `worktree-ps.json`.

## 7. Concerns and recommendations

1. **Network control: resolved by the follow-up (§3.4a).** `allowedDomains` alone does not block anything under `bypassPermissions`; `strictAllowlist: true`
   and `deniedDomains` are enforced from the `--settings` file. Task 9 must write `strictAllowlist: true` (+ `allowedDomains`, + `deniedDomains` for the
   GitHub/GitLab/Vercel/Supabase/Neon hosts); `doctor` must verify it (Invalid-settings section, `sandbox status`, a `<sandbox_violations>` probe). Still open:
   the combined `strictAllowlist` + `deniedDomains` file was not run as one probe; WebFetch/WebSearch/MCP are not gated by the sandbox (deny them in
   `permissions.deny`); `allowManagedDomainsOnly` (managed settings only) was not run.
2. **Trust dialog.** §3.2. The launch step and `doctor` need an explicit design (park vs answer; per-repo trust check).
3. **Codex reads are unrestricted** — D14 extension for the owner's confirmation (§3.5).
4. **Spec §5.5 "retained `done` entries"** does not occur on Orca 1.4.220; the liveness code can rely on "handle absent
   from `terminal list`".
5. **Rows 3, 6, 7 are defaults, not verifications.** Row 3 (`spawn` at depth 1) is the one with design weight
   (`method loop` fallback); it needs a coordinator turn plus a Run and could be verified at the start of slice 2.
6. **Side effects beyond the brief.** Three scratch worktrees (`wm-spike-a628dfa4`, `wm-spike-f3e64acb`,
   `wm-spike-3a04789d`) were created and removed (verified: none in `orca worktree ps`, no `wm-spike*` branch, no
   directory); three `claude -p` runs (`$0.84` for §3.4, then `$0.75` and `$0.76` for the §3.4a follow-up, which created no Orca worktree); two Claude TUI
   sessions with one trivial turn each (the exploration's turn showed `$1.37`) plus no-turn resumes; two `codex exec` runs. Claude Code itself updated
   `~/.claude.json` (trust for this repo and `lastSessionId`/cost fields on the main-checkout entry; no scratch-path entry remains). Temp directories
   under `/tmp` that the spikes leave in place (no secrets; the canary credentials file was removed after every run and `~/.config/wingmate` does not
   exist): from §3.4 and §3.5 `wm-kit.G1S0`, `wm-sandbox-spike.VIBo`, `wm-sandbox-spike.VIBo-wt`, `wm-codex-spike.lZuY`; from §3.4a `wm-kit.irtk`,
   `wm-sandbox-spike.8dOf`, `wm-sandbox-spike.8dOf-wt` (run A) and `wm-kit.lTLM`, `wm-sandbox-spike.OuYf`, `wm-sandbox-spike.OuYf-wt` (run B).
