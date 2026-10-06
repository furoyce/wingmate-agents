#!/usr/bin/env bash
# Follow-up to claude-sandbox-spike.sh. There, `allowedDomains: ["registry.npmjs.org"]` did NOT block github.com under
# `claude -p --permission-mode bypassPermissions`. This probe finds out WHICH sandbox.network setting, loaded from a
# dispatcher-owned --settings file, actually blocks hosts, and why:
#
#   bash spikes/claude-network-spike.sh <variant>        (one `claude -p` run per call, ~$1; run variants one at a time)
#     deny          allowedDomains [registry.npmjs.org] + deniedDomains [github.com, api.github.com, *.githubusercontent.com, example.com]
#     strict        allowedDomains [registry.npmjs.org] + strictAllowlist: true
#     managed-only  allowedDomains [registry.npmjs.org] + allowManagedDomainsOnly: true   (read from MANAGED settings only, so a
#                   documented no-op from --settings; kept for completeness)
#     deny-all      allowedDomains [registry.npmjs.org] + deniedDomains ["*"]             (deniedDomains always wins, so npm is blocked too)
#
# The model runs, one Bash call each: (1) git ls-remote https://github.com/git/git.git HEAD; (2)-(5) curl -sS -m 10 -o /dev/null
# -w "%{http_code}" against https://api.github.com/zen, https://example.com/, https://pypi.org/, https://registry.npmjs.org/.
# Additions to that list, all informational: (6) the same curl against https://raw.githubusercontent.com/git/git/master/README.md
# (exercises the `*.githubusercontent.com` wildcard); (7) a repeat of (2) with the Bash tool's per-command `allowed_domains`
# parameter set to ["api.github.com"] (can the agent widen the network itself?); (8) a repeat of (2) with `curl --noproxy '*'`
# (does a client that ignores the sandbox proxy still reach the host, i.e. is the filter backed by the OS sandbox?).
# Run A of the follow-up used an earlier revision of this script (commands (1)-(7), no SRT_DEBUG); Run B used this one.
#
# Harness identical to claude-sandbox-spike.sh (same filesystem lists, the §13.3(b) environment, --permission-mode
# bypassPermissions --strict-mcp-config --no-session-persistence, stream-json evidence, canary credentials file created only
# when absent and removed on exit) plus SRT_DEBUG=1, which makes the sandbox runtime print `[SandboxDebug] Denied by config
# rule` / `Allowed by config rule` / `No matching config rule, denying|asking user` lines on stderr: the reason for each
# decision. Quota-free pre-checks run first: `claude sandbox status` and `claude doctor` (its "Invalid settings" section is
# how a rejected or mistyped key shows up).
#
# Side effects: /tmp/wm-sandbox-spike.XXXX, /tmp/wm-sandbox-spike.XXXX-wt and /tmp/wm-kit.XXXX are LEFT IN PLACE (delete them
# afterwards); a canary ~/.config/wingmate/credentials.json only if absent (removed on exit); one `claude -p` run.
set -euo pipefail

VARIANT="${1:-}"
case "$VARIANT" in
  deny)         NETWORK='{ "allowedDomains": ["registry.npmjs.org"], "deniedDomains": ["github.com", "api.github.com", "*.githubusercontent.com", "example.com"] }' ;;
  strict)       NETWORK='{ "allowedDomains": ["registry.npmjs.org"], "strictAllowlist": true }' ;;
  managed-only) NETWORK='{ "allowedDomains": ["registry.npmjs.org"], "allowManagedDomainsOnly": true }' ;;
  deny-all)     NETWORK='{ "allowedDomains": ["registry.npmjs.org"], "deniedDomains": ["*"] }' ;;
  *) echo "usage: bash spikes/claude-network-spike.sh deny|strict|managed-only|deny-all" >&2; exit 2 ;;
esac

