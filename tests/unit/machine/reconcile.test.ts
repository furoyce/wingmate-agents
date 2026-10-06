import { describe, expect, test } from "bun:test";
import { reconcile } from "../../../src/machine/reconcile";
import type { LinearIssue } from "../../../src/ports";
import { createRecordExclusive, newRecord } from "../../../src/state/records";
import { makeWorld } from "../../fakes/world";

const OWNER = "71aef180-1742-4a76-8d49-51f14e8ada1e";
const todo = (id: string, identifier: string): LinearIssue => ({
  id,
  identifier,
  title: "iOS leaderboard",
  description: null,
  url: "",
  createdAt: "2026-10-06T09:00:00.000Z",
  updatedAt: "2026-10-06T09:00:00.000Z",
  archivedAt: null,
  trashed: false,
  priority: 2,
  branchName: "b",
  state: { id: "st-todo", name: "Todo", type: "unstarted" },
  projectId: "0ca67822-6416-447b-b7b2-08ab2a7346dd",
  teamId: "t",
  assigneeId: OWNER,
  delegateId: null,
  labels: [{ id: "lb-agent-ready", name: "agent-ready", parentId: "grp-agent", parentName: "Agent" }],
  subscriberIds: [],
  parent: null,
  children: [],
  prerequisites: [],
  attachments: [],
});
const ownerLabelHistory = (at: string) => [
  {
    id: "h",
    createdAt: at,
    actorId: OWNER,
    botActorId: null,
    botActorType: null,
    addedLabelIds: ["lb-agent-ready"],
    removedLabelIds: [],
    fromStateId: null,
    toStateId: null,
  },
];
const parkedRecord = (identifier: string, linearId: string) => {
  const rec = newRecord({
    identifier,
    linearId,
    project: "bouncr",
    repo: "api",
    provider: "claude",
    autonomy: "ask-first",
    now: "2026-10-06T09:00:00.000Z",
  });
  rec.stage = "awaiting-human";
  rec.linear.state = "In Progress";
  rec.linear.lastSeenCommentAt = "2026-10-06T09:05:00.000Z";
  rec.questions.push({
    id: "q1",
    commentId: "cq",
    askedAt: "2026-10-06T09:05:00.000Z",
    status: "open",
    answerCommentId: null,
    answeredAt: null,
    resumeAttempts: 0,
    nonAnswerCommentIds: [],
  });
  return rec;
};

