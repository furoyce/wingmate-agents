// tests/unit/ops/status.test.ts — §13.2 `wingmate status`: dispatcher block, queue with skip reasons, per-issue rows, `--cost`;
// identifiers and enum codes only.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SummarySchema } from "../../../src/cli/commands/tick";
import { scan } from "../../../src/machine/scan";
import { setPause } from "../../../src/ops/pause";
import { renderStatusMd, statusReport } from "../../../src/ops/status";
import type { QuotaNotices } from "../../../src/policy/quota";
import { readHeartbeat, requestStop } from "../../../src/state/heartbeat";
import { readRecord, writeRecord } from "../../../src/state/records";
import { labeledByOwner, runTick, todo, world } from "../../sim/harness";

describe("status", () => {
  test("report lists the dispatcher block, queue reasons and per-issue rows; markdown contains identifiers only", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-901"));
    labeledByOwner(w, todo("i2", "JRF-902"));
    await runTick(w); // second one skipped: cap_project
    const rep = await statusReport(w.ctx);
    expect(rep.dispatcher?.outcome).toBe("work");
    expect(rep.issues.map((i) => i.identifier)).toEqual(["JRF-901"]);
    expect(rep.queue.find((q) => q.identifier === "JRF-902")?.reason).toBe("cap_project");
    const md = renderStatusMd(rep);
    expect(md).toContain("JRF-901");
    expect(md).toContain("cap_project");
    expect(md).not.toContain("iOS leaderboard");
  });
  test("--cost aggregates per provider and project with provenance split", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-903"));
    await runTick(w);
    const r = await readRecord(w.dirs, "JRF-903");
    if (!r) throw new Error("JRF-903 was not claimed");
    r.usage.bySession.push(
      {
        role: "coordinator",
        provider: "claude",
        sessionRef: "s1",
        tokens: 1000,
        costUsd: 0.5,
        agentMinutes: 10,
        provenance: "measured-transcript",
      },
      {
        role: "worker",
        provider: "codex",
        sessionRef: "s2",
        tokens: null,
        costUsd: null,
        agentMinutes: 7,
        provenance: "timed",
      },
    );
    await writeRecord(w.dirs, r);
    const rep = await statusReport(w.ctx, { cost: true });
    expect(rep.cost?.byProvider.claude?.costUsd).toBe(0.5);
    expect(rep.cost?.byProvider.codex?.agentMinutes).toBe(7);
    expect(rep.cost?.byProvenance["measured-transcript"]?.tokens).toBe(1000);
  });
});

describe("status — Task 13 F10: quota_stale per provider (§9.1, Review Focus 3)", () => {
  const STALE: QuotaNotices = { claude: { attention: ["quota_stale"], ageMin: 420 } };

  test("a stale quota snapshot still claims, and quota_stale shows per provider with its age in the tick summary, the heartbeat (tick and scan) and status (--json and Markdown)", async () => {
    const w = await world();
    const nowMs = Date.parse(w.ctx.now());
    const { claude, codex } = w.orca.rateLimits;
    if (!claude || !codex) throw new Error("rate limits missing");
    claude.updatedAt = nowMs - 7 * 3_600_000; // older than quota.maxSnapshotAgeMin (360 min)
    codex.updatedAt = nowMs - 5 * 60_000;
    labeledByOwner(w, todo("i1", "JRF-921"));
    const s = await runTick(w);
    expect(s.claims).toEqual(["JRF-921"]); // advisory, never a veto
    expect(s.quota).toEqual(STALE);
    expect(SummarySchema.parse(s).quota).toEqual(STALE); // the printed summary carries it under its closed schema
    expect((await readHeartbeat(w.dirs))?.quota).toEqual(STALE);
    const rep = await statusReport(w.ctx);
    expect(JSON.parse(JSON.stringify(rep)).dispatcher.quota).toEqual(STALE); // `status --json`
    expect(renderStatusMd(rep)).toContain("Quota: claude quota_stale (snapshot 420 min old)");
    const dry = await scan(w.ctx);
    expect(dry.summary.quota).toEqual(STALE);
    expect(await readHeartbeat(w.dirs)).toMatchObject({ kind: "scan", quota: STALE });
  });

  test("fresh snapshots record nothing: an empty quota object and no Quota line; a heartbeat written before F10 still parses", async () => {
    const w = await world();
    const nowMs = Date.parse(w.ctx.now());
    for (const p of Object.values(w.orca.rateLimits)) p.updatedAt = nowMs - 60_000;
    const s = await runTick(w);
    expect(s.quota).toEqual({});
    expect(renderStatusMd(await statusReport(w.ctx))).not.toContain("Quota:");
    const old = JSON.parse(readFileSync(join(w.dirs.state, "heartbeat.json"), "utf8"));
    old.quota = undefined;
    writeFileSync(join(w.dirs.state, "heartbeat.json"), JSON.stringify(old));
    expect((await statusReport(w.ctx)).dispatcher?.quota).toEqual({});
    expect((await statusReport(w.ctx)).problems).toEqual([]);
  });
});

