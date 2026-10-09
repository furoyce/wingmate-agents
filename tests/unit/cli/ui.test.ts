// tests/unit/cli/ui.test.ts — Unit tests for `wingmate ui` CLI command.
import { describe, expect, test } from "bun:test";
import { openConsole, uiCommand } from "../../../src/cli/commands/ui";
import { parseArgv } from "../../../src/cli/index";
import type { Launcher } from "../../../src/server";

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

describe("openConsole", () => {
  // -1 stands for "executable not found" (ENOENT).
  const run = async (codes: number[], target: "orca" | "browser") => {
    const calls: { cmd: string; args: string[] }[] = [];
    const launch: Launcher = async (cmd, args) => {
      calls.push({ cmd, args });
      const code = codes[calls.length - 1] ?? 1;
      if (code === -1) return { code: null, error: "spawn ENOENT", missing: true };
      return { code, error: code === 0 ? null : "failed" };
    };
    const out: string[] = [];
    const err: string[] = [];
    const ok = await openConsole(
      target,
      "http://127.0.0.1:4848",
      launch,
      (s) => out.push(s),
      (s) => err.push(s),
    );
    return { ok, calls, out, err };
  };

  test("opens the bare URL (no token) and reports success only after an exit-0 launch", async () => {
    const orca = await run([0], "orca");
    expect(orca.ok).toBe(true);
    expect(orca.calls).toEqual([{ cmd: "orca", args: ["tab", "create", "--url", "http://127.0.0.1:4848"] }]);
    expect(orca.out).toEqual(["Opened http://127.0.0.1:4848 in an Orca browser tab"]);

    // A failed (possibly late-acting) Orca launch is not duplicated by the system browser.
    const orcaFailed = await run([1, 0], "orca");
    expect(orcaFailed.ok).toBe(false);
    expect(orcaFailed.calls.map((c) => c.cmd)).toEqual(["orca"]);
    expect(orcaFailed.err[0]).toContain("open http://127.0.0.1:4848 manually");

    const fallback = await run([-1, 0], "orca");
    expect(fallback.ok).toBe(true);
    expect(fallback.calls.map((c) => c.cmd)).toEqual(["orca", "open"]);
    expect(fallback.err[0]).toBe("Orca CLI not found; trying the system browser");

    const failed = await run([1], "browser");
    expect(failed.ok).toBe(false);
    expect(failed.out).toEqual([]);
    expect(failed.err).toEqual(["Could not open the Console (failed); open http://127.0.0.1:4848 manually"]);
  });
});