describe("reconcile", () => {
  test("lists candidates with eligibility verdicts and reads fleet + quota", async () => {
    const w = await makeWorld();
    w.linear.add(todo("i1", "JRF-501"));
    w.linear.history.set("i1", ownerLabelHistory("2026-10-06T09:00:00.000Z"));
    const r = await reconcile(w.ctx);
    expect(r.candidates.map((c) => [c.issue.identifier, c.verdict.status])).toEqual([
      ["JRF-501", "eligible"],
    ]);
    expect(r.partial).toBe(false);
    expect(r.rateLimits.claude?.status).toBe("ok");
    expect(r.pausedScopes).toEqual([]);
    expect(r.records).toEqual([]);
  });

  test("derives an owner Done event with authorship and an answer event for a parked record", async () => {
    const w = await makeWorld();
    const i = todo("i2", "JRF-502");
    i.state = { id: "st-prog", name: "In Progress", type: "started" };
    w.linear.add(i);
    await createRecordExclusive(w.dirs, parkedRecord("JRF-502", "i2"));
    w.linear.humanComment("i2", "1", OWNER, "2026-10-06T09:40:00.000Z", "cq");
    const r = await reconcile(w.ctx);
    expect(r.events.find((e) => e.type === "answer")).toMatchObject({
      identifier: "JRF-502",
      commentId: "c-1",
      questionId: "q1",
    });
    w.linear.setState("i2", "Done", OWNER, "2026-10-06T09:50:00.000Z");
    const r2 = await reconcile(w.ctx);
    expect(r2.events.find((e) => e.type === "owner_state")).toMatchObject({
      identifier: "JRF-502",
      stateType: "completed",
      authorized: true,
    });
  });

  test("answer during agent activity is not an answer (self_answer_suspected comment event)", async () => {
    const w = await makeWorld();
    const i = todo("i3", "JRF-503");
    i.state = { id: "st-prog", name: "In Progress", type: "started" };
    w.linear.add(i);
    const rec = parkedRecord("JRF-503", "i3");
    const wt = await w.orca.worktreeCreate({
      repoId: "repo",
      name: "wm-jrf-503",
      baseBranch: "origin/main",
      linearIssue: "JRF-503",
      comment: "",
    });
    const term = await w.orca.terminalCreate(wt.id, "wingmate JRF-503", "exec claude");
    rec.worktree = {
      id: wt.id,
      path: wt.path,
      branch: "wm-jrf-503",
      baseSha: "basesha",
      gitCommonDir: "/repo/.git",
      gitdirName: "wm-jrf-503",
    };
    rec.coordinator.terminalHandle = term.handle;
    rec.coordinator.paneKey = `${term.tabId}:${term.leafId}`;
    await createRecordExclusive(w.dirs, rec);
    w.orca.setAgentState(wt.id, rec.coordinator.paneKey, "working", "2026-10-06T09:39:00.000Z");
    w.linear.humanComment("i3", "1", OWNER, "2026-10-06T09:40:00.000Z", "cq");
    const r = await reconcile(w.ctx);
    expect(r.events.find((e) => e.type === "answer")).toBeUndefined();
    expect(r.events.find((e) => e.type === "comment")).toMatchObject({
      identifier: "JRF-503",
      cls: "self_answer_suspected",
    });
    expect(r.liveness.get("JRF-503")).toBe("working");
  });

  test("a state change by a non-approver is reported as unauthorized", async () => {
    const w = await makeWorld();
    const i = todo("i4", "JRF-504");
    i.state = { id: "st-prog", name: "In Progress", type: "started" };
    w.linear.add(i);
    await createRecordExclusive(w.dirs, parkedRecord("JRF-504", "i4"));
    w.linear.setState("i4", "Done", "guest-user", "2026-10-06T09:50:00.000Z");
    const r = await reconcile(w.ctx);
    expect(r.events.find((e) => e.type === "owner_state")).toMatchObject({
      identifier: "JRF-504",
      stateType: "completed",
      authorized: false,
    });
  });

  test("a partial fleet read marks the result partial and liveness unverifiable", async () => {
    const w = await makeWorld();
    w.orca.partial = true;
    expect((await reconcile(w.ctx)).partial).toBe(true);
  });

  test("pause.json scopes are read and skip candidates", async () => {
    const w = await makeWorld();
    w.linear.add(todo("i5", "JRF-505"));
    w.linear.history.set("i5", ownerLabelHistory("2026-10-06T09:00:00.000Z"));
    await Bun.write(`${w.dirs.state}/pause.json`, JSON.stringify(["global"]));
    const r = await reconcile(w.ctx);
    expect(r.pausedScopes).toEqual(["global"]);
    expect(r.candidates[0]?.verdict).toMatchObject({ status: "skipped", reason: "paused" });
  });
});

