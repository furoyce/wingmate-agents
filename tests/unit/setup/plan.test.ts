import { describe, expect, test } from "bun:test";
import { CONNECTORS, HOSTS, type SetupAnswers, setupPlan } from "../../../src/setup/plan";
import { WingmateError } from "../../../src/shared/errors";

const answers = (overrides: Partial<SetupAnswers> = {}): SetupAnswers => ({
  host: "orca",
  connector: "linear",
  project: "my-app",
  repo: "example/my-app",
  scheduler: "orca",
  ...overrides,
});

describe("first-run setup planning", () => {
  test("every operator/connector/scheduler combination reports desired choices without claiming live state", () => {
    for (const host of HOSTS) {
      for (const connector of CONNECTORS) {
        for (const scheduler of ["orca", "native"] as const) {
          const plan = setupPlan(answers({ host, connector, scheduler }));
          const backend = scheduler === "orca" || host === "orca" ? "orca" : host;
          const supported = backend === "orca" && connector === "linear";
          expect(plan).toMatchObject({
            version: 1,
            readOnly: true,
            status: "planned",
            readiness: "unverified",
            operatorHarness: host,
            issueConnector: connector,
            backend: { requested: scheduler, resolved: backend, liveReady: "unknown" },
            projectSummary: {
              key: "my-app",
              repository: "example/my-app",
              created: false,
              mappings: "unverified",
            },
            schedule: { host: backend, observed: null, created: false, enabled: null },
          });
          expect(plan.backend.implemented).toBe(backend === "orca");
          expect(plan.routines.dispatcher.implemented).toBe(supported);
          expect(plan.routines.cleanup.implemented).toBe(supported);
          expect(plan.blockers.length === 0).toBe(supported);
          expect(plan.connection.status).toBe(connector === "linear" ? "unverified" : "adapter_missing");
          if (!supported) expect(plan.nextSteps.every((step) => step.argv === undefined)).toBe(true);
          expect(plan.routines.audits).toMatchObject({ implemented: false, schedule: null });
        }
      }
    }
  });

  test("implemented setup uses actual whole-config commands with explicit authorization/readiness conditions", () => {
    const plan = setupPlan(answers({ host: "codex" }));
    expect(plan.nextSteps.map((step) => step.argv)).toEqual([
      ["wingmate", "onboard", "--guide"],
      ["wingmate", "config", "validate"],
      ["wingmate", "onboard", "--project", "my-app", "--json"],
      ["wingmate", "install"],
      ["wingmate", "doctor"],
      ["wingmate", "scan", "--dry-run", "--json"],
      ["wingmate", "install", "--enable"],
    ]);
    const step = (id: string) => plan.nextSteps.find((item) => item.id === id);
    expect(step("config-inputs")?.note).toContain("real Linear");
    expect(step("config-inputs")?.note).toContain("WINGMATE_CONFIG");
    expect(step("config-inputs")?.note).toContain("worker provider");
    expect(step("install-disabled")?.note).toContain("shared automation disabled");
    expect(step("onboard-project")?.note).toContain("entire selected configuration");
    expect(step("authorized-enable")?.note).toContain("activation is authorized");
    expect(step("authorized-enable")?.note).toContain("full doctor");
    expect(step("first-issue")?.note).toContain("configured approver");
    expect(plan.routines.cleanup.detail).toContain("same dispatcher");
    expect(plan.routines.health).toMatchObject({
      mode: "manual",
      argv: ["wingmate", "doctor", "--quick", "--json"],
    });
  });

  test("native host cadences and environments remain plans with no guessed executable job APIs", () => {
    const claude = setupPlan(answers({ host: "claude-code", scheduler: "native" }));
    expect(claude.schedule).toMatchObject({
      terminology: "routines",
      executionEnvironment: "Claude cloud",
      cadence: { cron: "0 * * * *", timezone: "host-config" },
    });
    expect(claude.schedule.cadence.note).toContain("minimum hourly");
    expect(claude.schedule.detail).toContain("not a public Wingmate CRUD API");
    expect(claude.sourceURLs[0]?.url).toBe("https://code.claude.com/docs/en/routines");
    const codex = setupPlan(answers({ host: "codex", scheduler: "native" }));
    expect(codex.schedule).toMatchObject({
      terminology: "scheduled tasks",
      executionEnvironment: "Codex desktop",
      cadence: { cron: null, timezone: "host-config" },
    });
    expect(codex.schedule.cadence.note).toContain("owner chooses");
    expect(codex.sourceURLs[0]?.url).toBe("https://learn.chatgpt.com/docs/automations");
    for (const host of ["pi", "opencode"] as const) {
      const plan = setupPlan(answers({ host, scheduler: "native" }));
      expect(plan.schedule.executionEnvironment).toBe("unknown");
      expect(plan.schedule.cadence).toMatchObject({ cron: null, timezone: null });
      expect(plan.sourceURLs).toEqual([]);
    }
    const orca = setupPlan(answers({ scheduler: "native" }));
    expect(orca.backend).toMatchObject({ requested: "native", resolved: "orca", implemented: true });
    expect(orca.schedule.terminology).toBe("automations");
    expect(orca.schedule.detail).toContain("share this automation");
  });

  test("GitHub issue selection refuses a live recipe while preserving repository/PR capability distinction", () => {
    for (const host of HOSTS) {
      const plan = setupPlan(answers({ host, connector: "github" }));
      expect(plan.blockers.join(" ")).toContain("pull-request publication are supported");
      expect(plan.blockers.join(" ")).toContain("GitHub issue intake is not implemented");
      expect(plan.blockers.join(" ")).toContain("do not invent Linear");
      expect(plan.connection.status).toBe("adapter_missing");
      expect(plan.nextSteps.some((step) => step.argv)).toBe(false);
      expect(JSON.stringify(plan)).not.toContain("linearProject");
    }
  });

  test("repeated plans do not mutate input, share output objects or consult process credentials/config", () => {
    const input = Object.freeze(answers());
    const before = JSON.stringify(input);
    const originalConfig = process.env.WINGMATE_CONFIG;
    process.env.WINGMATE_CONFIG = "/does-not-exist/setup-planner-must-not-read.yaml";
    try {
      const first = setupPlan(input);
      const second = setupPlan(input);
      expect(first).toEqual(second);
      first.nextSteps[0]?.argv?.push("changed-advisory-only");
      first.blockers.push("changed-advisory-only");
      expect(setupPlan(input)).toEqual(second);
      expect(JSON.stringify(input)).toBe(before);
      expect(JSON.stringify(second)).not.toContain(process.env.WINGMATE_CONFIG);
    } finally {
      if (originalConfig === undefined) Reflect.deleteProperty(process.env, "WINGMATE_CONFIG");
      else process.env.WINGMATE_CONFIG = originalConfig;
    }
  });

  test("valid GitHub identifiers remain exact and are never expanded into a shell string", () => {
    for (const repo of [
      "Owner-Name/.github",
      "example/api_v2.repo",
      "a/b",
      `${"a".repeat(39)}/${"r".repeat(100)}`,
    ]) {
      const plan = setupPlan(answers({ repo }));
      expect(plan.repo).toBe(repo);
      expect(plan.projectSummary.repository).toBe(repo);
      expect(plan.nextSteps.every((step) => !step.argv?.includes(repo))).toBe(true);
    }
  });

  test("untrusted enums, structured IDs, unknown fields and shell/control injection refuse actionably", () => {
    const candidates: unknown[] = [
      null,
      [],
      "orca",
      {},
      Object.create(answers()),
      answers({ host: "Orca" as SetupAnswers["host"] }),
      answers({ connector: "jira" as SetupAnswers["connector"] }),
      answers({ scheduler: "cron" as SetupAnswers["scheduler"] }),
      { ...answers(), token: "must-not-be-accepted" },
      JSON.parse(
        '{"host":"orca","connector":"linear","project":"my-app","repo":"example/app","scheduler":"orca","__proto__":{}}',
      ),
    ];
    for (const project of [
      "",
      "A",
      "my_app",
      "-app",
      "app-",
      "a--b",
      ".",
      "..",
      "constructor",
      "prototype",
      "a".repeat(65),
    ])
      candidates.push(answers({ project }));
    for (const repo of [
      "",
      "owner",
      "owner/repo/extra",
      "https://github.com/owner/repo",
      "/repo",
      "-owner/repo",
      "owner-/repo",
      "owner/.",
      "owner/..",
      `${"a".repeat(40)}/repo`,
      `owner/${"r".repeat(101)}`,
    ])
      candidates.push(answers({ repo }));
    for (const bad of [
      "\n",
      "\r",
      "\t",
      "\0",
      "\x7f",
      "\x85",
      " ",
      ";",
      "&",
      "|",
      "`",
      "$",
      "'",
      '"',
      "(",
      ")",
      "<",
      ">",
      "\\",
      "[",
      "]",
      "{",
      "}",
    ]) {
      candidates.push(answers({ project: `my${bad}app` }), answers({ repo: `owner/re${bad}po` }));
      candidates.push(answers({ host: `orca${bad}` as SetupAnswers["host"] }));
    }
    for (const input of candidates) {
      let caught: unknown;
      try {
        setupPlan(input as SetupAnswers);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(WingmateError);
      expect((caught as WingmateError).code).toBe("setup_input_invalid");
      expect((caught as WingmateError).nextStep).toContain("owner/repository");
    }
  });
});
