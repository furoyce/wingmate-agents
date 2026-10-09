import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCleanupCtx, cleanupCommand } from "../../../src/cli/commands/cleanup";
import { parseArgv } from "../../../src/cli/index";
import { readRecord, writeRecord } from "../../../src/state/records";
import { cleanupWorld } from "../../fakes/cleanupWorld";

function present<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("fixture value missing");
  return value;
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("cleanup requires exactly one explicit, valid scope and rejects unsupported immediate merge policy", async () => {
  for (const args of [
    [],
    ["--force"],
    ["--all", "--project", "bouncr"],
    ["--issue", "../oops"],
    ["--all", "--immediate-on-merge"],
    ["--all", "--json=false"],
    ["extra", "--all"],
  ]) {
    let builds = 0;
    expect(
      await cleanupCommand(parseArgv(["cleanup", ...args]), {
        build: async () => {
          builds++;
          throw new Error("must not build");
        },
        err: () => {},
      }),
    ).toBe(2);
    expect(builds).toBe(0);
  }
});

test("CLI JSON dry run requests read-only context and shares normal grace with live cleanup", async () => {
  const w = await cleanupWorld();
  roots.push(w.root);
  present(w.r.history[0]).at = w.ctx.now();
  await writeRecord(w.dirs, w.r);
  const modes: boolean[] = [];
  const out: string[] = [];
  const build = async (o: { readOnly: boolean }) => {
    modes.push(o.readOnly);
    return w.ctx;
  };
  expect(
    await cleanupCommand(parseArgv(["cleanup", "--issue", w.r.identifier, "--dry-run", "--json"]), {
      build,
      out: (s) => out.push(s),
    }),
  ).toBe(0);
  expect(JSON.parse(present(out[0])).cleaned[0]).toMatchObject({ outcome: "deferred", reason: "grace" });
  expect(
    await cleanupCommand(parseArgv(["cleanup", "--issue", w.r.identifier, "--json"]), {
      build,
      out: (s) => out.push(s),
    }),
  ).toBe(0);
  expect(JSON.parse(present(out[1])).cleaned).toEqual(JSON.parse(present(out[0])).cleaned);
  expect(modes).toEqual([true, false]);
  expect((await readRecord(w.dirs, w.r.identifier))?.worktree).not.toBeNull();
  expect(w.orca.removed).toEqual([]);
});

test("CLI force never bypasses lifecycle or PR checks", async () => {
  const w = await cleanupWorld();
  roots.push(w.root);
  w.r.stage = "working";
  await writeRecord(w.dirs, w.r);
  const out: string[] = [];
  await cleanupCommand(parseArgv(["cleanup", "--all", "--force", "--json"]), {
    build: async () => w.ctx,
    out: (s) => out.push(s),
  });
  expect(JSON.parse(present(out[0])).cleaned[0].reason).toBe("stage_working");
  expect(w.orca.removed).toEqual([]);
});

test("production preview context creates no state, logs, or credentials and refuses writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "wm-cleanup-readonly-"));
  roots.push(root);
  const saved = {
    WINGMATE_HOME: process.env.WINGMATE_HOME,
    WINGMATE_CONFIG_HOME: process.env.WINGMATE_CONFIG_HOME,
  };
  process.env.WINGMATE_HOME = join(root, "absent-state");
  process.env.WINGMATE_CONFIG_HOME = root;
  const credentialPath = join(root, "credentials.json");
  await writeFile(credentialPath, "expired credentials must not be parsed or refreshed");
  try {
    const before = await readFile(credentialPath, "utf8");
    const ctx = await buildCleanupCtx({ readOnly: true });
    await expect(ctx.orca.worktreeRm("must-not-call-live-orca")).rejects.toMatchObject({ code: "read_only" });
    expect(await readdir(root)).toEqual(["credentials.json"]);
    expect(await readFile(credentialPath, "utf8")).toBe(before);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
