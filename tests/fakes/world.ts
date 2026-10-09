// tests/fakes/world.ts — one place that wires a Ctx against the fakes with a temp WINGMATE_HOME and a FixedClock
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/load";
import { type Ctx, type PublishFn, buildCtx } from "../../src/machine/context";
import { LinearWrites } from "../../src/machine/linearWrites";
import { publish } from "../../src/machine/publish";
import { transition } from "../../src/machine/states";
import { homeDirs } from "../../src/shared/paths";
import { FixedClock } from "../../src/shared/time";
import { FakeGh, FakeGit } from "./fakeGit";
import { FakeLinear } from "./fakeLinear";
import { FakeOrca } from "./fakeOrca";

/**
 * A publish without guards, git or GitHub: an open PR, `Review-Ready` + In Review through the journaled writes, then `review`. The
 * world publishes for real (Task 11); a test that is about something else may opt into this stub with `ctx.publishImpl`.
 */
export const stubPublish: PublishFn = async (ctx, r, issue) => {
  r.prs.push({
    repo: r.repo,
    number: 1,
    url: "https://github.com/fake/repo/pull/1",
    state: "OPEN",
    headSha: "headsha",
  });
  const w = new LinearWrites(ctx);
  await w.setLifecycle(r, issue, "Review-Ready");
  await w.setState(r, issue, "In Review");
  await transition(ctx, r, "review", "finish_published");
  return true;
};

export async function makeWorld(startIso = "2026-10-06T10:00:00Z") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wm-world-")));
  const clock = new FixedClock(new Date(startIso));
  // Provider defaults under the temp home so resolveTier resolves without touching the real ~.
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ model: "claude-fable-5-1[1m]" }));
  mkdirSync(join(root, ".codex"), { recursive: true });
  writeFileSync(
    join(root, ".codex", "config.toml"),
    'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "xhigh"\n',
  );
  const dirs = homeDirs({ WINGMATE_HOME: root, WINGMATE_CONFIG_HOME: root, HOME: root });
  const linear = new FakeLinear();
  linear.now = () => clock.now().toISOString();
  const orca = new FakeOrca();
  orca.now = () => clock.now().toISOString();
  orca.root = join(root, "orca"); // real linked worktrees: the kit, outbox and integrity check run on real files
  const git = new FakeGit();
  orca.onWorktree = (path, commonDir, gitDir) => {
    git.commonDirs.set(path, commonDir);
    git.gitDirs.set(path, gitDir);
    git.heads.set(path, orca.startCommit); // R30: the new worktree's HEAD, which the claim reads with its own git
  };
  const gh = new FakeGh();
  const swept: string[] = [];
  const sweeps: { paths: string[]; spare: string | null }[] = [];
  const cfg = await loadConfig("config/projects.yaml");
  cfg.defaults.providers.coordinatorCascade = ["claude", "codex"]; // the pilot yaml pins [claude]; tests cover the handoff path
  // F1/F2: every configured repo's main checkout is in the fleet, where a claim verifies its base before creating a worktree
  for (const p of Object.values(cfg.projects))
    for (const repo of Object.values(p.repos)) {
      orca.mains.add(repo.orcaRepo);
      repo.setup = "none"; // Fake worktrees have no package manifests; setup tests opt into their own commands.
    }
  const ctx: Ctx = await buildCtx({
    cfg,
    dirs,
    clock,
    linear,
    orca,
    git,
    gh,
    home: root,
    toolchainPaths: [],
    inspectCleanupProcesses: async () => ({ complete: true, pids: [] }),
    sweep: async (paths, opts) => {
      swept.push(...paths);
      sweeps.push({ paths, spare: opts?.spare ?? null });
      return { killed: [] };
    },
    publishImpl: async () => ({ publish }),
  });
  return { root, clock, dirs, linear, orca, git, gh, cfg, ctx, swept, sweeps };
}
export type World = Awaited<ReturnType<typeof makeWorld>>;
