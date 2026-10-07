# Linear setup for Wingmate

This is a one-time setup for the owner (a Linear workspace admin), done in the order of spec §15.2. When it is finished,
Wingmate reads and writes Linear as its own OAuth application, "Wingmate". It never acts as you. Day-to-day operation
is in [runbook.md](runbook.md).

**Before you start**

- Orca is running, Bun 1.3.9 or later is installed, and `gh auth status` shows you logged in.
- You run every command from a checkout of this repository. That is where `config/projects.yaml` is, and `install`
  asks Orca which repository that checkout belongs to.
- `main` on GitHub holds the version you want to run. `install` builds the dispatcher from the `wingmate-dispatcher`
  worktree, which it creates from `origin/main` the first time.
- Until the first `install`, `wingmate` is not on your PATH. Use `bun bin/wingmate.ts <command>` instead. After it,
  `~/.local/bin/wingmate` exists; add `~/.local/bin` to your PATH if it is not there.

**Secrets rule.** The client secret and any API key travel from Linear's page through your clipboard to a command's
stdin, or to a file with mode 0600. Never put them on a command line (`ps` and the shell history show it). Never paste
them into a chat, including a chat with an agent. Never put them in the repository or in an `.env` file.

Linear's settings pages move. The menu names below were current on 2026-10-06. The client-credentials screens have not
been checked against a live app yet (spike results §1 row 6). In the end, `wingmate doctor` is the check that counts.

## 1. Create the OAuth application

As a workspace admin, go to Linear → Settings → API → OAuth applications → New:

- Name: `Wingmate`. Add an icon if you like.
- Callback URL: `http://127.0.0.1/unused`. Client credentials never redirect, but the form requires a URL.
- Turn **Client credentials** on and leave **Public** off.
- Scopes: `read`, `write`, `comments:create`, `issues:create`. These are exactly the scopes Wingmate asks for when it
  mints its token. If the form offers scope choices, select these four and no others.

Keep the page open. Step 2 needs the client id and the client secret.

## 2. Give the client id and secret to `wingmate install`

Copy the client secret in Linear, then run this in a checkout of this repository (`bun bin/wingmate.ts install …` the
first time):

```sh
pbpaste | wingmate install --client-id <client id> --client-secret -
pbcopy </dev/null    # clear the clipboard
```

`--client-secret -` reads the secret from the first line of stdin, so it is never on the command line. You can also
leave out the pipe and paste the secret into the waiting command, then press Enter. No prompt is printed, and the pasted
text shows on screen, but it is not stored in `ps` or in the shell history. If you type the secret itself after
`--client-secret`, install still works but prints a warning that the secret is visible in `ps` and the shell history.

`install` does the following:

- It stores the id and secret in `~/.config/wingmate/credentials.json` (mode 0600, in a 0700 directory). It caches the
  app's 30-day token there and mints a new one when fewer than 24 hours remain, or after a 401.
- It creates the `wingmate-dispatcher` worktree, or reuses it.
- It builds `~/.local/share/wingmate/bin/wingmate-<version>` and points `~/.local/bin/wingmate` at it.
- It writes the Orca automation `wingmate-dispatcher` **disabled**.
- It creates the two saved views as the app and prints their URLs (step 6).

While the automation is disabled, its output ends with the line "next: `wingmate doctor`, then
`wingmate install --enable`".

## 3. Create the labels in team JRF

Go to Linear → Settings → Teams → JRF → Labels. Spell every name exactly as below: `doctor` and `config/projects.yaml`
compare names.

