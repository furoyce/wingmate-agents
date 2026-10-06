# Verification spikes (§16.1)

Throwaway scripts that verify the facts Wingmate's code depends on. They are **not** part of the product, they are
not imported by `src/`, and nothing in them touches Linear. Results are recorded in
`docs/superpowers/plans/spike-results-2026-10-06.md`; the Orca captures they write are the fixtures under
`tests/fixtures/orca/`.

Run every spike from the repository root, one at a time (never in parallel), in this order. Orca must be running
(`orca worktree current --json` returns `ok: true`). `jq` is needed by the two shell spikes.

| # | Script | What it verifies | Side effects |
|---|--------|------------------|--------------|
| 1 | `bun spikes/orca-vocab-capture.ts` | Field names and state vocabulary of `worktree ps`, `terminal list`, `account list`, `automations list`, `orchestration worker-list`; prints the fleet-wide vocabulary as one `VOCABULARY {…}` line. | **Read-only** against Orca. Writes five scrubbed, sampled envelopes to `tests/fixtures/orca/`. |
| 2 | `bun spikes/orca-launch-spike.ts` (~3 min) | Terminal-agent launch: `worktree create`, `terminal create --command "exec claude …"`, `terminal wait --for tui-idle` (answers Claude's folder-trust dialog, which Orca reports as `blockedReason: "agent-trust-workspace"`, with Down + Enter), `terminal send … --wait-submit` receipts, `--effort max`, the working → done → closed fleet vocabulary in three snapshots, `claude --resume <id>` in the same worktree, and two no-turn probes (natural `/exit`, single-terminal close). | Creates **one** scratch worktree `wm-spike-<8 hex>` in *this* repository and removes it (and its branch) at the end, even on failure. One Claude turn of quota (≈ $1–2 on `claude-fable-5-1[1m]`); resumed sessions run no turn. Claude records the trust answer in `~/.claude.json`. Writes the six `*-{working,idle,exited}` fixtures. |
| 3 | `bash spikes/claude-sandbox-spike.sh` | The §13.3(b) Claude settings file loads via `--settings` from outside the worktree and enforces: `denyRead ~/`, `allowWrite`/`denyWrite` globs, `git commit` in a *linked* worktree under the git common-dir write policy, hooks directory not writable, `gh` unauthenticated, GitHub network allowlist (public-repo control) and an allowed-domain control. | Temporary directories `/tmp/wm-sandbox-spike.*`, `/tmp/wm-sandbox-spike.*-wt`, `/tmp/wm-kit.*` (**left in place** so the results can be read; delete them afterwards). A canary `~/.config/wingmate/credentials.json` **only if absent** (removed again on exit; an existing file makes the script refuse to run). One `claude -p` run (≈ $1). |
| 4 | `bash spikes/codex-flags-spike.sh` | Which Codex flags each form accepts (`--sandbox`, `--ask-for-approval`, `-c …`; `codex exec` rejects `--ask-for-approval`, so the runs use `-c approval_policy=never`), whether the sandbox blocks reads outside the worktree, whether `network_access=false` / read-only block outbound TCP, whether `project_doc_max_bytes=0` keeps an `AGENTS.md` codeword from the model. | `/tmp/wm-codex-spike.*` (left in place), the same canary rule as above. Two `codex exec` runs. |

If the launch spike is interrupted, remove the scratch worktree by hand: `orca worktree ps --json` (look for
`wm-spike-*`), then `orca terminal close --worktree id:<id> --all` and `orca worktree rm --worktree id:<id> --force`.

## Fixtures and scrubbing

The raw Orca envelopes contain free text from unrelated projects (prompts, assistant messages, an e-mail address).
Both TypeScript spikes scrub every envelope before writing it, so raw content never enters git history:

- strings that look like credentials (`sk-ant-`, `ghp_`, `github_pat_`, `xox[abp]-`, JWT/base64 cursors) → `REDACTED`;
- keys whose *name* looks credential-like (`token`, `secret`, `password`, `bearer`, `api key`) with a non-string value are
  dropped, with a string value they are set to `REDACTED`; `providerAccountId` → `REDACTED`;
- e-mail addresses → `user@example.invalid`;
- free-text fields (`prompt`, `lastAssistantMessage`, `preview`, `description`, `body`, `toolInput`, `comment`,
  `title`, `taskTitle`, `command`) are kept (cut to 80 characters plus `…`) only for this repository's own rows and
  are `REDACTED` everywhere else, and `REDACTED` if they mention a credential word;
- long lists are sampled (`orca-vocab-capture.ts`) or filtered to the scratch worktree (`orca-launch-spike.ts`).

Every fixture is the full envelope `{ id, ok, result, _meta }`; consumers read `.result`. Before committing,
`grep -rniE 'token|secret|password|bearer|sk-ant|ghp_|api[_-]?key' tests/fixtures/orca/` must print nothing.
Task 2's `scripts/scrub-fixtures.ts` is the canonical scrubber for later fixtures; it is idempotent over these files.

## Not covered here (defaults recorded in the results file)

The Linear-app items of §16.1 (actor, label groups, mentions, `client_credentials`, notification test) need the owner's
OAuth app and are verified by Task 12's `doctor`. The automation-precheck timing item needs a created automation and
is verified there too. The `spawn` item (`run-create` from a terminal coordinator, `worker-start` at depth 1) needs a
coordinator turn, an orchestration Run and a worker, and is not exercised by any spike here.