describe("status — Task 12 coverage", () => {
  const usage = (provider: string, project: string, costUsd: number) => ({
    role: "coordinator",
    provider,
    sessionRef: `${project}-${provider}`,
    tokens: 100,
    costUsd,
    agentMinutes: 5,
    provenance: "timed" as const,
  });
  test("--cost counts archived records of the last 7 days, splits by project, and --project filters issues, queue and cost", async () => {
    const w = await world();
    const smart = w.cfg.projects["smart-dispatcher"]?.repos.main;
    if (smart) smart.setup = "none";
    labeledByOwner(w, todo("i1", "JRF-911"));
    labeledByOwner(w, todo("i2", "JRF-912", { projectId: "a0d17ec1-b237-4481-9efb-1eff9fe69efe" }));
    await runTick(w);
    const a = await readRecord(w.dirs, "JRF-911");
    const b = await readRecord(w.dirs, "JRF-912");
    if (!a || !b) throw new Error("not claimed");
    a.usage.bySession.push(usage("claude", "bouncr", 1));
    b.usage.bySession.push(usage("claude", "smart", 2));
    await writeRecord(w.dirs, a);
    await writeRecord(w.dirs, b);
    mkdirSync(w.dirs.archive, { recursive: true });
    const old = structuredClone(a);
    old.cycle = 1;
    old.stage = "done";
    old.usage.bySession = [usage("codex", "bouncr", 4)];
    writeFileSync(join(w.dirs.archive, "JRF-911.1.json"), JSON.stringify(old));
    const stale = structuredClone(old);
    stale.updatedAt = "2026-09-01T00:00:00.000Z"; // older than 7 days: not counted
    stale.usage.bySession = [usage("codex", "bouncr", 100)];
    writeFileSync(join(w.dirs.archive, "JRF-911.0.json"), JSON.stringify({ ...stale, cycle: 1 }));
    const all = await statusReport(w.ctx, { cost: true });
    expect(all.cost?.total.costUsd).toBe(7);
    expect(all.cost?.byProject).toMatchObject({ bouncr: { costUsd: 5 }, "smart-dispatcher": { costUsd: 2 } });
    expect(all.cost?.byProvider).toMatchObject({
      claude: { costUsd: 3, sessions: 2 },
      codex: { costUsd: 4 },
    });
    expect(all.cost?.byProvenance.timed?.sessions).toBe(3);
    const one = await statusReport(w.ctx, { cost: true, project: "bouncr" });
    expect(one.issues.map((i) => i.identifier)).toEqual(["JRF-911"]);
    expect(one.queue.every((q) => q.project === "bouncr")).toBe(true);
    expect(one.cost?.total.costUsd).toBe(5);
  });
  test("a state file that does not parse is a problem code, never a crash; the stop flag and paused scopes show", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-913"));
    await runTick(w);
    writeFileSync(join(w.dirs.records, "JRF-914.json"), "{ not json");
    writeFileSync(join(w.dirs.state, "queue.json"), JSON.stringify({ at: 1 }));
    await requestStop(w.dirs, { scope: "all", at: w.ctx.now() });
    await setPause(w.dirs, "bouncr", true);
    const rep = await statusReport(w.ctx);
    expect(rep.problems).toEqual(["record_invalid(JRF-914)", "queue_invalid"]);
    expect(rep.issues.map((i) => i.identifier)).toEqual(["JRF-913"]);
    expect(rep.stopRequested).toBe(true);
    expect(rep.pausedScopes).toEqual(["bouncr"]);
    const md = renderStatusMd(rep);
    expect(md).toContain("Problems: record_invalid(JRF-914), queue_invalid");
    expect(md).toContain("Stop requested: yes");
    expect(md).toContain("Paused: bouncr");
  });
  test("per-issue rows: waiting-on by stage and pause, age, PR, attention codes", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-915"));
    await runTick(w);
    const r = await readRecord(w.dirs, "JRF-915");
    if (!r) throw new Error("not claimed");
    r.stage = "awaiting-human";
    r.attention = ["resume_unconfirmed"];
    r.prs.push({
      repo: "api",
      number: 7,
      url: "https://github.com/furoyce/bouncr.lol/pull/7",
      state: "OPEN",
      headSha: "s",
    });
    await writeRecord(w.dirs, r);
    w.clock.advance(42 * 60_000);
    const [row] = (await statusReport(w.ctx)).issues;
    expect(row).toMatchObject({
      identifier: "JRF-915",
      stage: "awaiting-human",
      waitingOn: "owner (question)",
      ageMin: 42,
      prUrl: "https://github.com/furoyce/bouncr.lol/pull/7",
      attention: ["resume_unconfirmed"],
      model: "claude-fable-5-1[1m]",
    });
    r.paused = true;
    await writeRecord(w.dirs, r);
    expect((await statusReport(w.ctx)).issues[0]?.waitingOn).toBe("owner (paused)");
  });
});
