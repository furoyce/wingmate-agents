import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { reconcile } from "../../../src/machine/reconcile";
import { tick } from "../../../src/machine/tick";
import type { LinearHistoryEntry } from "../../../src/ports";
import { WingmateError } from "../../../src/shared/errors";
import { createRecordExclusive, newRecord, readRecord, writeRecord } from "../../../src/state/records";
import { OWNER, todo } from "../../fakes/issues";
import { makeWorld } from "../../fakes/world";

const AT = "2026-10-06T09:50:00.000Z";
type Actor = Pick<LinearHistoryEntry, "actorId" | "botActorId" | "botActorType">;
const HUMAN: Actor = { actorId: OWNER, botActorId: null, botActorType: null };
const UNTRUSTED: [string, Actor][] = [
  ["unrelated integration", { actorId: null, botActorId: "other-integration", botActorType: "integration" }],
  ["GitHub-named integration", { actorId: OWNER, botActorId: "github", botActorType: "integration" }],
  ["integration without ID", { ...HUMAN, botActorType: "integration" }],
  ["application with approver actor", { ...HUMAN, botActorId: "app", botActorType: "application" }],
  ["bot without type", { ...HUMAN, botActorId: "bot" }],
  ["non-approver", { ...HUMAN, actorId: "guest" }],
  ["missing actor", { ...HUMAN, actorId: null }],
];

async function setup(review = false, paused = false) {
  const w = await makeWorld();
  w.orca.root = null; // no real host worktrees or provider sessions
  const r = newRecord({
    identifier: "JRF-801",
    linearId: "i1",
    project: "bouncr",
    repo: "api",
    provider: "claude",
    autonomy: "ask-first",
    now: "2026-10-06T09:00:00.000Z",
  });
  r.stage = review ? "review" : "awaiting-human";
  r.linear.state = review ? "In Review" : "In Progress";
  r.linear.lifecycleLabel = paused ? "Blocked" : review ? "Review-Ready" : "Needs-Human";
  r.paused = paused;
  r.linear.pausedWith = paused ? "Blocked" : null;
  const state = w.linear.meta.states.find((s) => s.name === r.linear.state);
  if (!state) throw new Error("missing state fixture");
  w.linear.add(
    todo("i1", r.identifier, {
      state,
      labels: w.linear.meta.labels.filter((l) => ["agent-ready", r.linear.lifecycleLabel].includes(l.name)),
    }),
  );
  await createRecordExclusive(w.dirs, r);
  return { w, r };
}

function actor(w: Awaited<ReturnType<typeof setup>>["w"], who: Actor) {
  const h = w.linear.history.get("i1")?.at(-1);
  if (!h) throw new Error("missing event fixture");
  Object.assign(h, who);
}