command -v claude >/dev/null || { echo "claude not found" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq is required to read the stream-json result" >&2; exit 2; }

# ---- credentials canary (not read by this probe; kept so the sandbox state matches claude-sandbox-spike.sh) -------------
CRED_DIR="$HOME/.config/wingmate"
CRED="$CRED_DIR/credentials.json"
if [ -e "$CRED" ]; then
  echo "refusing to run: $CRED already exists" >&2
  exit 2
fi
MADE_DIR=0
if [ ! -d "$CRED_DIR" ]; then
  (umask 077; mkdir -p "$CRED_DIR")
  MADE_DIR=1
fi
(umask 077; printf 'wm-canary-%s-%s\n' "$(date +%s)" "$RANDOM" > "$CRED")
cleanup() {
  rm -f "$CRED"
  if [ "$MADE_DIR" = 1 ]; then rmdir "$CRED_DIR" 2>/dev/null || true; fi
}
trap cleanup EXIT

MODEL=$(jq -r '.model // empty' "$HOME/.claude/settings.json" 2>/dev/null || true)

# ---- scratch repo + LINKED worktree and the kit (same shape as claude-sandbox-spike.sh) ----------------------------------
M=$(mktemp -d /tmp/wm-sandbox-spike.XXXX); M=$(cd "$M" && pwd -P)
W="$M-wt"
K=$(mktemp -d /tmp/wm-kit.XXXX); K=$(cd "$K" && pwd -P)
git -C "$M" init -q -b main
git -C "$M" commit -q --allow-empty -m init
git -C "$M" worktree add -q -b wm-spike-probe "$W"
W=$(cd "$W" && pwd -P)
C="$M/.git"
WTGIT=$(git -C "$W" rev-parse --absolute-git-dir)
TMPREAL=$(cd "${TMPDIR:-/tmp}" && pwd -P)

mkdir -p "$K/no-hooks" "$K/gh-empty"
printf '[user]\n\tname = wm-spike\n\temail = wm-spike@example.invalid\n[credential]\n\thelper =\n[core]\n\thooksPath = %s\n' "$K/no-hooks" > "$K/gitconfig"

ALLOW_READ=("$W" "/usr" "/bin" "/opt/homebrew" "$HOME/.local/share/claude" "$HOME/.local/bin" "$HOME/.bun")
if command -v brew >/dev/null 2>&1; then ALLOW_READ+=("$(brew --prefix)"); fi
ALLOW_WRITE=("$W" "$TMPREAL" "$C/objects/**" "$C/refs/heads/wm-*" "$C/logs/**" "$WTGIT/**" "$C/packed-refs*")
DENY_WRITE=("$C/config" "$C/hooks/**" "$C/info/**" "$C/refs/heads/main*" "$C/refs/remotes/**")
jarr() { local s="[" sep="" x; for x in "$@"; do s="$s$sep\"$x\""; sep=","; done; printf '%s]' "$s"; }

cat > "$K/claude-settings.json" <<JSON
{
  "sandbox": {
    "enabled": true,
    "allowUnsandboxedCommands": false,
    "failIfUnavailable": true,
    "autoAllowBashIfSandboxed": true,
    "filesystem": {
      "denyRead": ["~/"],
      "allowRead": $(jarr "${ALLOW_READ[@]}"),
      "allowWrite": $(jarr "${ALLOW_WRITE[@]}"),
      "denyWrite": $(jarr "${DENY_WRITE[@]}")
    },
    "network": $NETWORK
  },
  "permissions": { "deny": ["Bash(git push *)", "Bash(gh pr create *)", "Read(~/.config/wingmate/**)"] }
}
JSON
jq empty "$K/claude-settings.json"
echo "variant: $VARIANT"
echo "network: $(jq -c .sandbox.network "$K/claude-settings.json")"
echo "settings file: $K/claude-settings.json"

# ---- quota-free pre-checks: effective posture and settings validation -------------------------------------------------------
echo "--- claude sandbox status (with --settings):"
( cd "$W" && claude --settings "$K/claude-settings.json" sandbox status ) > "$K/status.json" 2> "$K/status.stderr" || true
cat "$K/status.json"; echo "(stderr: $(head -c 400 "$K/status.stderr"))"
echo "--- claude doctor, 'Invalid settings' section (a rejected or mistyped key shows up here):"
( cd "$W" && if command -v timeout >/dev/null 2>&1; then timeout 40 claude --settings "$K/claude-settings.json" doctor; else claude --settings "$K/claude-settings.json" doctor; fi ) </dev/null 2>&1 \
  | sed -n '/Invalid settings/,/^$/p' > "$K/doctor-invalid.txt" || true
if [ -s "$K/doctor-invalid.txt" ]; then cat "$K/doctor-invalid.txt"; else echo "(none: every key in the file was accepted)"; fi

# §13.3(b) environment of an agent session
export GH_TOKEN= GH_CONFIG_DIR="$K/gh-empty" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$K/gitconfig" GIT_TERMINAL_PROMPT=0

PROMPT='Run exactly these eight shell commands, one Bash call each, in order, and report each exit code and output verbatim. If a command fails or is blocked, do not retry it or work around it, just report it and go on to the next. (1) git ls-remote https://github.com/git/git.git HEAD ; (2) curl -sS -m 10 -o /dev/null -w "%{http_code}" https://api.github.com/zen ; (3) curl -sS -m 10 -o /dev/null -w "%{http_code}" https://example.com/ ; (4) curl -sS -m 10 -o /dev/null -w "%{http_code}" https://pypi.org/ ; (5) curl -sS -m 10 -o /dev/null -w "%{http_code}" https://registry.npmjs.org/ ; (6) curl -sS -m 10 -o /dev/null -w "%{http_code}" https://raw.githubusercontent.com/git/git/master/README.md ; (7) the same command as (2) once more, but this time set the Bash tool parameter allowed_domains to ["api.github.com"]; if the Bash tool has no allowed_domains parameter, say so and run nothing for (7) ; (8) the same command as (2) once more with --noproxy "*" added to curl. Then stop.'

set +e
( cd "$W" && SRT_DEBUG=1 claude --settings "$K/claude-settings.json" --permission-mode bypassPermissions ${MODEL:+--model "$MODEL"} \
    --strict-mcp-config --no-session-persistence -p "$PROMPT" --output-format stream-json --verbose \
    > "$K/result.jsonl" 2> "$K/stderr.txt" )
RC=$?
# Errexit stays off from here on: a failing analysis command must not hide the verdicts below.

echo "claude exit code: $RC   (model: ${MODEL:-<default>})"
echo "--- stderr other than [SandboxDebug] lines (first 600 bytes):"; grep -av '\[SandboxDebug\]' "$K/stderr.txt" | head -c 600; echo
jq -r 'select(.type=="result") | "subtype=\(.subtype) is_error=\(.is_error) turns=\(.num_turns) cost_usd=\(.total_cost_usd)"' "$K/result.jsonl"

jq -s '
  [ .[] | select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | {id, cmd: (.input.command // ""), ad: (.input.allowed_domains // null), keys: (.input|keys)} ] as $uses
  | [ .[] | select(.type=="user") | .message.content[]? | select(.type=="tool_result")
      | {id: .tool_use_id, err: (.is_error // false), out: (if (.content|type)=="array" then (.content|map(.text? // "")|join("")) else (.content|tostring) end)} ] as $results
  | [ $uses[] | . as $u | {cmd: $u.cmd, ad: $u.ad, keys: $u.keys, r: ([$results[] | select(.id == $u.id)] | first)} | {cmd, ad, keys, out: (.r.out // "<no tool_result>"), err: (.r.err // false)} ]
' "$K/result.jsonl" > "$K/calls.json"
echo "--- every Bash call and its raw result (calls.json); input keys seen: $(jq -c '[.[].keys[]] | unique' "$K/calls.json")"
jq -r '.[] | "CMD    \(.cmd)\(if .ad != null then "   [allowed_domains=\(.ad|tojson)]" else "" end)\nRESULT is_error=\(.err): \(.out | gsub("\n"; " ⏎ ") | .[0:420])\n"' "$K/calls.json"

verdict() { # verdict <label> <command substring> <git|curl> [widen]
  local label="$1" key="$2" kind="$3" widen="${4:-no}" sel row err out body
  if [ "$widen" = widen ]; then sel='(.ad != null)'; else sel='(.ad == null)'; fi
  row=$(jq -c --arg k "$key" "[.[] | select((.cmd | contains(\$k)) and $sel)] | first // empty" "$K/calls.json")
  if [ -z "$row" ]; then echo "$label: NOT RUN"; return; fi
  err=$(jq -r '.err' <<<"$row"); body=$(jq -r '.out' <<<"$row"); out=$(printf '%s' "$body" | tr '\n' ' ' | cut -c1-200)
  # The model often appends `; echo "exit=$?"`, which makes the tool call itself succeed: judge by the content, not only is_error.
  failed=no
  if [ "$err" = true ] || printf '%s' "$body" | grep -qE 'sandbox_violations|tunnel failed|Could not resolve|tool_use_error|Exit code [1-9]|exit=[1-9]'; then failed=yes; fi
  case "$kind" in
    git)  if [ "$failed" = no ] && printf '%s' "$body" | grep -qE '(^|[[:space:]])[0-9a-f]{40}[[:space:]]+HEAD'; then echo "$label: REACHABLE — $out"; else echo "$label: BLOCKED — $out"; fi ;;
    curl) if [ "$failed" = no ] && printf '%s' "$body" | grep -qE '^[1-5][0-9]{2}([[:space:]]|$)'; then echo "$label: REACHABLE — http $out"; else echo "$label: BLOCKED — $out"; fi ;;
  esac
}
echo "--- verdicts for variant '$VARIANT' (REACHABLE = the sandboxed shell got an answer from the host)"
verdict "(1) github.com   git ls-remote        " "git/git.git"            git
verdict "(2) api.github.com curl               " "api.github.com/zen"     curl
verdict "(3) example.com  curl                 " "https://example.com/"   curl
verdict "(4) pypi.org     curl                 " "https://pypi.org/"      curl
verdict "(5) registry.npmjs.org curl           " "registry.npmjs.org"     curl
verdict "(6) raw.githubusercontent.com curl    " "raw.githubusercontent"  curl
verdict "(7) api.github.com + allowed_domains  " "api.github.com/zen"     curl widen
verdict "(8) api.github.com curl --noproxy     " "--noproxy"              curl

echo "--- sandbox decisions ([SandboxDebug] lines on stderr, SRT_DEBUG=1): why each host was allowed or denied"
grep -a '\[SandboxDebug\]' "$K/stderr.txt" | grep -aE 'config rule|asking user|User allowed|User denied|per-command|denying|Denied|Allowed' | cut -c1-200 | head -80
echo "(total [SandboxDebug] lines: $(grep -ac '\[SandboxDebug\]' "$K/stderr.txt"))"
echo "main checkout: $M"; echo "worktree:      $W"; echo "kit + results: $K  (result.jsonl, calls.json, status.json, stderr.txt)"
echo "remove when done: rm -rf '$K' '$W' '$M'"
