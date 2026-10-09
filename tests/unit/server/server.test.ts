import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type WingmateServer, startServer } from "../../../src/server";
import { readRecord, writeRecord } from "../../../src/state/records";
import { type World, labeledByOwner, runTick, todo, world } from "../../sim/harness";

describe("server endpoints", () => {
  let w: World;
  let server: WingmateServer;

  beforeAll(async () => {
    w = await world();
    server = await startServer({
      port: 4899,
      dirs: w.dirs,
      cfg: w.cfg,
      clock: w.clock,
      linearClient: w.linear,
    });
  });

  afterAll(() => {
    server?.stop();
  });

  test("GET /healthz returns status ok", async () => {
    const res = await fetch(`${server.url}/healthz`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  test("GET / serves the dashboard HTML SPA with theme, kanban, and modal support", async () => {
    const res = await fetch(`${server.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Wingmate");
    expect(html).toContain("Architect Command Center");
    expect(html).toContain("themeToggleBtn");
    expect(html).toContain("btnViewKanban");
    expect(html).toContain("kanbanBoard");
    expect(html).toContain("answerModal");
    expect(html).toContain("toastContainer");
  });

  test("GET /api/snapshot returns valid snapshot payload", async () => {
    const res = await fetch(`${server.url}/api/snapshot?timeframe=7d`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.funnel).toBeDefined();
    expect(data.activeWorktrees).toBeDefined();
    expect(data.projects).toBeDefined();
    expect(data.metrics).toBeDefined();
  });

  test("POST /api/actions/pause toggles dispatcher pause state", async () => {
    const res = await fetch(`${server.url}/api/actions/pause`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "global", on: true }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.data.pausedScopes).toContain("global");

    // Unpause so subsequent tests are not blocked
    await fetch(`${server.url}/api/actions/pause`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "global", on: false }),
    });
  });

  test("POST /api/actions/answer delivers answer and updates question status", async () => {
    const issue = todo("i_ans", "JRF-890");
    labeledByOwner(w, issue);
    await runTick(w);

    const record = await readRecord(w.dirs, "JRF-890");
    if (!record) throw new Error("record not found");
    record.stage = "awaiting-human";
    record.questions.push({
      id: "q_test_123",
      commentId: null,
      askedAt: w.ctx.now(),
      status: "open",
      answerCommentId: null,
      answeredAt: null,
      resumeAttempts: 0,
      nonAnswerCommentIds: [],
    });
    await writeRecord(w.dirs, record);

    const res = await fetch(`${server.url}/api/actions/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "JRF-890",
        questionId: "q_test_123",
        answerText: "Approved, proceed with tests.",
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);

    // Verify inbox file
    const wt = record.worktree?.path;
    if (!wt) throw new Error("worktree path missing");
    const inboxFile = join(wt, ".wingmate", "inbox", "answer-q_test_123.md");
    expect(existsSync(inboxFile)).toBe(true);
    expect(readFileSync(inboxFile, "utf8")).toContain("Approved, proceed with tests.");

    // Verify updated record
    const updated = await readRecord(w.dirs, "JRF-890");
    expect(updated?.stage).toBe("working");
    const q = updated?.questions.find((x) => x.id === "q_test_123");
    expect(q?.status).toBe("answered");
  });
});
