import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, withDefaults } from "../../../src/config/schema";
import { onboardingPlan, readOnboardingPlan } from "../../../src/ops/onboard";

const id = "00000000-0000-4000-8000-000000000001";
const raw = () => ({
  workspace: { linearWorkspace: id, team: "TEST", owner: id, approvers: [id] },
  labels: {
    agentGroup: "Agent",
    lifecycleGroup: "Lifecycle",
    agent: { supported: ["claude"], human: "human" },
    lifecycle: ["Ready"],
  },
  defaults: { timezone: "UTC", cleanup: { worktreeGraceHours: 36 } },
  projects: {
    sample: {
      linearProject: id,
      repos: {
        api: {
          orcaRepo: id,
          github: "example/api",
          setup: [
            ["npm", "ci"],
            ["npm", "run", "prepare"],
          ],
          runtimeBinPaths: ["/nonexistent/scoped/node/bin"],
          gates: [
            ["npm", "test"],
            ["npm", "run", "typecheck"],
          ],
          requiredCheck: "Smoke",
        },
        mobile: {
          orcaRepo: id,
          github: "example/mobile",
          gates: [["npm", "run", "verify"]],
          ui: { kind: "ios", paths: ["mobile/"] },
        },
      },
      routing: { default: "api", rules: [{ match: ["mobile", "ios"], repo: "mobile" }] },
    },
    other: {
      linearProject: id,
      repos: { web: { orcaRepo: id, github: "example/web", gates: [["bun", "test"]] } },
      routing: { default: "web" },
    },
  },
});
const config = () => withDefaults(ConfigSchema.parse(raw()));
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wingmate-onboard-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const fixture = async (value: unknown = raw()) => {
  const path = join(root, "projects.yaml");
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return path;
};

describe("onboarding configuration-only plan", () => {
  test("projects selection preserves exact routing, sequential setup and pinned checks without changing config", () => {
    const cfg = config();
    const before = JSON.stringify(cfg);
    const all = onboardingPlan(cfg, "/private/config/projects.yaml");
    expect(all.configuredProjects).toEqual(["sample", "other"]);
    expect(all.projects.map((p) => p.key)).toEqual(["sample", "other"]);
    const selected = onboardingPlan(cfg, "/private/config/projects.yaml", "sample");
    expect(selected.projects).toHaveLength(1);
    expect(selected.projects[0]?.routing).toEqual(raw().projects.sample.routing);
    const api = selected.projects[0]?.repos.find((repo) => repo.name === "api");
    expect(api?.setup).toEqual(raw().projects.sample.repos.api.setup);
    expect(api?.pinnedChecks).toEqual(raw().projects.sample.repos.api.gates);
    expect(api?.requiredCheck).toBe("Smoke");
    if (api) api.pinnedChecks[0]?.push("advisory-only");
    expect(JSON.stringify(cfg)).toBe(before);
    expect(selected.readOnly).toBe(true);
    expect(selected.readiness).toMatchObject({ configuration: "validated", execution: "unverified" });
  });

  test("unknown project and unsafe config path refuse actionably", () => {
    expect(() => onboardingPlan(config(), "/private/config/projects.yaml", "missing")).toThrow(
      "not configured",
    );
    expect(() => onboardingPlan(config(), "/private/config/projects.yaml", "toString")).toThrow(
      "not configured",
    );
    for (const path of ["relative.yaml", "/private/config/../projects.yaml", "/private/config\n.yaml"])
      expect(() => onboardingPlan(config(), path)).toThrow("absolute normalized");
  });

  test("routines describe existing dispatcher cleanup and operator-only commands truthfully", () => {
    const plan = onboardingPlan(config(), "/private/config/projects.yaml", "sample");
    expect(plan.routines.dispatcher).toMatchObject({
      host: "Orca",
      trigger: "*/5 * * * *",
      timezone: "UTC",
      currentState: "unknown",
      proposedInstallState: "disabled",
    });
    expect(plan.routines.health.mode).toBe("manual");
    expect(plan.routines.cleanup.worktreeGraceHours).toBe(36);
    expect(plan.routines.cleanup.detail).toContain("open PRs");
    expect(plan.routines.otherHosts.supported).toBe(false);
    expect(plan.projects[0]?.repos.find((repo) => repo.name === "mobile")?.ui).toMatchObject({
      nativePolicyConfigured: false,
    });
    expect(plan.projects[0]?.repos.find((repo) => repo.name === "mobile")?.ui.limitation).toContain(
      "not implemented",
    );
    expect(plan.nextSteps.map((step) => step.argv)).toEqual([
      ["wingmate", "config", "validate", "--file", plan.configPath],
      ["wingmate", "install"],
      ["wingmate", "doctor", "--quick"],
      ["wingmate", "doctor"],
      ["wingmate", "tick", "--dry-run", "--json"],
      ["wingmate", "install", "--enable"],
    ]);
    for (const step of plan.nextSteps) {
      expect(step.env).toEqual({ WINGMATE_CONFIG: plan.configPath });
      expect(step.argv).not.toContain("--project");
      expect(step.argv).not.toContain("cleanup");
    }
    expect(plan.nextSteps.find((step) => step.id === "dry_run")?.note).toContain("nonzero exit code");
    expect(plan.nextSteps.find((step) => step.id === "install_disabled")?.note).toContain(
      "Orca-managed Wingmate checkout",
    );
  });

  test("resolves a relative selected config and canonicalizes a symlink without executing nonexistent hooks", async () => {
    const path = await fixture();
    await symlink(path, join(root, "selected.yaml"));
    const plan = await readOnboardingPlan({ configPath: "selected.yaml", cwd: root, project: "sample" });
    expect(plan.configPath).toBe(await realpath(path));
    expect(plan.projects[0]?.repos[0]?.runtimeBinPaths).toEqual(["/nonexistent/scoped/node/bin"]);
    expect((await readdir(root)).sort()).toEqual(["projects.yaml", "selected.yaml"]);
    expect(await readFile(path, "utf8")).toBe(JSON.stringify(raw()));
  });

  test("missing config, mapping, routing and malformed YAML refuse without creating state", async () => {
    await expect(readOnboardingPlan({ configPath: join(root, "absent.yaml") })).rejects.toMatchObject({
      code: "config_missing",
      nextStep: expect.stringContaining("WINGMATE_CONFIG"),
    });
    const missingMapping = raw();
    Reflect.deleteProperty(missingMapping.projects.sample.repos.api, "orcaRepo");
    await expect(readOnboardingPlan({ configPath: await fixture(missingMapping) })).rejects.toMatchObject({
      code: "config_invalid",
      message: expect.stringContaining("orcaRepo"),
      nextStep: expect.stringContaining("projects.yaml"),
    });
    const invalidRouting = raw();
    invalidRouting.projects.sample.routing.default = "unmapped";
    await expect(readOnboardingPlan({ configPath: await fixture(invalidRouting) })).rejects.toMatchObject({
      code: "config_invalid",
      message: expect.stringContaining("routing.default"),
    });
    const path = await fixture();
    await writeFile(path, "projects: [\nprivate-value-not-to-echo");
    await expect(readOnboardingPlan({ configPath: path })).rejects.toMatchObject({
      code: "config_invalid",
      message: "the selected configuration is not valid YAML",
    });
    expect(await readdir(root)).toEqual(["projects.yaml"]);
  });
});
