// tests/unit/cli/tick.test.ts — `wingmate tick` / `scan`: schema-validated stdout (identifiers and codes only), exit codes, flags;
// main() reports every unexpected error as `code: message`, exit 2
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanCommand } from "../../../src/cli/commands/scan";
import { SummarySchema, tickCommand } from "../../../src/cli/commands/tick";
import { main, parseArgv, reportError } from "../../../src/cli/index";
import type { Ctx } from "../../../src/machine/context";
import { tickBudgetMs } from "../../../src/machine/tick";
import { OrcaError } from "../../../src/orca/cli";
import { WingmateError } from "../../../src/shared/errors";
import { listRecords } from "../../../src/state/records";
import { addLabeledByOwner, todo } from "../../fakes/issues";
import { type World, makeWorld } from "../../fakes/world";

function deps(w: World | null, fail?: unknown) {
  const lines: string[] = [];
  const readOnly: boolean[] = [];
  return {
    lines,
    readOnly,
    d: {
      build: async (o: { readOnly: boolean }): Promise<Ctx> => {
        readOnly.push(o.readOnly);
        if (fail !== undefined || !w) throw fail;
        return w.ctx;
      },
      out: (line: string) => {
        lines.push(line);
      },
    },
  };
}
const SECRET_TITLE = "SECRET TITLE do-not-print";

describe("wingmate tick", () => {
  test("prints the schema-validated summary (identifiers and codes only) and exits 1 after acting", async () => {
    const w = await makeWorld();
    addLabeledByOwner(w.linear, todo("i1", "JRF-501", { title: SECRET_TITLE, description: "ticket text" }));
    const { d, lines, readOnly } = deps(w);
    expect(await tickCommand(parseArgv(["tick", "--precheck"]), d)).toBe(1);
    expect(readOnly).toEqual([false]);
    expect(lines).toHaveLength(1);
    const printed = SummarySchema.parse(JSON.parse(lines[0] ?? ""));
    expect(printed).toMatchObject({ outcome: "work", claims: ["JRF-501"] });
    expect(lines[0]).not.toContain("SECRET");
    expect(lines[0]).not.toContain("ticket text");
  });

  test("REL-1: the tick's deadline counts from the command's start, so a slow context build leaves no time to claim (tick_budget)", async () => {
    const w = await makeWorld();
    addLabeledByOwner(w.linear, todo("i1", "JRF-501"));
    const real = Date.now;
    let wall = real();
    Date.now = () => wall;
    try {
      const { d, lines } = deps(w);
      const build = d.build;
      d.build = async (o) => {
        wall += 150_000; // the token mint and team read took 150 s of the 180 s budget
        return build(o);
      };
      expect(await tickCommand(parseArgv(["tick", "--precheck"]), d)).toBe(1);
      const printed = SummarySchema.parse(JSON.parse(lines[0] ?? ""));
      expect(printed.claims).toEqual([]);
      expect(printed.skipped).toContainEqual({ identifier: "JRF-501", reason: "tick_budget" });
    } finally {
      Date.now = real;
    }
    expect(await listRecords(w.dirs)).toEqual([]);
  });

  test("REL-1: the tick's budget is the precheck timeout less 60 s (§4.3's 180 s by default), never under 30 s", () => {
    const cfg = (precheckTimeoutSec: number) =>
      ({ defaults: { dispatcher: { precheckTimeoutSec } } }) as Parameters<typeof tickBudgetMs>[0];
    expect([240, 300, 60].map((t) => tickBudgetMs(cfg(t)))).toEqual([180_000, 240_000, 30_000]);
  });

  test("--dry-run builds a read-only context and changes nothing", async () => {
    const w = await makeWorld();
    addLabeledByOwner(w.linear, todo("i1", "JRF-501"));
    const { d, lines, readOnly } = deps(w);
    expect(await tickCommand(parseArgv(["tick", "--dry-run"]), d)).toBe(1);
    expect(readOnly).toEqual([true]);
    expect(JSON.parse(lines[0] ?? "").claims).toEqual(["JRF-501"]);
    expect(await listRecords(w.dirs)).toEqual([]);
    expect(w.linear.writes).toEqual([]);
  });

  test("a context that cannot be built prints { outcome: error, reason: <code> } and exits 2", async () => {
    const a = deps(null, new WingmateError("linear_credentials_missing", "no credentials.json at /x"));
    expect(await tickCommand(parseArgv(["tick", "--precheck"]), a.d)).toBe(2);
    expect(JSON.parse(a.lines[0] ?? "")).toEqual({ outcome: "error", reason: "linear_credentials_missing" });
    const b = deps(null, new Error("boom with details"));
    expect(await tickCommand(parseArgv(["tick"]), b.d)).toBe(2);
    expect(b.lines[0]).toBe('{"outcome":"error","reason":"internal_error"}');
  });

  test("exit codes: paused → 2 (§4.3), a lock held by another tick → 1", async () => {
    const paused = await makeWorld();
    writeFileSync(join(paused.dirs.state, "pause.json"), JSON.stringify(["global"]));
    const p = deps(paused);
    expect(await tickCommand(parseArgv(["tick", "--precheck"]), p.d)).toBe(2);
    expect(JSON.parse(p.lines[0] ?? "").outcome).toBe("paused");
    const held = await makeWorld();
    writeFileSync(
      join(held.dirs.state, "tick.lock"),
      JSON.stringify({
        pid: process.pid,
        startedAt: held.ctx.now(),
        token: "t",
        heartbeatAt: held.ctx.now(),
      }),
    );
    const h = deps(held);
    expect(await tickCommand(parseArgv(["tick", "--precheck"]), h.d)).toBe(1);
    expect(JSON.parse(h.lines[0] ?? "")).toMatchObject({ outcome: "lock_held", reason: null });
  });

  test("F10: the summary's quota field is closed — provider names, the enum code quota_stale and a whole number of minutes only", async () => {
    const w = await makeWorld();
    const { d, lines } = deps(w);
    await tickCommand(parseArgv(["tick", "--precheck"]), d);
    const printed = SummarySchema.parse(JSON.parse(lines[0] ?? ""));
    expect(printed.quota).toEqual({});
    const withQuota = (quota: unknown) => SummarySchema.safeParse({ ...printed, quota }).success;
    expect(withQuota({ claude: { attention: ["quota_stale"], ageMin: 420 } })).toBe(true);
    expect(withQuota({ claude: { attention: ["quota_stale(claude, 420)"], ageMin: 420 } })).toBe(false);
    expect(withQuota({ "SECRET TITLE": { attention: ["quota_stale"], ageMin: 1 } })).toBe(false);
    expect(withQuota({ claude: { attention: ["quota_stale"], ageMin: "420" } })).toBe(false);
    expect(withQuota({ claude: { attention: [], ageMin: 1 } })).toBe(false);
    expect(withQuota({ claude: { attention: ["quota_stale"], ageMin: 1, note: "x" } })).toBe(false);
    const { quota: _drop, ...without } = printed;
    expect(SummarySchema.safeParse(without).success).toBe(false); // every summary says it, empty or not
  });

  test("a valued or repeated-with-a-value --dry-run/--precheck is a usage error (exit 2), never a guess", async () => {
    const w = await makeWorld();
    const { d, readOnly } = deps(w);
    expect(await tickCommand(parseArgv(["tick", "--dry-run=yes"]), d)).toBe(2);
    expect(await tickCommand(parseArgv(["tick", "--dry-run", "a", "--dry-run", "b"]), d)).toBe(2);
    expect(readOnly).toEqual([]);
  });
});

