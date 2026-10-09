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
