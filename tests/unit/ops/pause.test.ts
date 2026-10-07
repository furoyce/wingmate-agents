// tests/unit/ops/pause.test.ts — pause.json is the string array reconcile reads (§6.7, §13.3 i); resume removes a scope.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPause, setPause } from "../../../src/ops/pause";
import { labeledByOwner, runTick, todo, world } from "../../sim/harness";

describe("pause/resume", () => {
  test("global pause → reconcile-only ticks with no claims; resume → claims again", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-801"));
    expect(await setPause(w.dirs, "global", true)).toEqual(["global"]);
    let s = await runTick(w);
    expect(s.outcome).toBe("paused");
    expect(s.claims).toEqual([]);
    expect(await setPause(w.dirs, "global", false)).toEqual([]);
    s = await runTick(w);
    expect(s.claims).toEqual(["JRF-801"]);
  });
  test("project pause skips only that project's candidates", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-802"));
    labeledByOwner(w, todo("i2", "JRF-803", { projectId: "a0d17ec1-b237-4481-9efb-1eff9fe69efe" }));
    await setPause(w.dirs, "bouncr", true);
    const s = await runTick(w);
    expect(s.claims).toEqual(["JRF-803"]);
    expect(s.skipped.find((x) => x.identifier === "JRF-802")?.reason).toBe("paused");
  });
});

describe("pause.json", () => {
  test("a sorted, de-duplicated string array; a file that is not one is refused with its path, as every tick refuses it", async () => {
    const w = await world();
    await setPause(w.dirs, "smart-dispatcher", true);
    await setPause(w.dirs, "bouncr", true);
    expect(await setPause(w.dirs, "bouncr", true)).toEqual(["bouncr", "smart-dispatcher"]);
    expect(JSON.parse(readFileSync(join(w.dirs.state, "pause.json"), "utf8"))).toEqual([
      "bouncr",
      "smart-dispatcher",
    ]);
    writeFileSync(join(w.dirs.state, "pause.json"), JSON.stringify({ global: true }));
    await expect(readPause(w.dirs)).rejects.toThrow(/pause\.json is not an array/);
    writeFileSync(join(w.dirs.state, "pause.json"), "[nope");
    await expect(setPause(w.dirs, "global", false)).rejects.toThrow(/not JSON/);
    await expect(setPause(w.dirs, "", true)).rejects.toThrow(/scope/);
  });
  test("a project pause makes that project's records reconcile-only: no relaunch while paused", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-804"));
    await runTick(w);
    await setPause(w.dirs, "bouncr", true);
    const { readRecord } = await import("../../../src/state/records");
    const r = await readRecord(w.dirs, "JRF-804");
    w.orca.killTerminal(r?.worktree?.id ?? "", r?.coordinator.terminalHandle ?? "");
    const launches = () => w.orca.calls.filter((c) => c.verb === "terminalCreate").length;
    const n = launches();
    w.clock.advance(5 * 60_000);
    const s = await runTick(w);
    expect(s.relaunches).toEqual([]);
    expect(launches()).toBe(n);
    await setPause(w.dirs, "bouncr", false);
    w.clock.advance(5 * 60_000);
    expect((await runTick(w)).relaunches).toEqual(["JRF-804"]);
  });
});