| Create | Labels | What they mean to Wingmate |
|---|---|---|
| Group `Agent` (single-select) | `agent-ready`, `claude`, `codex`, `human` | `agent-ready` and `claude` queue an issue for a Claude coordinator. `codex` is skipped as `provider_unavailable`: the pilot's coordinator cascade is Claude only. `human` means never claim; added to an active issue, it releases the issue. |
| Group `Lifecycle` (single-select) | `Ready`, `In-Agent`, `Needs-Human`, `Review-Ready`, `Blocked` | Wingmate sets `In-Agent`, `Needs-Human`, `Review-Ready` and `Blocked`. `Ready` is yours: Wingmate restores it when it releases an issue that had it at claim. |
| Plain label (no group) | `allow-deps` | Lets the agent add or upgrade dependencies, when an approver added it before the claim or while the issue waited on a question. |

Only an approver (`workspace.approvers` in `config/projects.yaml`) can queue an issue. If anyone else added the Agent
label, the issue is skipped as `label_by_unlisted_actor`. Other labels in the Agent group (`gemini`, `manus`, `tunip`,
`tweak`) are skipped as `unsupported_provider`.

## 4. Confirm the workflow states

Under Linear → Settings → Teams → JRF → Workflow, these states must exist with these exact names:

- **Todo**, of the unstarted type. Wingmate picks issues up from here.
- **In Progress**. A claim moves the issue here.
- **In Review**. A finished issue with its PR moves here.

Wingmate never sets Done or Canceled.

## 5. Run `wingmate doctor`

```sh
wingmate doctor
```

The full doctor makes a scratch `wm-doctor-<id>` worktree of this repository. In it, it runs one sandboxed `claude -p`
probe, which cost about $0.75 in the 2026-10-06 spike, and then removes the worktree. `wingmate doctor --quick` skips
the probe.

At this point, expect `ok` on every line except these:

- `notify_test` stays FAIL until step 8.
- `heartbeat_fresh` warns, because no tick has run yet.
- `claude_trust` warns for any pilot repository whose main checkout Claude has not trusted yet. To fix it, run `claude`
  once in that checkout, choose "Yes, I trust this folder", then exit.

If another check fails:

- `linear_auth`: the app or its secret is wrong. Redo steps 1 and 2.
- `linear_meta`: the detail names the missing labels or states (steps 3 and 4).
- Anything else: see [runbook.md](runbook.md), Incidents.

## 6. Finish the two saved views

`install` printed two URLs: **Wingmate** and **Wingmate · Needs you**. Both are shared views in team JRF, owned by
you. Linear's API sets only their filters, so set the display by hand:

| View | Layout | Grouping | Ordering |
|---|---|---|---|
| Wingmate | Board | the `Lifecycle` label group | Priority |
| Wingmate · Needs you | List | Label | Last updated |

Then:

- Favorite both views.
- Open **Wingmate · Needs you** and subscribe to it, so you are notified whenever an issue is added to the view.

Install may instead print `saved views not written (<code>)` or `saved views need the OAuth app`. In that case, create
the views by hand from the recipe it printed, or re-run `install` after fixing the cause. `install` updates existing
views; it never duplicates them.

## 7. Turn on notifications

Go to Linear → Settings → Notifications and turn on Slack, mobile push, or both, for comments and mentions. This is
how Wingmate reaches you:

- It subscribes you to every issue it claims, so you are notified of every new comment.
- Question comments @mention you. The mention markup is unverified, so the subscription is what reliably reaches you.
- Every block posts a new comment. Label changes and edits to the status comment do not notify anyone.

## 8. Run the notification test

Pick a scratch issue that is open, in a pilot project, and not one Wingmate works on.

```sh
wingmate doctor --notify-test JRF-<n>
```

The test posts a question on that issue as the app, mentioning you, and sets `Needs-Human`. That puts the issue into
"Wingmate · Needs you". Wait for both notifications:

- (a) the comment or mention notification;
- (b) the view notification, for an issue added to the view.

Once both have arrived, record it:

```sh
wingmate doctor --confirm-notify
```

Then tidy the scratch issue: remove `Needs-Human` and close it. If a notification does not arrive, see
[runbook.md](runbook.md), Incidents.

## 9. Enable the automation

