// tests/fakes/world.ts — one place that wires a Ctx against the fakes with a temp WINGMATE_HOME and a FixedClock
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/load";
import { type Ctx, buildCtx } from "../../src/machine/context";
import { homeDirs } from "../../src/shared/paths";
import { FixedClock } from "../../src/shared/time";
import { FakeGh, FakeGit } from "./fakeGit";
import { FakeLinear } from "./fakeLinear";
import { FakeOrca } from "./fakeOrca";

export async function makeWorld(startIso = "2026-10-06T10:00:00Z") {
  const root = mkdtempSync(join(tmpdir(), "wm-world-"));
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
  const git = new FakeGit();
  const gh = new FakeGh();
  const cfg = await loadConfig("config/projects.yaml");
  cfg.defaults.providers.coordinatorCascade = ["claude", "codex"]; // the pilot yaml pins [claude]; tests cover the handoff path
  const ctx: Ctx = await buildCtx({ cfg, dirs, clock, linear, orca, git, gh, home: root });
  return { root, clock, dirs, linear, orca, git, gh, cfg, ctx };
}
