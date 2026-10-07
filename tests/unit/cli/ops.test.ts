// tests/unit/cli/ops.test.ts — the operator commands' CLI: strict flags (usage errors exit 2), what they pass on, what they print
// (identifiers and codes, never a secret or ticket text) and their exit codes. Contexts are the fake world; nothing live runs.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorCommand } from "../../../src/cli/commands/doctor";
import { installCommand } from "../../../src/cli/commands/install";
import { pauseCommand } from "../../../src/cli/commands/pause";
import { statusCommand } from "../../../src/cli/commands/status";
import { stopCommand } from "../../../src/cli/commands/stop";
import { main, parseArgv } from "../../../src/cli/index";
import { type OpsCtx, liveDoctorOptions } from "../../../src/cli/ops";
import { type RealCtxOptions, buildRealCtx } from "../../../src/cli/wire";
import type { InstallOptions, InstallResult } from "../../../src/ops/install";
import { readPause } from "../../../src/ops/pause";
import { WingmateError } from "../../../src/shared/errors";
import { VERSION } from "../../../src/shared/version";
import { stopRequested } from "../../../src/state/heartbeat";
import { readRecord } from "../../../src/state/records";
import { fakeExec } from "../../fakes/fakeExec";
import { type World, labeledByOwner, runTick, todo, world } from "../../sim/harness";

const SECRET_TITLE = "SECRET TITLE do-not-print";
function io(w: World, extra: Partial<OpsCtx> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const builds: RealCtxOptions[] = [];
  const ctx: OpsCtx = Object.assign(w.ctx, extra);
  return {
    out,
    err,
    builds,
    deps: {
      build: async (o: RealCtxOptions) => {
        builds.push(o);
        return ctx;
      },
      out: (l: string) => {
        out.push(l);
      },
      err: (l: string) => {
        err.push(l);
      },
      dirs: w.dirs,
      loadCfg: async () => w.cfg,
      now: () => w.ctx.now(),
    },
  };
}
const fakeResult = (o: Partial<InstallResult> = {}): InstallResult => ({
  version: "0.1.0",
  automationId: "auto-1",
  worktreeId: "repo-self::/wt/wingmate-dispatcher",
  binPath: "/s/bin/wingmate-0.1.0",
  sha256: "a".repeat(64),
  viewUrls: [],
  installedAt: "2026-10-06T10:00:00.000Z",
  enabled: false,
  viewsError: null,
  ...o,
});

describe("wingmate install (CLI)", () => {
  test("flags are strict; the client secret is passed on but never printed; views and doctor are wired", async () => {
    const w = await world();
    const t = io(w, { graphql: { query: async () => ({}) as never } });
    for (const bad of [
      ["install", "--enable=yes"],
      ["install", "--client-id", "x"],
      ["install", "--bogus"],
      ["install", "uninstall"],
      ["install", "--client-id", "a", "--client-id", "b", "--client-secret", "s"],
    ])
      expect(await installCommand(parseArgv(bad), t.deps)).toBe(2);
    expect(t.builds).toEqual([]); // usage errors build nothing
    let seen: InstallOptions | null = null;
    const code = await installCommand(
      parseArgv(["install", "--client-id", "cid", "--client-secret", "sekrit-value"]),
      {
        ...t.deps,
        install: async (_ctx, o) => {
          seen = o;
          return fakeResult();
        },
      },
    );
    expect(code).toBe(0);
    expect(t.builds).toEqual([{ readOnly: false, linearOptional: true }]);
    const o = seen as InstallOptions | null;
    expect(o).toMatchObject({ enable: false, clientId: "cid", clientSecret: "sekrit-value" });
    expect(typeof o?.views).toBe("function");
    expect(typeof o?.doctor).toBe("function");
    const printed = t.out.join("\n");
    expect(printed).not.toContain("sekrit-value");
    expect(printed).toContain("automation  auto-1 (disabled)");
    expect(printed).toContain("Favorite both views"); // the manual recipe when no view was written
  });
  test("a failing doctor on --enable exits 1 with the failing checks; --json prints the state", async () => {
    const w = await world();
    const t = io(w);
    const failed = await installCommand(parseArgv(["install", "--enable"]), {
      ...t.deps,
      install: async () => {
        throw new WingmateError(
          "doctor_failed",
          "doctor_failed: blocking checks failed (notify_test); the automation stays disabled",
          "fix them",
        );
      },
    });
    expect(failed).toBe(1);
    expect(t.err.join("\n")).toContain("blocking checks failed (notify_test)");
    expect(t.err.join("\n").match(/doctor_failed/g)?.length).toBe(1);
    const json = await installCommand(parseArgv(["install", "--json"]), {
      ...t.deps,
      install: async () => fakeResult({ viewUrls: ["https://linear.app/jrf/view/x"] }),
    });
    expect(json).toBe(0);
    expect(JSON.parse(t.out.at(-1) ?? "{}")).toMatchObject({
      automationId: "auto-1",
      viewUrls: ["https://linear.app/jrf/view/x"],
    });
  });
});