```sh
wingmate install --enable
```

This rebuilds and re-points everything, as step 2 did, then runs the full doctor. It enables the automation only when
every blocking check passes, including the confirmed notification test. Otherwise it exits 1 with
`doctor_failed: blocking checks failed (…); the automation stays disabled`.

Once enabled, a tick runs every 5 minutes. Note that a plain `wingmate install` without `--enable` always writes the
automation disabled again.

## Rotating the credentials (compromise response, §13.3 g)

Rotate when a credential may have leaked, or when an issue was blocked `kit_tampered` and you cannot rule out an
escape.

1. Run `wingmate stop --all`. Alternatively, run `wingmate doctor --rotate`, which does the same `stop --all`, drops
   the cached app token and prints these steps.
2. In Linear, go to Settings → API → OAuth applications → Wingmate and rotate the client secret. Every app token dies
   with the old secret.
3. Copy the new secret, then run
   `pbpaste | wingmate install --client-id <client id> --client-secret -` and `pbcopy </dev/null`.
4. On GitHub, run `gh auth refresh`. Alternatively, revoke the token at github.com/settings/tokens and run
   `gh auth login`.
5. Inspect the worktrees named in the blocked comments, run `wingmate doctor`, then `wingmate install --enable`
   (step 3 left the automation disabled). Re-queue issues by moving them back to Todo (see the runbook).

## A personal key for read-only dry runs (before the OAuth app)

Before the app exists you can still let `wingmate scan` and `wingmate tick --dry-run` read the live queues as you.
This is the slice-1 acceptance check (§15.1). Those two commands build a read-only context, which refuses every
write.

The personal key is used only when `~/.config/wingmate/credentials.json` does not exist:

- `wingmate tick`, and the automation, refuse with `linear_app_required`.
- `doctor`, `install` and `stop` never use the personal key.
- Once the app is installed, the key is ignored.

To set it up:

1. In Linear, go to Settings → Security & access → Personal API keys and create a key. Read access is enough; if
   Linear offers to limit it, limit it to read and to team JRF. Copy it.
2. Store it from your own terminal (not through an agent):

   ```sh
   mkdir -p ~/.config/wingmate && chmod 700 ~/.config/wingmate
   (umask 077; pbpaste > ~/.config/wingmate/linear-token)
   chmod 600 ~/.config/wingmate/linear-token
   pbcopy </dev/null
   ```

   The file must be a regular file (not a symlink), owned by you, with mode exactly 0600. Anything else is refused.
3. Run the read-only commands from a checkout of this repository:

   ```sh
   wingmate scan --json            # exit 0: a tick would act, 1: idle, 2: error
   wingmate tick --dry-run --json  # also writes ~/.local/share/wingmate/queue.dryrun.json
   ```

`WINGMATE_LINEAR_TOKEN` takes precedence over the file. To set it without typing the key on a command line, run
`read -rs WINGMATE_LINEAR_TOKEN && export WINGMATE_LINEAR_TOKEN` and paste the key at the silent prompt. Run
`unset WINGMATE_LINEAR_TOKEN` when you are done.

When these commands fail, their JSON names the cause in `reason`. A failure while building prints only
`{"outcome":"error","reason":"<code>"}`; a failed Linear read during the tick prints `"outcome":"linear_error"`.

| Reason | Meaning |
|---|---|
| `linear_credentials_missing` | No `credentials.json`, no variable and no `linear-token` file. |
| `linear_token_file_mode` | `linear-token` is not a regular file of yours with mode 0600. Fix with `chmod 600`, or recreate it as above. |
| `linear_token_invalid` | The file or variable does not hold exactly one token: printable ASCII, no spaces, at most 4,096 characters. |
| `linear_http` | Linear refused the key, for example with a 401: it was revoked or mistyped. Create a new key. |

After the OAuth app is installed, delete `~/.config/wingmate/linear-token` and revoke the personal key in Linear.
