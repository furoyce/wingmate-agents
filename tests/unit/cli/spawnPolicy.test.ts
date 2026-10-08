import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnVerb } from "../../../src/cli/commands/issue/spawn";
import { parseArgv } from "../../../src/cli/index";
import { listIntents } from "../../../src/kit/intents";
import { type Launch, readLocal, writeLocal } from "../../../src/kit/local";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const wt = mkdtempSync(join(tmpdir(), "wm-spawn-policy-"));
  roots.push(wt);
  mkdirSync(join(wt, ".wingmate"));
  await writeLocal(wt, {
    record: {
      identifier: "JRF-404",
      stage: "working",
      pipelineStage: "planVerify",
      provider: "claude",
      childRunId: null,
    },
    gates: {},
    questions: [],
    run: null,
  });
  const launch: Launch = {
    spawnMode: "dispatcher",
    provider: "claude",
    model: null,
    effort: "max",
    kitDir: "/kit",
    worktreeId: "repo::/wt",
    roleSettings: {
      "plan-verifier": "/kit/plan.json",
      "code-reviewer": "/kit/code.json",
      "security-reviewer": "/kit/security.json",
      "ui-reviewer": "/kit/ui.json",
      worker: "/kit/worker.json",
    },
    baseSha: null,
    commonDir: join(wt, ".git"),
    pinnedGates: [["true"]],
    ui: { kind: "none", paths: [] },
    allowDeps: false,
    forbiddenPaths: [],
    verifyCross: true,
    workers: ["claude", "codex"], // even a provider allowed by the legacy worker policy cannot override review policy
    tiers: {},
    quota: { weeklyMax: 80, sessionMax: 90, maxSnapshotAgeMin: 360 },
  };
  writeFileSync(join(wt, ".wingmate/launch.json"), JSON.stringify(launch));
  writeFileSync(join(wt, ".wingmate/spec.md"), "Independently verify the plan.");
  return { wt, local: await readLocal(wt) };
}

for (const dryRun of [false, true])
  test(`dispatcher spawn rejects provider overrides before ${dryRun ? "dry run" : "enqueue"}`, async () => {
    const { wt, local } = await fixture();
    for (const prefer of [["claude"], ["codex"], []]) {
      const refusals: { code: string; message: string }[] = [];
      let externalCalls = 0;
      const code = await spawnVerb(
        parseArgv([
          "issue",
          "JRF-404",
          "spawn",
          "--role",
          "plan-verifier",
          "--spec",
          ".wingmate/spec.md",
          "--prefer",
          ...prefer,
          ...(dryRun ? ["--dry-run"] : []),
        ]),
        {
          cwd: wt,
          id: "JRF-404",
          local,
          env: { WINGMATE_ROLE: "coordinator" },
          out: () => {
            throw new Error("provider override must not produce a successful receipt");
          },
          refuse: (code, message) => {
            refusals.push({ code, message });
            return 2;
          },
          exec: async () => {
            externalCalls += 1;
            throw new Error("dispatcher spawn must not call Orca");
          },
        },
      );
      expect(code).toBe(2);
      expect(refusals).toEqual([
        {
          code: "provider_not_allowed",
          message: "the review provider policy selects terminal-job providers; omit --prefer",
        },
      ]);
      expect(externalCalls).toBe(0);
      expect(await listIntents(wt)).toEqual([]);
    }
  });