describe("wingmate doctor (CLI)", () => {
  const overrides = {
    exec: fakeExec().exec,
    versions: async () => ({ claude: "2.1.291", codex: null }),
    tokenExpiresAt: async () => "2026-11-01T00:00:00.000Z",
  };
  test("--quick skips the probes; the table prints ok/FAIL/warn per check; exit 1 while a blocking check fails", async () => {
    const w = await world();
    const t = io(w);
    const code = await doctorCommand(parseArgv(["doctor", "--quick"]), {
      ...t.deps,
      doctorOverrides: overrides,
    });
    expect(code).toBe(1); // not installed, notification test not run
    const text = t.out.join("\n");
    expect(text).toMatch(/^ok +config_valid/m);
    expect(text).toMatch(/^FAIL +binary_installed/m);
    expect(text).toMatch(/^warn +sandbox_probe +skipped \(--quick\)/m);
    expect(text.split("\n").at(-1)).toMatch(/^doctor: FAIL \(\d+ blocking\)$/);
    expect(JSON.parse(readFileSync(join(w.dirs.state, "doctor.json"), "utf8")).checks.length).toBeGreaterThan(
      10,
    );
  });
  test("--notify-test takes an identifier; --rotate stops everything, drops the cached token and prints the steps", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-561", { title: SECRET_TITLE }));
    await runTick(w);
    let invalidated = 0;
    const t = io(w, {
      tokens: {
        getToken: async () => "t",
        expiresAt: async () => null,
        invalidate: async () => {
          invalidated += 1;
        },
      },
    });
    expect(await doctorCommand(parseArgv(["doctor", "--notify-test", "not-an-id"]), t.deps)).toBe(2);
    expect(await doctorCommand(parseArgv(["doctor", "--rotate", "--quick"]), t.deps)).toBe(2);
    expect(await doctorCommand(parseArgv(["doctor", "--rotate"]), t.deps)).toBe(0);
    expect(invalidated).toBe(1);
    expect((await readRecord(w.dirs, "JRF-561"))?.history.at(-1)).toMatchObject({
      to: "blocked",
      cause: "owner_stop",
    });
    const text = t.out.join("\n");
    expect(text).toContain("stopped: JRF-561");
    expect(text).toContain("rotate the client secret");
    expect(text).not.toContain(SECRET_TITLE);
  });
});

