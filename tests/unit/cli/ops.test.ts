// tests/unit/cli/ops.test.ts — the operator commands' CLI: strict flags (usage errors exit 2), what they pass on, what they print
// (identifiers and codes, never a secret or ticket text) and their exit codes. Contexts are the fake world; nothing live runs.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROTATION_STEPS, doctorCommand } from "../../../src/cli/commands/doctor";
import { installCommand } from "../../../src/cli/commands/install";
import { pauseCommand } from "../../../src/cli/commands/pause";
import { statusCommand } from "../../../src/cli/commands/status";
import { FLAG_KEPT, NO_FLAG, flagLines, stopCommand } from "../../../src/cli/commands/stop";
import { main, parseArgv } from "../../../src/cli/index";
import { type OpsCtx, liveDoctorOptions, readStdinLine } from "../../../src/cli/ops";
import { type RealCtxOptions, buildRealCtx } from "../../../src/cli/wire";
import type { InstallOptions, InstallResult } from "../../../src/ops/install";
import { readPause } from "../../../src/ops/pause";
import type { StopEntry, StopReport } from "../../../src/ops/stop";
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
  repoSettings: [],
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

  test("R30 (Task 13 F7): install prints each pilot repo's core.useReplaceRefs=false outcome, and that doctor refuses --enable until a failed one is set", async () => {
    const w = await world();
    const t = io(w);
    const code = await installCommand(parseArgv(["install"]), {
      ...t.deps,
      install: async () =>
        fakeResult({
          repoSettings: [
            { repo: "bouncr/api", path: "/repos/api", outcome: "set", detail: null },
            { repo: "bouncr/web", path: "/repos/web", outcome: "unchanged", detail: null },
            { repo: "ehr/app", path: null, outcome: "failed", detail: "main checkout not in the fleet" },
          ],
        }),
    });
    expect(code).toBe(0);
    const text = t.out.join("\n");
    expect(text).toContain("core.useReplaceRefs=false");
    expect(text).toMatch(/bouncr\/api +set +\/repos\/api/);
    expect(text).toMatch(/bouncr\/web +unchanged +\/repos\/web/);
    expect(text).toMatch(/ehr\/app +NOT SET \(main checkout not in the fleet\)/);
    expect(text).toContain("replace_refs_disabled");
  });

  /** stdin as the CLI reads it, in chunks that need not end on a line boundary. */
  async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
    for (const p of parts) yield new TextEncoder().encode(p);
  }
  const captured = () => {
    let seen: InstallOptions | null = null;
    return {
      install: async (_ctx: OpsCtx, o: InstallOptions) => {
        seen = o;
        return fakeResult();
      },
      seen: () => seen as InstallOptions | null,
    };
  };

  test("C31: --client-secret - reads the secret from one line of stdin, so it never stands on the command line; nothing echoes it", async () => {
    const w = await world();
    const t = io(w);
    const cap = captured();
    const code = await installCommand(parseArgv(["install", "--client-id", "cid", "--client-secret", "-"]), {
      ...t.deps,
      stdin: chunks("sekrit-fr", "om-stdin\r\nsecond line, never read\n"),
      install: cap.install,
    });
    expect(code).toBe(0);
    expect(cap.seen()).toMatchObject({ clientId: "cid", clientSecret: "sekrit-from-stdin" });
    expect([...t.out, ...t.err].join("\n")).not.toContain("sekrit");
    expect(t.err).toEqual([]); // no warning: the secret was never on the command line
  });

  test("C31: a literal --client-secret still works, with a warning that it is visible in ps and the shell history (the secret itself is never printed)", async () => {
    const w = await world();
    const t = io(w);
    const cap = captured();
    const code = await installCommand(
      parseArgv(["install", "--client-id", "cid", "--client-secret", "sekrit-on-argv"]),
      { ...t.deps, install: cap.install },
    );
    expect(code).toBe(0);
    expect(cap.seen()).toMatchObject({ clientSecret: "sekrit-on-argv" });
    const warning = t.err.join("\n");
    expect(warning).toContain("ps");
    expect(warning).toContain("shell history");
    expect(warning).toContain("--client-secret -");
    expect([...t.out, ...t.err].join("\n")).not.toContain("sekrit-on-argv");
  });

  test("C31: --client-secret - with no line on stdin (or a blank one) is a usage error: nothing is built or installed", async () => {
    for (const stdin of [chunks(), chunks("\n"), chunks("   \r\n")]) {
      const w = await world();
      const t = io(w);
      const cap = captured();
      const code = await installCommand(
        parseArgv(["install", "--client-id", "cid", "--client-secret", "-"]),
        {
          ...t.deps,
          stdin,
          install: cap.install,
        },
      );
      expect(code).toBe(2);
      expect(t.err.join("\n")).toContain("stdin");
      expect(t.builds).toEqual([]);
      expect(cap.seen()).toBeNull();
    }
  });

  test("C31: readStdinLine returns the first line without its line ending, across chunk boundaries; the whole input when no newline comes", async () => {
    expect(await readStdinLine(chunks("ab", "c\nd\n"))).toBe("abc");
    expect(await readStdinLine(chunks("abc\r\n"))).toBe("abc");
    expect(await readStdinLine(chunks("no newline at all"))).toBe("no newline at all");
    expect(await readStdinLine(chunks())).toBe("");
    // no unbounded read: a first line past 4096 characters is no pasted secret
    await expect(readStdinLine(chunks("x".repeat(5000)))).rejects.toMatchObject({ code: "usage" });
  });

  test("C31: the usage, doctor's hint and the rotation steps give the secret on stdin (--client-secret -), never on the command line", async () => {
    const w = await world();
    const t = io(w);
    expect(await installCommand(parseArgv(["install", "--bogus"]), t.deps)).toBe(2);
    expect(t.err.join("\n")).toContain("--client-secret -");
    expect(ROTATION_STEPS.join("\n")).toContain("--client-secret -");
    expect(ROTATION_STEPS.join("\n")).not.toMatch(/--client-secret <|--client-secret …/);
    const d = io(w);
    await doctorCommand(parseArgv(["doctor", "--quick"]), {
      ...d.deps,
      doctorOverrides: {
        exec: fakeExec().exec,
        versions: async () => ({ claude: "2.1.291", codex: null }),
        tokenExpiresAt: async () => null,
      },
    });
    const auth = d.out.find((l) => /^FAIL +linear_auth/.test(l)) ?? "";
    expect(auth).toContain("--client-secret -");
  });

  test("F5 (§13.3 g): the rotation steps revoke the gh token — GitHub CLI's OAuth authorization, or a personal access token — then log in again; never `gh auth refresh`, which leaves the old token valid", () => {
    const gh = ROTATION_STEPS.find((s) => s.startsWith("4. GitHub")) ?? "";
    expect(gh).toContain("github.com/settings/applications");
    expect(gh).toContain("GitHub CLI → Revoke");
    expect(gh).toContain("github.com/settings/tokens");
    expect(gh).toContain("`gh auth login`");
    expect(ROTATION_STEPS.join("\n")).not.toContain("gh auth refresh");
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
  const brokenBuild = async (): Promise<OpsCtx> => {
    throw new WingmateError("internal_error", "build broke");
  };
  test("F8: the config is read before the flag for every scope — run where no config can be found, nothing is written or built", async () => {
    const w = await world();
    const t = io(w);
    // the default loader the live command uses (no loadCfg injected), with no config where it looks — as when run from another cwd
    const deps = { build: t.deps.build, out: t.deps.out, err: t.deps.err, dirs: w.dirs, now: t.deps.now };
    const key = "WINGMATE_CONFIG";
    const saved = process.env[key];
    process.env[key] = join(w.root, "no-such-dir", "projects.yaml");
    try {
      for (const args of [
        ["stop", "--all"],
        ["stop", "--issue", "JRF-1"],
        ["stop", "--project", "bouncr"],
      ])
        await expect(stopCommand(parseArgv(args), deps)).rejects.toMatchObject({ code: "config_missing" });
      await expect(doctorCommand(parseArgv(["doctor", "--rotate"]), deps)).rejects.toMatchObject({
        code: "config_missing",
      });
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
    expect(t.builds).toEqual([]);
    expect(existsSync(join(w.dirs.state, "stop-requested.json"))).toBe(false);
    expect(t.err).toEqual(Array(4).fill(NO_FLAG)); // the owner is told that nothing was stopped
  });
  test("F8: a stop whose live build failed keeps its flag; the re-run clears it (and every older entry it supersedes), so ticks run again", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-565"));
    await runTick(w);
    const t = io(w);
    const broken = { ...t.deps, build: brokenBuild };
    const stop = (args: string[]) => ["stop", ...args];
    for (const [failed, rerun] of [
      [stop(["--issue", "JRF-565"]), stop(["--issue", "JRF-565"])],
      [stop(["--project", "bouncr"]), stop(["--project", "bouncr"])],
      [stop(["--all"]), stop(["--all"])],
      [stop(["--issue", "JRF-565"]), stop(["--project", "bouncr"])], // a broader re-run covers it (the record is in bouncr)
      [stop(["--project", "bouncr"]), stop(["--all"])],
      [
        ["doctor", "--rotate"],
        ["doctor", "--rotate"],
      ],
    ] as const) {
      const command = failed[0] === "doctor" ? doctorCommand : stopCommand;
      await expect(command(parseArgv([...failed]), broken)).rejects.toThrow(/build broke/);
      expect(await stopRequested(w.dirs, "bouncr", "JRF-565")).toBe(true);
      expect(t.err.at(-1)).toBe(FLAG_KEPT);
      w.clock.advance(60_000);
      expect(await command(parseArgv([...rerun]), t.deps)).toBe(0);
      expect(t.out).toContain("stop flag cleared");
      expect(await stopRequested(w.dirs, "bouncr", "JRF-565")).toBe(false);
      expect(existsSync(join(w.dirs.state, "stop-requested.json"))).toBe(false);
      t.out.length = 0;
    }
    expect((await readRecord(w.dirs, "JRF-565"))?.stage).toBe("blocked");
    w.clock.advance(300_000);
    expect((await runTick(w)).outcome).not.toBe("stopped");
  });
  test('F8: "stop flag cleared" is never printed while another entry still holds the scope; a narrower stop never releases a broader one', async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-566"));
    await runTick(w);
    const t = io(w);
    await expect(
      stopCommand(parseArgv(["stop", "--all"]), { ...t.deps, build: brokenBuild }),
    ).rejects.toThrow(/build broke/);
    const orphan = w.ctx.now();
    w.clock.advance(60_000);
    expect(await stopCommand(parseArgv(["stop", "--project", "bouncr"]), t.deps)).toBe(1);
    expect(t.out).toContain("stopped (blocked owner_stop): JRF-566");
    expect(t.out).not.toContain("stop flag cleared");
    expect(t.out.at(-1)).toBe(
      `stop flag still held for this scope by wingmate stop --all (${orphan}): ticks stay stopped until that stop finishes; re-run it if it is no longer running`,
    );
    expect(await stopRequested(w.dirs, "bouncr")).toBe(true);
    expect(await stopCommand(parseArgv(["stop", "--issue", "JRF-566", "--json"]), t.deps)).toBe(1);
    expect(JSON.parse(t.out.at(-1) ?? "{}")).toMatchObject({
      flagCleared: false,
      heldBy: [{ scope: "all", at: orphan }],
    });
    expect(await stopCommand(parseArgv(["stop", "--all"]), t.deps)).toBe(0);
    expect(t.out.at(-1)).toBe("stop flag cleared");
    expect(await stopRequested(w.dirs)).toBe(false);
  });
  test("F8: flagLines says cleared only with no entry holding the scope; it names the stop's own kept entry and every other holder", () => {
    const own = { scope: "project" as const, key: "bouncr", at: "2026-10-06T10:00:00.000Z" };
    const all = { scope: "all" as const, at: "2026-10-06T09:00:00.000Z" };
    const issue = { scope: "issue" as const, key: "JRF-9", at: "2026-10-06T10:05:00.000Z" };
    const report = (heldBy: StopEntry[]): StopReport => ({
      scope: { kind: "project", key: "bouncr" },
      stopped: [],
      deferred: [],
      failed: [],
      unverifiable: [],
      sweptWorktrees: [],
      heldBy,
      flagCleared: heldBy.length === 0,
    });
    const held = (names: string) =>
      `stop flag still held for this scope by ${names}: ticks stay stopped until that stop finishes; re-run it if it is no longer running`;
    expect(flagLines(report([]), own)).toEqual(["stop flag cleared"]);
    expect(flagLines(report([own]), own)).toEqual([FLAG_KEPT]);
    expect(flagLines(report([all, own]), own)).toEqual([
      FLAG_KEPT,
      held("wingmate stop --all (2026-10-06T09:00:00.000Z)"),
    ]);
    expect(flagLines(report([all, issue]), own)).toEqual([
      held(
        "wingmate stop --all (2026-10-06T09:00:00.000Z), wingmate stop --issue JRF-9 (2026-10-06T10:05:00.000Z)",
      ),
    ]);
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
  test("builds while Linear cannot be read (no app credentials yet): empty team metadata and the code; without it, refuses (Task 13: linear_app_required)", async () => {
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
      // Task 13 (§11.1): a writing context without the app's credentials.json is refused before any read, never built
      await expect(buildRealCtx({ readOnly: false })).rejects.toMatchObject({
        code: "linear_app_required",
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
