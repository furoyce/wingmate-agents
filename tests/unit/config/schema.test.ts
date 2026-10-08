// tests/unit/config/schema.test.ts
import { describe, expect, test } from "bun:test";
import { ConfigSchema, withDefaults } from "../../../src/config/schema";
import { WingmateError } from "../../../src/shared/errors";
const minimal = {
  workspace: {
    linearWorkspace: "dfcf61c2-72c0-4d39-9485-96576cabb555",
    team: "JRF",
    owner: "71aef180-1742-4a76-8d49-51f14e8ada1e",
    approvers: ["71aef180-1742-4a76-8d49-51f14e8ada1e"],
  },
  labels: {
    agentGroup: "Agent",
    lifecycleGroup: "Lifecycle",
    agent: {
      supported: ["agent-ready", "claude", "codex"],
      human: "human",
      unsupported: ["gemini", "manus", "tunip", "tweak"],
    },
    lifecycle: ["Ready", "In-Agent", "Needs-Human", "Review-Ready", "Blocked"],
    allowDeps: "allow-deps",
  },
  defaults: { timezone: "America/New_York" },
  projects: {
    bouncr: {
      linearProject: "0ca67822-6416-447b-b7b2-08ab2a7346dd",
      repos: {
        api: {
          orcaRepo: "7b0ddfa8-7ef0-4be6-b4ef-38013c099fb8",
          github: "furoyce/bouncr.lol",
          base: "origin/main",
          setup: ["npm", "ci"],
          gates: [["npm", "test"]],
          ui: { kind: "ios", paths: ["mobile/"], dev: ["npm", "run", "ios"], url: "", smokeRoutes: [] },
        },
      },
      routing: { default: "api", rules: [] },
    },
  },
};
describe("ConfigSchema", () => {
  test("applies defaults for caps, quota, timers", () => {
    const cfg = withDefaults(ConfigSchema.parse(minimal));
    expect(cfg.defaults.concurrency.maxWorking.global).toBe(3);
    expect(cfg.defaults.quota.maxSnapshotAgeMin).toBe(360);
    expect(cfg.defaults.timers.graceMin).toBe(30);
    // D14 extension (spike 2026-10-06): Codex reads outside the worktree; widen only when the owner says so
    expect(cfg.defaults.providers.coordinatorCascade).toEqual(["claude"]);
    expect(cfg.projects.bouncr?.autonomy).toBe("ask-first");
  });
  test("rejects a repo with empty gates", () => {
    const bad = structuredClone(minimal);
    bad.projects.bouncr.repos.api.gates = [];
    expect(() => ConfigSchema.parse(bad)).toThrow(/gates/);
  });
  test("normalizes legacy setup argv and accepts an explicit sequence or none", () => {
    const repo = minimal.projects.bouncr.repos.api;
    const configured = (setup: unknown) =>
      ConfigSchema.parse({
        ...minimal,
        projects: {
          bouncr: { ...minimal.projects.bouncr, repos: { api: { ...repo, setup } } },
        },
      }).projects.bouncr?.repos.api?.setup;
    expect(configured(["npm", "ci"])).toEqual([["npm", "ci"]]);
    expect(
      configured([
        ["npm", "ci", "--prefix", "api"],
        ["npm", "ci", "--prefix", "mobile"],
      ]),
    ).toEqual([
      ["npm", "ci", "--prefix", "api"],
      ["npm", "ci", "--prefix", "mobile"],
    ]);
    expect(configured("none")).toBe("none");
    expect(configured(undefined)).toBe("none");
    for (const setup of [
      [],
      [[]],
      [["npm", "ci"], []],
      ["npm", ""],
      [["npm", ""]],
      "npm ci",
      ["npm", ["ci"]],
    ])
      expect(() => configured(setup)).toThrow();
  });
  test("rejects a routing default that is not a repo", () => {
    const bad = structuredClone(minimal);
    bad.projects.bouncr.routing.default = "web";
    expect(() => withDefaults(ConfigSchema.parse(bad))).toThrow(/routing.default/);
  });
  test("routing-target errors are WingmateError config_invalid (default and rules)", () => {
    const badDefault = structuredClone(minimal);
    badDefault.projects.bouncr.routing.default = "web";
    const badRule = structuredClone(minimal) as unknown as {
      projects: { bouncr: { routing: { default: string; rules: { match: string[]; repo: string }[] } } };
    };
    badRule.projects.bouncr.routing.rules = [{ match: ["web"], repo: "web" }];
    for (const bad of [badDefault, badRule]) {
      let caught: unknown = null;
      try {
        withDefaults(ConfigSchema.parse(bad));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(WingmateError);
      expect((caught as WingmateError).code).toBe("config_invalid");
    }
  });
  test("per-project overrides merge over defaults", () => {
    const over = structuredClone(minimal) as unknown as { projects: { bouncr: Record<string, unknown> } };
    over.projects.bouncr.concurrency = { maxWorking: { perProject: 2 } };
    const cfg = withDefaults(ConfigSchema.parse(over));
    expect(cfg.projects.bouncr?.concurrency.maxWorking.perProject).toBe(2);
    expect(cfg.projects.bouncr?.concurrency.maxWorking.global).toBe(3);
  });
});
