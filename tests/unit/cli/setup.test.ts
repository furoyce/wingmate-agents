import { describe, expect, test } from "bun:test";
import { setupCommand } from "../../../src/cli/commands/setup";
import { main, parseArgv } from "../../../src/cli/index";

async function run(args: string[], answers?: Array<string | null>) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const schedulerLabels: string[] = [];
  const code = await setupCommand(parseArgv(args), {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    interactive: Boolean(answers),
    ask: async (q) => {
      asked.push(q.id);
      if (q.id === "scheduler") schedulerLabels.push(...(q.options ?? []).map((option) => option.label));
      return answers?.shift() ?? null;
    },
  });
  return { code, out, err, asked, schedulerLabels };
}

describe("first-run setup", () => {
  test("asks harness first, then connector/project and selects the chosen scheduler", async () => {
    const result = await run(["setup"], ["3", "1", "my-app", "example/app", "2"]);
    expect(result.code).toBe(0);
    expect(result.asked).toEqual(["host", "connector", "project", "repo", "scheduler"]);
    expect(result.out.join("\n")).toContain("claude-code");
    expect(result.out.join("\n")).not.toContain("'wingmate' 'install'");
    expect(result.schedulerLabels.some((label) => label.includes("cloud routines"))).toBe(true);
  });

  test("invalid project and repository answers retry only that question and retain earlier answers", async () => {
    const result = await run(
      ["setup", "--host", "orca"],
      ["linear", "MyApp", "my-app", "https://github.com/example/app", "example/app"],
    );
    expect(result.code).toBe(0);
    expect(result.asked).toEqual(["connector", "project", "project", "repo", "repo"]);
    expect(result.out.join("\n")).toContain("my-app (example/app)");
    const invalidFlag = await run(["setup", "--project", "MyApp"], ["orca"]);
    expect(invalidFlag.code).toBe(2);
    expect(invalidFlag.asked).toEqual([]);
  });

  test("Orca needs no separate scheduler choice and partial answers are retained", async () => {
    const result = await run(["setup", "--host", "orca", "--project", "my-app"], ["linear", "example/app"]);
    expect(result.code).toBe(0);
    expect(result.asked).toEqual(["connector", "repo"]);
    expect(result.out.join("\n")).toContain("Orca");
  });

  test("invalid choice retries; cancellation produces no plan", async () => {
    const retry = await run(["setup"], ["99", "q"]);
    expect(retry.code).toBe(130);
    expect(retry.asked).toEqual(["host", "host"]);
    expect(retry.out).toEqual([]);
    const eof = await run(["setup"], [null]);
    expect(eof.code).toBe(130);
    expect(eof.out).toEqual([]);
  });

  test("JSON and noninteractive callers never wait for prompts", async () => {
    for (const args of [["setup"], ["setup", "--json"]]) {
      const result = await run(args);
      expect(result.code).toBe(2);
      expect(result.asked).toEqual([]);
      expect(result.out).toEqual([]);
    }
    const result = await run([
      "setup",
      "--host",
      "codex",
      "--connector",
      "linear",
      "--project",
      "my-app",
      "--repo",
      "example/app",
      "--scheduler",
      "orca",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(result.asked).toEqual([]);
    expect(result.err).toEqual([]);
    expect(JSON.parse(result.out[0] ?? "{}")).toMatchObject({
      readOnly: true,
      operatorHarness: "codex",
      schedule: { created: false, observed: null },
    });
  });

  test("agent question contract works without configuration or prompts", async () => {
    const result = await run(["setup", "--questions", "--json"]);
    expect(result.code).toBe(0);
    expect(result.asked).toEqual([]);
    expect(JSON.parse(result.out[0] ?? "{}")).toMatchObject({
      format: "wingmate-setup-questions/v1",
      readOnly: true,
      questions: expect.any(Array),
    });
    const questions = JSON.parse(result.out[0] ?? "{}").questions;
    const native = questions.find((q: { id: string }) => q.id === "scheduler").options[1];
    expect(native.labelsByHost["claude-code"]).toContain("cloud routines");
    expect(native.labelsByHost.codex).toContain("desktop scheduled tasks");
  });

  test("malformed input and flags fail without producing a plan", async () => {
    for (const args of [
      ["setup", "extra"],
      ["setup", "--enable"],
      ["setup", "--questions", "--host", "orca"],
      ["setup", "--host", "orca", "--host", "codex"],
      ["setup", "--json=false"],
      [
        "setup",
        "--host",
        "orca",
        "--connector",
        "jira",
        "--project",
        "app",
        "--repo",
        "example/app",
        "--json",
      ],
      [
        "setup",
        "--host",
        "orca",
        "--connector",
        "linear",
        "--project",
        "$(touch bad)",
        "--repo",
        "example/app",
        "--json",
      ],
    ]) {
      const result = await run(args);
      expect(result.code).toBe(2);
      expect(result.asked).toEqual([]);
      expect(result.out).toEqual([]);
    }
  });
});

test("only bare interactive invocation starts setup; workers and help retain their route", async () => {
  const called: string[] = [];
  const deps = {
    interactive: true,
    out: () => {},
    err: () => {},
    handlers: Object.fromEntries(
      ["setup", "tick", "issue"].map((name) => [
        name,
        async () => async () => {
          called.push(name);
          return 0;
        },
      ]),
    ),
  };
  expect(await main([], deps)).toBe(0);
  expect(await main(["tick", "--precheck"], deps)).toBe(0);
  expect(await main(["issue", "TEST-1", "heartbeat"], deps)).toBe(0);
  expect(await main(["--help"], deps)).toBe(0);
  expect(await main([], { ...deps, interactive: false })).toBe(2);
  expect(called).toEqual(["setup", "tick", "issue"]);
});