describe("wingmate stop (CLI)", () => {
  test("exactly one scope; an issue must be an identifier and a project a configured key", async () => {
    const w = await world();
    const t = io(w);
    for (const bad of [
      ["stop"],
      ["stop", "--all", "--issue", "JRF-1"],
      ["stop", "--issue", "jrf one"],
      ["stop", "--all=true"],
      ["stop", "--issue"],
    ])
      expect(await stopCommand(parseArgv(bad), t.deps)).toBe(2);
    expect(t.builds).toEqual([]);
    expect(await stopCommand(parseArgv(["stop", "--project", "nope"]), t.deps)).toBe(2);
    expect(t.err.at(-1)).toContain("unknown project nope");
    expect(t.builds).toEqual([]); // refused from the config alone: nothing built, no flag written
    expect(await stopRequested(w.dirs)).toBe(false);
  });
  test("F2: the stop flag is on disk before the live context (Linear, Orca) is built — every scope, and doctor --rotate", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-564"));
    await runTick(w);
    const t = io(w);
    const flagAtBuild: boolean[] = [];
    const deps = {
      ...t.deps,
      build: async (o: RealCtxOptions) => {
        // what a running tick checks for this issue: a slow Linear read here never delays the kill switch
        flagAtBuild.push(await stopRequested(w.dirs, "bouncr", "JRF-564"));
        return t.deps.build(o);
      },
    };
    expect(await stopCommand(parseArgv(["stop", "--issue", "JRF-564"]), deps)).toBe(0);
    expect(await stopCommand(parseArgv(["stop", "--project", "bouncr"]), deps)).toBe(0);
    expect(await stopCommand(parseArgv(["stop", "--all"]), deps)).toBe(0);
    expect(await doctorCommand(parseArgv(["doctor", "--rotate"]), deps)).toBe(0);
    expect(flagAtBuild).toEqual([true, true, true, true]);
    expect(await stopRequested(w.dirs, "bouncr", "JRF-564")).toBe(false); // each run released its own entry
    expect((await readRecord(w.dirs, "JRF-564"))?.history.at(-1)).toMatchObject({
      to: "blocked",
      cause: "owner_stop",
    });
    // the ledgered stop names the entry the CLI wrote (one entry per run, never a second one)
    const stops = readFileSync(join(w.dirs.ledger, "global.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string; data: { flagCleared: boolean } })
      .filter((e) => e.type === "stop");
    expect(stops.map((e) => e.data.flagCleared)).toEqual([true, true, true, true]);
  });
  test("F2: when the live context cannot be built the flag stays set (ticks stay stopped) and the owner is told", async () => {
    const w = await world();
    const t = io(w);
    const deps = {
      ...t.deps,
      build: async () => {
        throw new WingmateError("config_invalid", "broken");
      },
    };
    await expect(stopCommand(parseArgv(["stop", "--all"]), deps)).rejects.toThrow(/broken/);
    expect(await stopRequested(w.dirs)).toBe(true);
    expect(t.err.join("\n")).toContain("stop flag KEPT");
  });
  test("--issue blocks that record (exit 0) and prints identifiers only; --json prints the report", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-562", { title: SECRET_TITLE }));
    await runTick(w);
    const t = io(w);
    expect(await stopCommand(parseArgv(["stop", "--issue", "JRF-562", "--reason", "drill"]), t.deps)).toBe(0);
    expect(t.builds).toEqual([{ readOnly: false, linearOptional: true }]);
    expect(t.out.join("\n")).toContain("stopped (blocked owner_stop): JRF-562");
    expect(t.out.join("\n")).not.toContain(SECRET_TITLE);
    expect(await stopCommand(parseArgv(["stop", "--all", "--json"]), t.deps)).toBe(0);
    expect(JSON.parse(t.out.at(-1) ?? "{}")).toMatchObject({
      scope: { kind: "all" },
      stopped: [],
      flagCleared: true,
    });
  });
});