describe("reconcile authorship and comment window (fix round 1)", () => {
  const inProgress = (id: string, identifier: string) => {
    const i = todo(id, identifier);
    i.state = { id: "st-prog", name: "In Progress", type: "started" };
    return i;
  };

  test("a non-approver state change stays unauthorized even after a later owner label edit", async () => {
    const w = await makeWorld();
    w.linear.add(inProgress("i6", "JRF-506"));
    await createRecordExclusive(w.dirs, parkedRecord("JRF-506", "i6"));
    w.linear.setState("i6", "Done", "guest-user", "2026-10-06T09:50:00.000Z");
    w.linear.setLabels("i6", ["agent-ready", "Needs-Human"], OWNER, "2026-10-06T09:55:00.000Z");
    const r = await reconcile(w.ctx);
    expect(r.events.find((e) => e.type === "owner_state")).toMatchObject({
      identifier: "JRF-506",
      stateType: "completed",
      authorized: false,
      at: "2026-10-06T09:50:00.000Z",
    });
  });

  test("a 1 ms skew between the issue's updatedAt and the history entry does not change the verdict", async () => {
    const w = await makeWorld();
    w.linear.add(inProgress("i7", "JRF-507"));
    await createRecordExclusive(w.dirs, parkedRecord("JRF-507", "i7"));
    w.linear.setState("i7", "Done", "guest-user", "2026-10-06T09:50:00.000Z");
    const issue = w.linear.issues.get("i7");
    if (!issue) throw new Error("issue missing");
    issue.updatedAt = "2026-10-06T09:50:00.001Z";
    expect((await reconcile(w.ctx)).events.find((e) => e.type === "owner_state")).toMatchObject({
      authorized: false,
    });
    // ...and an owner change with the same skew is still authorized.
    w.linear.add(inProgress("i8", "JRF-508"));
    await createRecordExclusive(w.dirs, parkedRecord("JRF-508", "i8"));
    w.linear.setState("i8", "Done", OWNER, "2026-10-06T09:51:00.000Z");
    const owned = w.linear.issues.get("i8");
    if (!owned) throw new Error("issue missing");
    owned.updatedAt = "2026-10-06T09:51:00.001Z";
    const r = await reconcile(w.ctx);
    expect(r.events.find((e) => e.type === "owner_state" && e.identifier === "JRF-508")).toMatchObject({
      authorized: true,
    });
  });

  test("a label change by a non-approver is unauthorized; the owner's lifecycle change is authorized", async () => {
    const w = await makeWorld();
    w.linear.add(inProgress("i9", "JRF-509"));
    const rec = parkedRecord("JRF-509", "i9");
    rec.linear.lifecycleLabel = null;
    await createRecordExclusive(w.dirs, rec);
    w.linear.setLabels("i9", ["agent-ready", "human"], "guest-user", "2026-10-06T09:50:00.000Z");
    expect((await reconcile(w.ctx)).events.find((e) => e.type === "owner_labels")).toMatchObject({
      authorized: false,
      agent: ["agent-ready", "human"],
    });
    w.linear.setLabels("i9", ["agent-ready", "Needs-Human"], OWNER, "2026-10-06T09:52:00.000Z");
    expect((await reconcile(w.ctx)).events.find((e) => e.type === "owner_labels")).toMatchObject({
      authorized: true,
      lifecycle: "Needs-Human",
      at: "2026-10-06T09:52:00.000Z",
    });
  });

  test("§13.3(i): an approver's `human` label is honored while an agent works (kill switch); another label change is not", async () => {
    const w = await makeWorld();
    w.linear.add(inProgress("i12", "JRF-512"));
    const rec = parkedRecord("JRF-512", "i12");
    rec.stage = "working";
    rec.questions = [];
    const wt = await w.orca.worktreeCreate({
      repoId: "repo",
      name: "wm-jrf-512",
      baseBranch: "origin/main",
      linearIssue: "JRF-512",
      comment: "",
    });
    const term = await w.orca.terminalCreate(wt.id, "wingmate JRF-512", "exec claude");
    rec.worktree = {
      id: wt.id,
      path: wt.path,
      branch: "wm-jrf-512",
      baseSha: "basesha",
      gitCommonDir: "/repo/.git",
      gitdirName: "wm-jrf-512",
    };
    rec.coordinator.terminalHandle = term.handle;
    rec.coordinator.paneKey = `${term.tabId}:${term.leafId}`;
    rec.linear.lifecycleLabel = "In-Agent";
    await createRecordExclusive(w.dirs, rec);
    w.orca.setAgentState(wt.id, rec.coordinator.paneKey, "working", "2026-10-06T09:39:00.000Z");
    w.linear.setLabels("i12", ["agent-ready", "In-Agent", "human"], OWNER, "2026-10-06T09:50:00.000Z");
    expect((await reconcile(w.ctx)).events.find((e) => e.type === "owner_labels")).toMatchObject({
      authorized: true,
      agent: ["agent-ready", "human"],
    });
    w.linear.setLabels("i12", ["agent-ready", "Blocked"], OWNER, "2026-10-06T09:55:00.000Z");
    expect((await reconcile(w.ctx)).events.find((e) => e.type === "owner_labels")).toMatchObject({
      authorized: false,
      lifecycle: "Blocked",
    });
  });

  test("a parked record that has never seen a comment still receives the owner's answer", async () => {
    const w = await makeWorld(); // clock 10:00, answer at 09:40 — the old window started at now and hid it
    w.linear.add(inProgress("i10", "JRF-510"));
    const rec = parkedRecord("JRF-510", "i10");
    rec.linear.lastSeenCommentAt = null;
    await createRecordExclusive(w.dirs, rec);
    w.linear.humanComment("i10", "1", OWNER, "2026-10-06T09:40:00.000Z", "cq");
    const r = await reconcile(w.ctx);
    expect(r.events.find((e) => e.type === "answer")).toMatchObject({
      identifier: "JRF-510",
      commentId: "c-1",
    });
  });

  test("comments posted before a record's claim never arrive as notes", async () => {
    const w = await makeWorld();
    w.linear.add(inProgress("i11", "JRF-511"));
    const rec = parkedRecord("JRF-511", "i11");
    rec.stage = "working";
    rec.questions = [];
    rec.linear.lastSeenCommentAt = null; // claimedAt 09:00
    await createRecordExclusive(w.dirs, rec);
    w.linear.humanComment("i11", "old thoughts", OWNER, "2026-10-06T08:30:00.000Z");
    w.linear.humanComment("i11", "new thoughts", OWNER, "2026-10-06T09:30:00.000Z");
    const r = await reconcile(w.ctx);
    const notes = r.events
      .filter((e) => e.type === "comment")
      .map((e) => (e.type === "comment" ? e.body : ""));
    expect(notes).toEqual(["new thoughts"]);
  });
});