describe("AUTH-1: issue-event authority", () => {
  test("an integration close retains the idle parked worktree across ticks, even with a cached merged PR", async () => {
    const { w, r } = await setup();
    const wt = await w.orca.worktreeCreate({
      repoId: "repo",
      name: "parked",
      baseBranch: "origin/main",
      linearIssue: r.identifier,
      comment: "",
    });
    const path = join(w.root, "parked");
    mkdirSync(path);
    const term = await w.orca.terminalCreate(wt.id, "wingmate JRF-801", "exec claude");
    r.worktree = {
      id: wt.id,
      path,
      branch: "parked",
      baseSha: "base",
      gitCommonDir: join(w.root, ".git"),
      gitdirName: "parked",
    };
    r.coordinator.terminalHandle = term.handle;
    r.coordinator.paneKey = `${term.tabId}:${term.leafId}`;
    w.orca.setAgentState(wt.id, r.coordinator.paneKey, "done", "2026-10-06T09:10:00.000Z");
    r.prs = [
      {
        repo: r.repo,
        number: 1,
        url: "https://github.com/fake/repo/pull/1",
        headSha: "head",
        state: "MERGED",
      },
    ];
    await writeRecord(w.dirs, r);
    w.linear.setState("i1", "Done", OWNER, AT);
    actor(w, { actorId: OWNER, botActorId: "github", botActorType: "integration" });
    expect((await reconcile(w.ctx)).liveness.get(r.identifier)).toBe("idle");
    for (let n = 0; n < 2; n++) {
      const s = await tick(w.ctx, { dryRun: false, precheck: true });
      expect(s.done).toEqual([]);
      expect(await readRecord(w.dirs, r.identifier)).toMatchObject({
        stage: "awaiting-human",
        worktree: r.worktree,
        attention: ["possible_self_close"],
      });
      w.clock.advance(5 * 60_000);
    }
    expect(w.orca.closed).toEqual([wt.id]);
    expect(w.orca.removed).toEqual([]);
  });

  for (const [name, who] of UNTRUSTED) {
    test(`${name} cannot complete an idle parked issue`, async () => {
      const { w, r } = await setup();
      w.linear.setState("i1", "Done", OWNER, AT);
      actor(w, who);
      expect((await reconcile(w.ctx)).events.find((e) => e.type === "owner_state")).toMatchObject({
        authorized: false,
      });
      const s = await tick(w.ctx, { dryRun: false, precheck: true });
      expect(s.done).toEqual([]);
      expect(s.attention).toContainEqual({ identifier: r.identifier, code: "possible_self_close" });
      expect(await readRecord(w.dirs, r.identifier)).toMatchObject({ stage: "awaiting-human" });
      expect(w.linear.issueWrites).toEqual([]);
      expect(w.orca.removed).toEqual([]);
    });

    test(`${name} cannot resume review`, async () => {
      const { w, r } = await setup(true);
      w.linear.setState("i1", "In Progress", OWNER, AT);
      actor(w, who);
      const s = await tick(w.ctx, { dryRun: false, precheck: true });
      expect(s.resumes).toEqual([]);
      expect(s.attention).toContainEqual({ identifier: r.identifier, code: "unauthorized_state_change" });
      expect(await readRecord(w.dirs, r.identifier)).toMatchObject({ stage: "review" });
      expect(w.linear.issueWrites).toEqual([]);
      expect(w.orca.calls.some((c) => c.verb === "terminalCreate" || c.verb === "terminalSend")).toBe(false);
    });

    for (const [label, paused] of [
      ["Blocked", false],
      [null, false],
      ["Ready", true],
      ["human", false],
    ] as const) {
      test(`${name} cannot apply lifecycle/kill-switch change ${label} (paused=${paused})`, async () => {
        const { w, r } = await setup(false, paused);
        w.linear.setLabels("i1", ["agent-ready", ...(label ? [label] : [])], OWNER, AT);
        actor(w, who);
        const s = await tick(w.ctx, { dryRun: false, precheck: true });
        expect(s.released).toEqual([]);
        expect(s.resumes).toEqual([]);
        expect(s.attention).toContainEqual({ identifier: r.identifier, code: "unauthorized_label_change" });
        expect(await readRecord(w.dirs, r.identifier)).toMatchObject({ stage: r.stage, paused });
        expect(w.linear.issueWrites).toEqual([]);
      });
    }
  }

  test("a verified human may complete without PR or merge proof", async () => {
    const { w, r } = await setup();
    w.linear.setState("i1", "Done", OWNER, AT);
    const s = await tick(w.ctx, { dryRun: false, precheck: true });
    expect(s.done).toEqual([r.identifier]);
    expect(s.attention).toEqual([]);
    expect(await readRecord(w.dirs, r.identifier)).toMatchObject({ stage: "done", prs: [] });
  });

  test("a verified human may resume review", async () => {
    const { w } = await setup(true);
    w.linear.setState("i1", "In Progress", OWNER, AT);
    expect((await reconcile(w.ctx)).events.find((e) => e.type === "owner_state")).toMatchObject({
      authorized: true,
    });
  });

  test("a verified human may pause and unpause lifecycle controls", async () => {
    const { w, r } = await setup();
    w.linear.setLabels("i1", ["agent-ready", "Blocked"], OWNER, AT);
    await tick(w.ctx, { dryRun: false, precheck: true });
    expect(await readRecord(w.dirs, r.identifier)).toMatchObject({ paused: true });
    w.linear.setLabels("i1", ["agent-ready", "Ready"], OWNER, "2026-10-06T09:55:00.000Z");
    await tick(w.ctx, { dryRun: false, precheck: true });
    expect(await readRecord(w.dirs, r.identifier)).toMatchObject({ paused: false });
  });

  test("an approver lifecycle edit cannot substitute for missing human-label authorship", async () => {
    const { w } = await setup();
    w.linear.setLabels("i1", ["agent-ready", "Blocked", "human"], OWNER, AT);
    const h = w.linear.history.get("i1")?.at(-1);
    if (!h) throw new Error("missing event fixture");
    h.addedLabelIds = ["lb-Blocked"];
    expect((await reconcile(w.ctx)).events.find((e) => e.type === "owner_labels")).toMatchObject({
      authorized: false,
    });
  });

  test("missing matching history cannot authorize completion", async () => {
    const { w } = await setup();
    w.linear.setState("i1", "Done", OWNER, AT);
    w.linear.history.clear();
    expect((await reconcile(w.ctx)).events.find((e) => e.type === "owner_state")).toMatchObject({
      authorized: false,
    });
  });

  test("a partial fleet cannot prove inactivity for a human completion", async () => {
    const { w } = await setup();
    w.linear.setState("i1", "Done", OWNER, AT);
    w.orca.partial = true;
    expect((await reconcile(w.ctx)).events.find((e) => e.type === "owner_state")).toMatchObject({
      authorized: false,
    });
  });

  test("a failed history read never applies the observed completion", async () => {
    const { w, r } = await setup();
    w.linear.setState("i1", "Done", OWNER, AT);
    w.linear.onCall = (method) => {
      if (method === "issueHistory") throw new WingmateError("linear_unreachable", "history unavailable");
    };
    const s = await tick(w.ctx, { dryRun: false, precheck: true });
    expect(s).toMatchObject({ outcome: "linear_error", reason: "linear_unreachable", done: [] });
    expect(await readRecord(w.dirs, r.identifier)).toEqual(r);
    expect(w.linear.issueWrites).toEqual([]);
  });
});
