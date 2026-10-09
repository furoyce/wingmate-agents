# Safe workspace cleanup

`wingmate cleanup` requires one explicit scope:

```sh
wingmate cleanup --issue JRF-501 --dry-run --json
wingmate cleanup --project bouncr --dry-run --orphaned
wingmate cleanup --all
```

The dispatcher and CLI use the same planner. Normal cleanup honors
`defaults.cleanup.worktreeGraceHours` (24 by default). `--force` overrides only
that grace period. It does not override lifecycle, daily failure backoff,
ownership, PR, content, assignment, process, stop, or lock checks.

Only `done` and `cancelled` records are candidates. A protected claim journal
receipt must show that Wingmate created the exact worktree in this cycle;
a record that adopted an existing workspace cannot authorize deletion.
Released, archived, and shared workspace references remain retained.

Removal requires complete fleet evidence, matching repository/worktree/path/
branch identity and pinned Git links, no open PR (both recorded PRs and a fresh
branch query), and clean source/index with no untracked source files. Root
`.wingmate` bookkeeping and Git-ignored files follow the existing kit/source
boundary. HEAD must equal or be an ancestor of the configured remote base tip;
missing local history defers cleanup without fetching. Squash/rebase merges
whose ancestry cannot prove preservation are conservatively retained.

Outstanding journal work, attempts, questions, role jobs, native leases,
children, terminals, or processes block removal. Cleanup does not bulk-close
terminals, stop workers, abandon dispatches, or kill processes. Existing stop
receipts and `sweep.killed` are insufficient termination evidence. A failed,
truncated, timed-out, malformed, or permission-limited process inventory is
unknown. Process paths can veto removal but never authorize signalling.
Older Orca adapters lacking explicit complete inventory metadata also defer.

`--orphaned` requests inspection within the chosen project repositories (and
linked issue identity for issue scope). It is never implicit, including with
`--all`. Untracked workspaces are reported `retained / ownership_unverified`;
a `wm-*` name grants no ownership. Archived references remain retained findings.
No orphan deletion or recursive child deletion is implemented.

Dry runs use the same read-only eligibility path, without creating records,
locks, logs, credentials, or evidence. They do not refresh Linear credentials
or access Linear. A preview reports eligibility, not a confirmed future effect.
Live commands share the dispatcher's tick lock, verify its token before effects,
check stop/deadline fences, and re-read canonical ownership/retention records
before removal. An external owner can still change filesystem or host state
between observations; a general resource lease/generation registry is deferred.

Before removal, the ledger retains the complete worktree identity, cycle and
content evidence. After removal, a fresh complete fleet read **and** filesystem
absence must confirm the effect before the active workspace reference is cleared.
A failed or lost reply retains the reference; after daily backoff, proven absence
settles the effect without another remove call. Historical identity and evidence
remain in the ledger even after the active reference is cleared.

JSON and text output distinguish `eligible`, `removed`, `deferred`, and
`retained`, with reasons. Exit 2 indicates incomplete inventory or a safety/effect
deferral; ordinary grace/backoff and retained inspection findings exit 0.
Malformed configuration or local evidence also fails before removal.

Immediate-on-merge is deliberately unsupported: the current cleanup adapter
cannot correlate all required PR heads and merge targets. Unknown cleanup config
keys (including `immediateOnMerge`) are rejected instead of silently enabling or
ignoring such a policy. A future implementation must be opt-in, merged-only,
exact-head scoped and subject to every other predicate above.