describe("wingmate scan", () => {
  test("exit 0 when a tick would act, 1 when idle; always a read-only context", async () => {
    const w = await makeWorld();
    addLabeledByOwner(w.linear, todo("i1", "JRF-501"));
    const busy = deps(w);
    expect(await scanCommand(parseArgv(["scan"]), busy.d)).toBe(0);
    expect(busy.readOnly).toEqual([true]);
    expect(SummarySchema.parse(JSON.parse(busy.lines[0] ?? "")).claims).toEqual(["JRF-501"]);
    const idle = deps(await makeWorld());
    expect(await scanCommand(parseArgv(["scan"]), idle.d)).toBe(1);
  });
});

describe("strict tick and scan admission", () => {
  for (const [name, command] of [
    ["tick", tickCommand],
    ["scan", scanCommand],
  ] as const) {
    test(`${name} rejects unknown flags and extra words without building any context`, async () => {
      const { d, lines, readOnly } = deps(null);
      const errors: string[] = [];
      for (const args of [
        [name, "--prechek"],
        [name, "--bogus=value"],
        [name, "extra"],
        [name, "-h"],
        [name, "--", "--help"],
        [name, "--json=false"],
        [name, "--dry-run", "value"],
        [name, "--json=false", "--json"],
        [name, "--json", "--json=false"],
        [name, "--dry-run=no", "--dry-run", "--dry-run"],
      ]) {
        expect(await command(parseArgv(args), { ...d, err: (s) => errors.push(s) })).toBe(2);
      }
      expect(readOnly).toEqual([]);
      expect(lines).toEqual([]);
      expect(errors).toHaveLength(10);
    });
  }
});

describe("main", () => {
  test("every unexpected error is reported as `code: message` on stderr with exit 2 (no stack trace)", () => {
    const out: string[] = [];
    const write = (s: string) => {
      out.push(s);
    };
    expect(reportError(new WingmateError("config_missing", "no config", "create it"), write)).toBe(2);
    expect(reportError(new OrcaError("orca_timeout", "orca terminal wait timed out"), write)).toBe(2);
    expect(reportError(new TypeError("x is undefined"), write)).toBe(2);
    expect(reportError("weird", write)).toBe(2);
    expect(out).toEqual([
      "config_missing: no config\n  next: create it\n",
      "orca_timeout: orca terminal wait timed out\n",
      "internal_error: TypeError: x is undefined\n",
      "internal_error: weird\n",
    ]);
    expect(out.join("")).not.toContain("    at ");
  });
  test("tick and scan are registered next to issue and config", async () => {
    expect(await main(["no-such-command"])).toBe(2);
  });
});
