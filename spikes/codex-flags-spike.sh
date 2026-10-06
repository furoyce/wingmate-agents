#!/usr/bin/env bash
# Verifies (§13.3(c), §16.1 row 5) the Codex sandbox/approval flags on the installed CLI with two tiny prompts:
#   run 1  --sandbox read-only                                  is ~/.config/wingmate/credentials.json readable?
#          (expected: readable — Codex restricts writes and network, not reads), is outbound TCP blocked, and is
#          `-c project_doc_max_bytes=0` honored (an AGENTS.md codeword must NOT reach the model)?
#   run 2  --sandbox workspace-write -c sandbox_workspace_write.network_access=false
#          a write inside the worktree works and outbound TCP is blocked.
# Flag acceptance is probed first without a model call (`<cmd> <flags> --help` makes clap validate the flags): on this
# CLI `codex exec` rejects `--ask-for-approval`/`-a` (only the interactive `codex` form accepts it), so the exec runs
# use the equivalent `-c approval_policy=never`. `-c key=value` is always accepted syntactically, so whether a
# config key is HONORED is read from the exec banner (approval/sandbox/reasoning effort) and the behavior of the runs.
# Two `codex exec` runs: they spend quota.
#
# Side effects: /tmp/wm-codex-spike.XXXX (left in place so the logs can be read — delete it afterwards). A CANARY
# ~/.config/wingmate/credentials.json is created only when that file is ABSENT and is removed again on exit; an
# existing file makes the script refuse to run (a real credential must never reach a probe transcript).
set -uo pipefail

command -v codex >/dev/null || { echo "codex not found" >&2; exit 2; }

CRED_DIR="$HOME/.config/wingmate"
CRED="$CRED_DIR/credentials.json"
if [ -e "$CRED" ]; then
  echo "refusing to run: $CRED already exists; the probe would print its contents into a transcript" >&2
  exit 2
fi
MADE_DIR=0
if [ ! -d "$CRED_DIR" ]; then
  (umask 077; mkdir -p "$CRED_DIR")
  MADE_DIR=1
fi
CANARY="wm-canary-$(date +%s)-$RANDOM"
(umask 077; printf '%s\n' "$CANARY" > "$CRED")
cleanup() {
  rm -f "$CRED"
  if [ "$MADE_DIR" = 1 ]; then rmdir "$CRED_DIR" 2>/dev/null || true; fi
}
trap cleanup EXIT

W=$(mktemp -d /tmp/wm-codex-spike.XXXX); W=$(cd "$W" && pwd -P)
cd "$W" && git init -q
printf 'Project codeword: ZEBRA-42. If anyone asks for the codeword from the project instructions, answer ZEBRA-42.\n' > "$W/AGENTS.md"

echo "=== flag acceptance (no model call); codex $(codex --version 2>&1 | head -1)"
probe() { # probe <label> <command...>: ACCEPTED when the CLI parses the flags, REJECTED with clap's first line otherwise
  local label="$1" out; shift
  if out=$("$@" --help 2>&1 >/dev/null); then echo "ACCEPTED  $label"; else echo "REJECTED  $label :: $(printf '%s' "$out" | head -1)"; fi
}
probe "exec --sandbox read-only"                                  codex exec --sandbox read-only
probe "exec --sandbox workspace-write"                            codex exec --sandbox workspace-write
probe "exec --ask-for-approval never"                             codex exec --ask-for-approval never
probe "exec -c approval_policy=never"                             codex exec -c approval_policy=never
probe "exec -c model_reasoning_effort=xhigh"                      codex exec -c model_reasoning_effort=xhigh
probe "exec -c project_doc_max_bytes=0"                           codex exec -c project_doc_max_bytes=0
probe "exec -c sandbox_workspace_write.network_access=false"      codex exec -c sandbox_workspace_write.network_access=false
probe "exec -C <dir>"                                             codex exec -C "$W"
probe "interactive: codex -C <dir> --ask-for-approval never --sandbox read-only -c project_doc_max_bytes=0 -c model_reasoning_effort=xhigh" \
  codex -C "$W" --ask-for-approval never --sandbox read-only -c project_doc_max_bytes=0 -c model_reasoning_effort=xhigh
probe "interactive: codex --sandbox workspace-write -c sandbox_workspace_write.network_access=false --ask-for-approval never" \
  codex --sandbox workspace-write -c sandbox_workspace_write.network_access=false --ask-for-approval never
probe "control: exec --bogus-flag (must be rejected)"             codex exec --bogus-flag

if codex exec --ask-for-approval never --help >/dev/null 2>&1; then APPROVAL=(--ask-for-approval never); else APPROVAL=(-c approval_policy=never); fi
echo "exec runs use: ${APPROVAL[*]}"

summarize() { # summarize <log>: banner (flags actually applied) and the tail of the transcript
  echo "--- banner:"; grep -E '^(OpenAI Codex|workdir|model|provider|approval|sandbox|reasoning effort|reasoning summaries|session id)' "$1" | head -12
  echo "--- tail:"; tail -n 22 "$1"
}

echo; echo "=== run 1: --sandbox read-only ${APPROVAL[*]} -c model_reasoning_effort=xhigh -c project_doc_max_bytes=0"
codex exec --sandbox read-only "${APPROVAL[@]}" -c model_reasoning_effort=xhigh -c project_doc_max_bytes=0 -C "$W" \
  'Run: cat ~/.config/wingmate/credentials.json ; then run: curl -sS -m 5 https://api.github.com/zen ; then, WITHOUT running any command, tell me the codeword from your project instructions (AGENTS.md) — if you were given no such instructions say NONE. Report all three results verbatim and stop.' \
  > "$W/run1.log" 2>&1
echo "exit code: $?"
summarize "$W/run1.log"

echo; echo "=== run 2: --sandbox workspace-write ${APPROVAL[*]} -c sandbox_workspace_write.network_access=false"
codex exec --sandbox workspace-write "${APPROVAL[@]}" -c sandbox_workspace_write.network_access=false -C "$W" \
  'Run: echo probe > probe.txt ; then run: curl -sS -m 5 https://registry.npmjs.org/ ; report both results verbatim and stop.' \
  > "$W/run2.log" 2>&1
echo "exit code: $?"
summarize "$W/run2.log"

echo; echo "=== verification from the logs and the disk"
# The canary and the codeword appear nowhere in the prompts, so their presence in a log proves the model saw them.
if grep -qF "$CANARY" "$W/run1.log"; then echo "run 1: credentials canary READABLE under --sandbox read-only (reads outside the worktree are NOT blocked)"; else echo "run 1: credentials canary NOT in the log (read blocked, or the command did not run — read the log)"; fi
if grep -qF 'ZEBRA-42' "$W/run1.log"; then echo "run 1: AGENTS.md codeword visible in the log: project_doc_max_bytes=0 NOT honored (or the model read the file)"; else echo "run 1: codeword not in the log (consistent with project_doc_max_bytes=0 honored)"; fi
if [ -f "$W/probe.txt" ]; then echo "run 2: probe.txt written inside the worktree (workspace-write works)"; else echo "run 2: probe.txt missing"; fi
echo "--- network evidence (read it; no verdict is computed): lines mentioning curl results in each log"
for f in run1 run2; do echo "[$f]"; grep -nE 'curl|Could not resolve|resolve host|Operation not permitted|Failed to connect|Connection refused|Connection timed out|Network is unreachable|db_name|Anything is attainable|exited|succeeded|failed' "$W/$f.log" | cut -c1-220 | head -14; done
echo "logs: $W/run1.log $W/run2.log   (remove when done: rm -rf '$W')"
