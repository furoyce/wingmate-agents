import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeIntent } from "../../../src/kit/intents";
import { readLaunch } from "../../../src/kit/local";
import { shellQuote } from "../../../src/kit/settings";
import { claimIssue } from "../../../src/machine/claim";
import { relaunch } from "../../../src/machine/resume";
import { startRole } from "../../../src/machine/roles";
import { runtimeKitDir } from "../../../src/shared/runtime";
import { addLabeledByOwner, todo } from "../../fakes/issues";
import { makeWorld } from "../../fakes/world";

async function fixture() {
  const w = await makeWorld();
  w.ctx.runtimeKitRoot = w.dirs.kit;
  const project = w.cfg.projects.bouncr;
  const repo = project?.repos.api;
  if (!project || !repo) throw new Error("repo missing");
  const toolchain = realpathSync(mkdtempSync(join(tmpdir(), "wm-scoped-tools-")));
  const bin = join(toolchain, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "wm-runtime-setup"),
    '#!/bin/sh\ntest -z "${GH_TOKEN-}" || exit 19\ntest -z "${CUSTOM_SECRET-}" || exit 20\nprintf "%s\\n" "$PATH" > setup-runtime.txt\n',
    { mode: 0o755 },
  );
  repo.runtimeBinPaths = [bin];
  repo.setup = [["wm-runtime-setup"]];
  writeFileSync(
    join(w.root, ".claude/settings.json"),
    JSON.stringify({ model: "claude-fable-5-1[1m]", env: { CUSTOM_SECRET: "synthetic" } }),
  );
  const issue = todo("i1", "JRF-501");
  addLabeledByOwner(w.linear, issue);
  return { w, project, repo, toolchain, bin, issue };
}
async function claim(f: Awaited<ReturnType<typeof fixture>>) {
  return claimIssue(f.w.ctx, {
    issue: f.issue,
    project: f.project,
    provider: "claude",
    repoName: "api",
    routing: { basis: "default", candidates: [], rerouteFrom: null },
  });
}
const commands = (w: Awaited<ReturnType<typeof makeWorld>>) =>
  w.orca.calls.filter((c) => c.verb === "terminalCreate").map((c) => (c.args as { command: string }).command);

describe("runtime across dispatcher launch paths", () => {
  test("setup, initial coordinator and successor pin one PATH and preserve credential blanking and scoped read-only grants", async () => {
    const f = await fixture();
    const r = await claim(f);
    if (!r.worktree) throw new Error("worktree missing");
    expect(r.stage).toBe("working");
    const launch = await readLaunch(r.worktree.path);
    const runtime = launch.runtime;
    if (!runtime) throw new Error("runtime missing");
    expect(readFileSync(join(r.worktree.path, "setup-runtime.txt"), "utf8")).toBe(`${runtime.path}\n`);
    expect(runtime.binPaths).toEqual([f.bin]);
    const settings = JSON.parse(
      readFileSync(join(f.w.ctx.kitDirFor(r.identifier), "claude-settings.json"), "utf8"),
    );
    expect(settings.env).toMatchObject({ PATH: runtime.path, CUSTOM_SECRET: "", GH_TOKEN: "" });
    expect(settings.sandbox.filesystem.allowRead).toContain(f.bin);
    expect(settings.sandbox.filesystem.denyWrite).toContain(f.bin);
    expect(settings.sandbox.filesystem.allowRead).not.toContain(dirname(f.bin));
    expect(settings.sandbox.filesystem.denyRead).toContain("~/");
    expect(commands(f.w)[0]).toContain(`PATH=${shellQuote([runtime.path])} `);
    expect(commands(f.w)[0]).toContain("CUSTOM_SECRET='' ");
    expect(commands(f.w)[0]).toContain("GH_TOKEN='' ");
    f.repo.runtimeBinPaths = []; // config changes do not migrate an active kit
    const inherited = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";
    try {
      expect(await relaunch(f.w.ctx, r, "exited")).toBe(true);
    } finally {
      process.env.PATH = inherited;
    }
    expect(commands(f.w)).toHaveLength(2);
    expect(commands(f.w)[1]).toContain(`PATH=${shellQuote([runtime.path])} `);
    expect(
      JSON.parse(readFileSync(join(f.w.ctx.kitDirFor(r.identifier), "claude-settings.json"), "utf8")).env
        .PATH,
    ).toBe(runtime.path);
  });

  test("all dispatcher reviewer jobs receive the same pinned runtime", async () => {
    const f = await fixture();
    const r = await claim(f);
    if (!r.worktree) throw new Error("worktree missing");
    const runtime = (await readLaunch(r.worktree.path)).runtime;
    if (!runtime) throw new Error("runtime missing");
    for (const role of ["plan-verifier", "code-reviewer", "security-reviewer", "ui-reviewer"] as const) {
      const intent = await writeIntent(r.worktree.path, {
        issue: r.identifier,
        kind: "spawn",
        payload: { role, spec: "Review the bounded fixture.", prefer: null, deps: [] },
      });
      if (intent.kind !== "spawn") throw new Error("intent missing");
      await startRole(f.w.ctx, r, intent);
      const command = commands(f.w).at(-1);
      expect(command).toContain(`PATH=${shellQuote([runtime.path])} `);
      expect(command).toContain(`WINGMATE_ROLE=${role} `);
      expect(command).toContain("CUSTOM_SECRET='' ");
    }
    expect(r.roleJobs).toHaveLength(4);
  });

  test("missing configured runtime prevents setup and agent launch; missing pinned runtime prevents relaunch", async () => {
    const f = await fixture();
    rmSync(f.bin, { recursive: true });
    await expect(claim(f)).rejects.toMatchObject({ code: "runtime_invalid" });
    expect(commands(f.w)).toHaveLength(0);
    const ready = await fixture();
    const r = await claim(ready);
    rmSync(ready.bin, { recursive: true });
    expect(await relaunch(ready.w.ctx, r, "exited")).toBe(false);
    expect(commands(ready.w)).toHaveLength(1);
    expect(r.attention).toContain("relaunch_failed");
    const entry = (await ready.w.ctx.ledger.readIssue(r.identifier)).find(
      (e) => e.type === "relaunch_failed",
    );
    expect(entry?.data.code).toBe("runtime_invalid");
  });

  test("custom-state runtime kits are refused before installation; new custom legacy kits grant only the protected default anchor", async () => {
    const f = await fixture();
    f.w.ctx.runtimeKitRoot = undefined;
    await expect(claim(f)).rejects.toMatchObject({ code: "runtime_invalid" });
    expect(commands(f.w)).toHaveLength(0);
    const legacy = await fixture();
    legacy.w.ctx.runtimeKitRoot = undefined;
    legacy.repo.runtimeBinPaths = [];
    legacy.repo.setup = "none";
    const r = await claim(legacy);
    expect(r.stage).toBe("working");
    const settings = JSON.parse(
      readFileSync(join(legacy.w.ctx.kitDirFor(r.identifier), "claude-settings.json"), "utf8"),
    );
    const anchor = join(runtimeKitDir(r.identifier), "runtime.json");
    expect(settings.sandbox.filesystem.allowRead).toContain(anchor);
    expect(settings.sandbox.filesystem.denyWrite).toContain(anchor);
    expect(settings.sandbox.filesystem.allowRead).not.toContain(dirname(anchor));
    expect(settings.sandbox.filesystem.allowRead).not.toContain(dirname(dirname(anchor)));
  });
});
