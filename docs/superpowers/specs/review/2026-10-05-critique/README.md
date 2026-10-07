# Critique of the 2026-10-05 design spec — status and next steps

Source: five-lens critique workflow (consistency, Orca feasibility, security, product/UX, plan-readiness),
deduped, each blocker/major argued by two adversarial refuters. Result: **6 blockers and 65 majors upheld**,
11 refuted (`critique-dropped.md`), 31 minors (`critique-minor.md`). Full upheld findings with refuter
amendments: `critique-confirmed.md` (large). Blockers in full + major index: `blockers-and-major-index.md`.

## Revision plan (not yet applied — spec at commit 7872a57 is the unrevised draft)
Blockers to fix first:
1. F1/C-06 — define `scan` exit 0 = "tick would act" (plan-only reconcile), not "eligible issues exist".
2. C-01 — add `released` stage; terminal records never veto eligibility; archive record on re-claim.
3. W-1 — launch sequence: `worktree create --no-parent --linear-issue … --setup skip` → install `.wingmate/` kit
   (+ git info/exclude) → `worker-start --run <id> --worktree id:<full id> --agent … [--model --effort]`.
4. SEC-3 — "answer" rule: approver author (`workspace.approvers`, default owner), not bot/external, created
   after `askedAt`, and no agent of the issue active within ±60 s; fenced resume message with nonce.
5. SEC-2 — Console security section: bind 127.0.0.1, Host/Origin checks, per-start bearer token, POST-only
   actions with custom header, CSP, audit every action.
6. SEC-1 — trust-boundary section + D14 risk acceptance: agents run with permission bypass as the owner;
   dispatcher-side outbox for all Linear/GitHub writes; Claude deny rules + sandbox in worktree settings;
   Codex limited until sandbox launch verified; tamper detection; compromise response.
Then the major themes: W-2 Run binding (`--run`, `run-use`), W-3/C-08 parked-coordinator vs worker contract
(who drains the Run inbox; when `worker_done` is sent), W-4/W-5 resume + liveness semantics, W-6 overrides stop
child workers, W-7/F4 per-provider quota shapes, W-8/UX-11 cost provenance (no per-Dispatch usage from Orca),
W-9/F18 automation `--workspace … --workspace-mode existing --fresh-session` + compiled dispatcher binary,
W-10 handoff settles predecessor, C-02..C-20 state-machine holes, UX-01..UX-17 (mention owner id, health tile,
immediate resume, skip reasons, trimmed Console v1), F-series formats and per-slice acceptance criteria.

## Status after revision 2 and the recheck (2026-10-06)
- Revision 2 (`be77e53`) addressed the six blockers and the major themes above.
- A capped three-lens recheck (consistency, Orca feasibility, security; no refuter fan-out) confirmed 69 prior
  findings resolved and raised 29 new ones (5 blockers, 22 majors, 2 minors): see `recheck-2026-10-06.md`.
  Headlines: override-table ordering released paused issues; the self-answer block had no exit; no authoritative
  transition table; publish-guard failures had no wake-up; `dispatch:` addressing could not reach a non-Dispatch
  coordinator; `account list` snapshots are hours stale; `terminal wait/send` needed explicit handles and the
  `exec` prefix; `worktree ps` retains closed-tab entries; shared dispatcher state defeated the outbox model;
  the Claude sandbox had to be loaded from a dispatcher-owned file with `allowUnsandboxedCommands: false`;
  GitHub hosts had to leave the agent network allowlist; Codex needed read-only/no-network modes; the Console
  token could not live on disk or in argv; `wingmate stop` could not wait on the tick lock and needed a process
  sweep.
- Revision 3 applies all 29 (spec sections 4.4, 5.1, 5.2.1, 5.4, 5.5, 6.0, 6.3, 7.1–7.4, 8.0–8.1, 9.1, 9.4, 9.6,
  10.1, 12.2, 12.5, 12.8, 13.1, 13.3, 14.3, 16.1, Appendix A). Decisions D14–D18 remain *proposed* pending the
  owner's review.
