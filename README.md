# Wingmate

Wingmate turns labeled Linear issues into agent work that runs in isolation, and hands each one back to you for
review.

**How it works.** An Orca automation runs `wingmate tick --precheck` every 5 minutes; no LLM runs in this dispatcher.
Each tick does the following:

- It claims eligible issues in the pilot projects: issues in Todo carrying `agent-ready` or `claude`, labeled by an
  approver.
- For each claimed issue, it starts a sandboxed Claude coordinator in an Orca worktree named `wm-<issue>`.
- When the coordinator has a question, the tick parks it until you answer in Linear.
- When the coordinator finishes, the tick publishes the work as a pull request and moves the issue to In Review with
  the `Review-Ready` label. Before pushing, it runs a path guard, a secret scan and a dependency check.

Agents never hold credentials and never push. Linear sees every write as the "Wingmate" OAuth app, never as you.

## The three commands an operator needs

```sh
wingmate status                                   # what runs, what waits on you, what is blocked, and why (--json, --cost, --project <key>)
wingmate stop --issue <ID> | --project <key> | --all [--reason <text>]   # kill switch: stops agents and blocks issues now, no tick needed
wingmate doctor [--quick]                         # checks Linear, Orca, the install, the automation and the agent sandbox
```

Run them where `config/projects.yaml` is (the `wingmate-dispatcher` worktree or any checkout of this repository), or
set `WINGMATE_CONFIG`. A FAIL line from `doctor` keeps `wingmate install --enable` from turning the automation on.

## Documentation

- [docs/runbook.md](docs/runbook.md): daily routine, answering questions, reviews, stopping, every attention and
  refusal code, incidents, cost, upgrading and known limitations.
- [docs/linear-app-setup.md](docs/linear-app-setup.md): the one-time Linear setup (OAuth app, labels, views,
  notifications), credential rotation, and a personal key for read-only dry runs.
- [docs/superpowers/specs/2026-10-05-wingmate-agents-design.md](docs/superpowers/specs/2026-10-05-wingmate-agents-design.md):
  the design spec.

## Development

Bun 1.3.9 or later. Run `bun install`, then `bun test`, `bunx tsc --noEmit` and `bunx biome check .`.
