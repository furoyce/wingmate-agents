import { expect, test } from "bun:test";
import { packageCommand } from "../../../src/cli/commands/package";
import { main, parseArgv } from "../../../src/cli/index";

test("package info exposes static capabilities without requiring config or credentials", async () => {
  const output: string[] = [];
  const result = await packageCommand(parseArgv(["package", "info", "--json"]), {
    out: (s) => output.push(s),
    export: async () => {
      throw new Error("info must not export anything");
    },
  });
  expect(result).toBe(0);
  expect(JSON.parse(output.join("")).format).toBe("wingmate-skill-bundle/v1");
});

test("invalid package invocations never call the exporter", async () => {
  const invalid = [
    ["package"],
    ["package", "export"],
    ["package", "info", "--out", "/tmp/example"],
    ["package", "export", "--out"],
    ["package", "export", "--out", "a", "--out", "b"],
    ["package", "export", "--out", "a", "--force"],
    ["package", "info", "--json", "true"],
  ];
  for (const args of invalid) {
    let calls = 0;
    const result = await packageCommand(parseArgv(args), {
      err: () => {},
      export: async () => {
        calls++;
        throw new Error("unexpected mutation");
      },
    });
    expect(result).toBe(2);
    expect(calls).toBe(0);
  }
});

test("top-level help advertises the package without loading any command", async () => {
  const output: string[] = [];
  const result = await main(["package", "--help"], {
    out: (s) => output.push(s),
    handlers: {
      package: async () => {
        throw new Error("help must not load a command");
      },
    },
  });
  expect(result).toBe(0);
  expect(output.join("")).toContain("wingmate package export --out");
});

const receipt = {
  installed: true as const,
  host: "codex" as const,
  directory: "/tmp/agent skills/wingmate",
  version: "0.1.0",
  automationChanged: false as const,
};

test("interactive skill install starts the selected agent with installed paths, not another plan", async () => {
  for (const host of ["codex", "claude-code"] as const) {
    const events: string[] = [];
    const cli = ["/abs/path with spaces/wingmate"];
    const code = await packageCommand(parseArgv(["package", "install", "--host", host]), {
      interactive: true,
      cli,
      out: () => {},
      install: async (input) => {
        expect(input).toEqual({ host });
        events.push("installed");
        return { ...receipt, host };
      },
      launchAgent: async (argv) => {
        events.push("agent");
        expect(argv[0]).toBe(host === "codex" ? "codex" : "claude");
        expect(argv).toHaveLength(2);
        expect(argv[1]).toContain(JSON.stringify(`${receipt.directory}/SKILL.md`));
        expect(argv[1]).toContain(JSON.stringify(cli));
        expect(argv[1]).toContain(`Known operator harness: ${host}`);
        return 0;
      },
      setup: async () => {
        throw new Error("agent owns the guided continuation");
      },
    });
    expect(code).toBe(0);
    expect(events).toEqual(["installed", "agent"]);
  }
});

test("JSON install returns pending onboarding to the current agent without launching or prompting", async () => {
  const output: string[] = [];
  const cli = ["/abs/bun", "/abs/wingmate/bin/wingmate.ts"];
  const code = await packageCommand(
    parseArgv(["package", "install", "--host", "codex", "--skills-dir", "/chosen", "--json"]),
    {
      interactive: true,
      cli,
      out: (s) => output.push(s),
      install: async (input) => {
        expect(input.skillsDir).toBe("/chosen");
        return receipt;
      },
      setup: async () => {
        throw new Error("no prompt");
      },
      launchAgent: async () => {
        throw new Error("no nested agent");
      },
    },
  );
  expect(code).toBe(0);
  const value = JSON.parse(output.join(""));
  expect(value.installed).toBe(true);
  expect(value.automationChanged).toBe(false);
  expect(value.onboarding.state).toBe("pending");
  expect(value.onboarding.knownAnswers).toEqual({ host: "codex" });
  expect(value.onboarding.questions).toEqual([...cli, "setup", "--questions", "--json"]);
  expect(value.onboarding.skill).toBe(`${receipt.directory}/SKILL.md`);
});

test("non-TTY install never launches an interactive session", async () => {
  const output: string[] = [];
  expect(
    await packageCommand(parseArgv(["package", "install", "--host", "codex"]), {
      interactive: false,
      cli: ["/absolute path/wingmate"],
      out: (s) => output.push(s),
      install: async () => receipt,
      launchAgent: async () => {
        throw new Error("must not launch");
      },
    }),
  ).toBe(0);
  expect(output.join("\n")).toContain("pending");
  expect(output.join("\n")).toContain(JSON.stringify(["/absolute path/wingmate"]));
});

test("agent exit and failed launch preserve the skill outcome without claiming runtime success", async () => {
  for (const outcome of [130, 1, "missing"] as const) {
    const messages: string[] = [];
    const code = await packageCommand(parseArgv(["package", "install", "--host", "codex"]), {
      interactive: true,
      out: (s) => messages.push(s),
      err: (s) => messages.push(s),
      install: async () => receipt,
      launchAgent: async () => {
        if (outcome === "missing") throw new Error("ENOENT");
        return outcome;
      },
    });
    expect(code).toBe(outcome === "missing" ? 2 : outcome);
    expect(messages.join("\n")).toContain("Installed Wingmate skill:");
    expect(messages.join("\n")).not.toContain("onboarding complete");
  }
});

test("other hosts get seeded setup and cancellation explains the installed skill remains", async () => {
  const messages: string[] = [];
  expect(
    await packageCommand(parseArgv(["package", "install", "--host", "pi", "--skills-dir", "/chosen"]), {
      interactive: true,
      out: (s) => messages.push(s),
      err: (s) => messages.push(s),
      install: async () => ({ ...receipt, host: "pi" }),
      setup: async (argv) => {
        expect(argv.flags.host).toBe("pi");
        return 130;
      },
      launchAgent: async () => {
        throw new Error("unverified launcher");
      },
    }),
  ).toBe(130);
  expect(messages.join("\n")).toContain("skill remains installed");
});

test("installer refuses malformed flags before writing or launching", async () => {
  for (const args of [
    ["package", "install"],
    ["package", "install", "--host", "codex", "--force"],
    ["package", "install", "--host", "codex", "--host", "claude-code"],
    ["package", "install", "--host", "codex", "--out", "/tmp/a"],
    ["package", "install", "--host", "codex", "--format", "codex"],
    ["package", "export", "--out", "/tmp/a", "--format", "invented"],
  ]) {
    expect(
      await packageCommand(parseArgv(args), {
        err: () => {},
        install: async () => {
          throw new Error("must not write");
        },
        export: async () => {
          throw new Error("must not export");
        },
      }),
    ).toBe(2);
  }
});

test("Codex format is passed to the exporter and info identifies its entrypoint", async () => {
  const output: string[] = [];
  expect(
    await packageCommand(parseArgv(["package", "info", "--format", "codex", "--json"]), {
      out: (s) => output.push(s),
    }),
  ).toBe(0);
  const info = JSON.parse(output.join(""));
  expect(info.format).toBe("wingmate-codex-plugin-bundle/v1");
  expect(info.entrypoint).toBe("plugins/wingmate/.codex-plugin/plugin.json");
});
