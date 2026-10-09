import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { onboardCommand } from "../../../src/cli/commands/onboard";
import { parseArgv } from "../../../src/cli/index";
import { readOnboardingPlan } from "../../../src/ops/onboard";

const id = "00000000-0000-4000-8000-000000000001";
const raw = {
  workspace: { linearWorkspace: id, team: "TEST", owner: id, approvers: [id] },
  labels: {
    agentGroup: "Agent",
    lifecycleGroup: "Lifecycle",
    agent: { supported: ["claude"], human: "human" },
    lifecycle: ["Ready"],
  },
  defaults: { timezone: "UTC" },
  projects: {
    sample: {
      linearProject: id,
      repos: {
        api: {
          orcaRepo: id,
          github: "example/api",
          setup: ["/nonexistent/onboard-must-not-run", "setup"],
          gates: [["/nonexistent/onboard-must-not-run", "gate"]],
        },
      },
      routing: { default: "api" },
    },
  },
};
let root: string;
let configPath: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wingmate-onboard-cli-"));
  configPath = join(root, "projects.yaml");
  await writeFile(configPath, JSON.stringify(raw), { mode: 0o600 });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const execute = async (args: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Array<{ project?: string }> = [];
  const code = await onboardCommand(parseArgv(args), {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    plan: (options) => {
      calls.push(options);
      return readOnboardingPlan({ ...options, configPath });
    },
  });
  return { code, out, err, calls };
};

describe("onboard command", () => {
  test("JSON success is a read-only selected plan with no credential values", async () => {
    const result = await execute(["onboard", "--project", "sample", "--json"]);
    expect(result.code).toBe(0);
    expect(result.err).toEqual([]);
    const plan = JSON.parse(result.out.join("\n"));
    expect(plan).toMatchObject({
      readOnly: true,
      selectedProject: "sample",
      readiness: { execution: "unverified" },
    });
    expect(plan.projects[0].repos[0].pinnedChecks).toEqual(raw.projects.sample.repos.api.gates);
    expect(result.calls).toEqual([{ project: "sample" }]);
    expect(plan.workspace).toBeUndefined();
    expect(plan.credentials).toBeUndefined();
  });

  test("all malformed flags/extra arguments refuse before reading configuration", async () => {
    for (const args of [
      ["onboard", "extra"],
      ["onboard", "--project"],
      ["onboard", "--project="],
      ["onboard", "--project", "sample", "--project", "other"],
      ["onboard", "--json=true"],
      ["onboard", "--json=false"],
      ["onboard", "--enable"],
      ["onboard", "--cleanup"],
    ]) {
      const result = await execute(args);
      expect(result.code).toBe(2);
      expect(result.calls).toEqual([]);
      expect(result.err).toEqual(["usage: wingmate onboard [--project KEY] [--json]"]);
    }
  });

  test("unknown project and invalid config errors are actionable in JSON and human output", async () => {
    const json = await execute(["onboard", "--project", "missing", "--json"]);
    expect(json.code).toBe(2);
    expect(JSON.parse(json.out[0] ?? "{}")).toMatchObject({
      ok: false,
      code: "onboard_project_unknown",
      nextStep: expect.stringContaining("sample"),
    });
    await writeFile(configPath, "projects: [\nprivate-value-not-to-echo");
    const human = await execute(["onboard"]);
    expect(human.code).toBe(2);
    expect(human.err.join("\n")).toContain("config_invalid");
    expect(human.err.join("\n")).toContain("fix the selected config file");
    expect(human.err.join("\n")).not.toContain("private-value-not-to-echo");
  });

  test("human suggestions quote shell metacharacters and explicitly separate planning from activation", async () => {
    const oldPath = configPath;
    configPath = join(root, "owner's $(touch SHOULD_NOT_EXIST); projects.yaml");
    await writeFile(configPath, await readFile(oldPath));
    const result = await execute(["onboard", "--project", "sample"]);
    expect(result.code).toBe(0);
    const output = result.out.join("\n");
    expect(output).toContain("read-only");
    expect(output).toContain("prepares");
    expect(output).toContain("disabled");
    expect(output).toContain("owner'\\''s $(touch SHOULD_NOT_EXIST); projects.yaml'");
    expect(output).toContain("project selection filters this plan only");
    expect(output).toContain("Other automation hosts");
    expect((await readdir(root)).sort()).toEqual([
      "owner's $(touch SHOULD_NOT_EXIST); projects.yaml",
      "projects.yaml",
    ]);
  });

  test("actual command in a private subprocess needs no credentials/tools/network and does not mutate its fixture", async () => {
    await chmod(root, 0o700);
    const home = join(root, "home");
    const state = join(root, "state");
    const secrets = join(root, "private-config");
    const temp = join(root, "tmp");
    for (const path of [home, state, secrets, temp]) await mkdir(path, { mode: 0o700 });
    await writeFile(join(secrets, "oauth.json"), "malformed private canary", { mode: 0o600 });
    await writeFile(join(state, "install.json"), "malformed state canary", { mode: 0o600 });
    const driver = join(root, "driver.ts");
    const commandModule = resolve(import.meta.dir, "../../../src/cli/commands/onboard.ts");
    const loadModule = resolve(import.meta.dir, "../../../src/ops/onboard.ts");
    await writeFile(
      driver,
      `import {onboardCommand} from ${JSON.stringify(commandModule)};
import {readOnboardingPlan} from ${JSON.stringify(loadModule)};
globalThis.fetch = async () => {throw new Error("network must not be used");};
process.exit(await onboardCommand({cmd:["onboard"],flags:{json:true}}, {
plan: options => readOnboardingPlan({...options,configPath:${JSON.stringify(configPath)}})
}));\n`,
      { mode: 0o600 },
    );
    const inventory = async (path: string): Promise<Record<string, string>> => {
      const entries: Record<string, string> = {};
      for (const item of await readdir(path, { withFileTypes: true })) {
        const child = join(path, item.name);
        if (item.isDirectory()) Object.assign(entries, await inventory(child));
        else entries[child] = await readFile(child, "utf8");
      }
      return entries;
    };
    const before = await inventory(root);
    const child = Bun.spawnSync([process.execPath, "--no-env-file", "--no-autoload-dotenv", driver], {
      cwd: root,
      env: {
        HOME: home,
        TMPDIR: temp,
        PATH: "/nonexistent",
        WINGMATE_HOME: state,
        WINGMATE_CONFIG_HOME: secrets,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    });
    expect(child.exitCode).toBe(0);
    expect(new TextDecoder().decode(child.stderr)).toBe("");
    expect(JSON.parse(new TextDecoder().decode(child.stdout))).toMatchObject({
      readOnly: true,
      configuredProjects: ["sample"],
    });
    expect(await inventory(root)).toEqual(before);
  });
});