describe("wingmate pause / resume (CLI)", () => {
  test("pause, pause --project, resume --project, pause --off and resume; unknown projects refused; each change ledgered", async () => {
    const w = await world();
    const t = io(w);
    expect(await pauseCommand(parseArgv(["pause"]), t.deps)).toBe(0);
    expect(await pauseCommand(parseArgv(["pause", "--project", "bouncr"]), t.deps)).toBe(0);
    expect(await readPause(w.dirs)).toEqual(["bouncr", "global"]);
    expect(await pauseCommand(parseArgv(["resume", "--project", "bouncr"]), t.deps)).toBe(0);
    expect(await pauseCommand(parseArgv(["pause", "--off"]), t.deps)).toBe(0);
    expect(await readPause(w.dirs)).toEqual([]);
    expect(t.out.at(-1)).toBe("nothing paused");
    expect(await pauseCommand(parseArgv(["pause", "--project", "nope"]), t.deps)).toBe(2);
    expect(await pauseCommand(parseArgv(["pause", "--project", "global"]), t.deps)).toBe(2);
    expect(await pauseCommand(parseArgv(["resume", "--off"]), t.deps)).toBe(2);
    const ledger = readFileSync(join(w.dirs.ledger, "global.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string; data: { scope: string } })
      .filter((e) => e.type === "pause" || e.type === "resume")
      .map((e) => `${e.type}:${e.data.scope}`);
    expect(ledger).toEqual(["pause:global", "pause:bouncr", "resume:bouncr", "resume:global"]);
  });
});

describe("wingmate status (CLI)", () => {
  test("markdown by default, --json on request, never both; no title or description is printed", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-563", { title: SECRET_TITLE, description: "ticket text body" }));
    await runTick(w);
    const t = io(w);
    expect(await statusCommand(parseArgv(["status", "--json", "--md"]), t.deps)).toBe(2);
    expect(await statusCommand(parseArgv(["status", "--project", "nope"]), t.deps)).toBe(2);
    expect(await statusCommand(parseArgv(["status", "--cost"]), t.deps)).toBe(0);
    const md = t.out.at(-1) ?? "";
    expect(md).toContain("JRF-563");
    expect(md).toContain("### Cost (7 days");
    expect(await statusCommand(parseArgv(["status", "--json", "--project", "bouncr"]), t.deps)).toBe(0);
    const json = t.out.at(-1) ?? "";
    expect(JSON.parse(json).issues.map((i: { identifier: string }) => i.identifier)).toEqual(["JRF-563"]);
    for (const text of [md, json]) {
      expect(text).not.toContain(SECRET_TITLE);
      expect(text).not.toContain("ticket text body");
    }
  });
});

describe("main() knows the operator commands", () => {
  test("an unknown command lists install, doctor, stop, pause, resume and status", async () => {
    const orig = process.stderr.write.bind(process.stderr);
    const err: string[] = [];
    process.stderr.write = ((s: string) => {
      err.push(String(s));
      return true;
    }) as typeof process.stderr.write;
    let code: number;
    try {
      code = await main(["frobnicate"]);
    } finally {
      process.stderr.write = orig;
    }
    expect(code).toBe(2);
    for (const c of ["install", "doctor", "stop", "pause", "resume", "status"])
      expect(err.join("")).toContain(c);
  });
});

describe("buildRealCtx({ linearOptional })", () => {
  test("builds while Linear cannot be read (no app credentials yet): empty team metadata and the code; without it, refuses", async () => {
    const root = mkdtempSync(join(tmpdir(), "wm-wire-"));
    const keys = ["WINGMATE_HOME", "WINGMATE_CONFIG_HOME", "HOME", "HOMEBREW_PREFIX"] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    Object.assign(process.env, {
      WINGMATE_HOME: root,
      WINGMATE_CONFIG_HOME: root,
      HOME: root,
      HOMEBREW_PREFIX: "/opt/homebrew",
    });
    try {
      // no credentials.json: the token read fails before any request is made, so nothing reaches the network
      const ctx = await buildRealCtx({ readOnly: false, linearOptional: true });
      expect(ctx.linearDown).toBe("linear_credentials_missing");
      expect(ctx.meta.labels).toEqual([]);
      expect(ctx.dirs.state).toBe(root);
      await expect(buildRealCtx({ readOnly: false })).rejects.toMatchObject({
        code: "linear_credentials_missing",
      });
    } finally {
      for (const k of keys) {
        const v = saved[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("liveDoctorOptions", () => {
  test("probes on, this CLI's version, and the token minted (getToken) before its expiry is read", async () => {
    const w = await world();
    const order: string[] = [];
    const o = liveDoctorOptions(
      Object.assign(
        { ...w.ctx },
        {
          tokens: {
            getToken: async () => {
              order.push("getToken");
              return "t";
            },
            expiresAt: async () => {
              order.push("expiresAt");
              return "2026-11-01T00:00:00.000Z";
            },
            invalidate: async () => undefined,
          },
        },
      ),
      { probes: false },
    );
    expect(o).toMatchObject({ probes: false, version: VERSION });
    expect(await o.tokenExpiresAt?.()).toBe("2026-11-01T00:00:00.000Z");
    expect(order).toEqual(["getToken", "expiresAt"]);
    expect(liveDoctorOptions(w.ctx).tokenExpiresAt).toBeUndefined();
  });
});
