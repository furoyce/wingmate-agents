// tests/unit/cli/ui.test.ts — Unit tests for `wingmate ui` CLI command.
import { describe, expect, test } from "bun:test";
import { uiCommand } from "../../../src/cli/commands/ui";
import { parseArgv } from "../../../src/cli/index";

describe("wingmate ui command", () => {
  test("rejects invalid port option", async () => {
    const errs: string[] = [];
    const code = await uiCommand(parseArgv(["ui", "--port", "abc"]), {
      err: (s) => errs.push(s),
    });
    expect(code).toBe(2);
    expect(errs.join(" ")).toContain("--port must be an integer");
  });

  test("rejects out-of-range port option", async () => {
    const errs: string[] = [];
    const code = await uiCommand(parseArgv(["ui", "--port", "99999"]), {
      err: (s) => errs.push(s),
    });
    expect(code).toBe(2);
    expect(errs.join(" ")).toContain("--port must be between 1024 and 65535");
  });

  test("rejects invalid open target", async () => {
    const errs: string[] = [];
    const code = await uiCommand(parseArgv(["ui", "--open", "invalid_app"]), {
      err: (s) => errs.push(s),
    });
    expect(code).toBe(2);
    expect(errs.join(" ")).toContain('--open must be "orca" or "browser"');
  });

  test("starts server and opens target when valid flags passed", async () => {
    const logs: string[] = [];
    let opened: { target: string; url: string } | null = null;
    let stopped = false;

    process.env.WINGMATE_TEST_EXIT = "1";
    try {
      const code = await uiCommand(parseArgv(["ui", "--port", "5050", "--open", "browser"]), {
        out: (s) => logs.push(s),
        start: async (opts) => ({
          port: opts?.port ?? 5050,
          url: `http://127.0.0.1:${opts?.port ?? 5050}`,
          stop: () => {
            stopped = true;
          },
        }),
        openTarget: (target, url) => {
          opened = { target, url };
        },
      });

      expect(code).toBe(0);
      expect(logs.join(" ")).toContain("Wingmate Console listening at http://127.0.0.1:5050");
      expect(opened as unknown).toEqual({ target: "browser", url: "http://127.0.0.1:5050" });
      expect(stopped).toBe(true);
    } finally {
      process.env.WINGMATE_TEST_EXIT = undefined;
    }
  });
});
