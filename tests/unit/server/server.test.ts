import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Script, runInNewContext } from "node:vm";
import { type WingmateServer, startServer } from "../../../src/server";
import { handleAnswerQuestion } from "../../../src/server/actions";
import { readRecord, writeRecord } from "../../../src/state/records";
import { type World, labeledByOwner, runTick, todo, world } from "../../sim/harness";

/** Capture every simulated file, including protected records/ledger and the worktree inbox. */
function fileTree(root: string, rel = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(join(root, rel)).sort()) {
    const path = join(rel, name);
    if (lstatSync(join(root, path)).isDirectory()) {
      files[`${path}/`] = "directory";
      Object.assign(files, fileTree(root, path));
    } else if (lstatSync(join(root, path)).isFile()) {
      files[path] = createHash("sha256")
        .update(readFileSync(join(root, path)))
        .digest("hex");
    }
  }
  return files;
}

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

  test("GET / preserves dashboard features and routes answers to Linear without approval controls", async () => {
    const res = await fetch(`${server.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Wingmate");
    expect(html).toContain("Architect Command Center");
    expect(html).toContain("themeToggleBtn");
    expect(html).toContain("btnViewKanban");
    expect(html).toContain("kanbanBoard");
    expect(html).toContain("Worktree ↗");
    expect(html).toContain("issue-link");
    expect(html).toContain("linearProjectUrl");
    expect(html).toContain("Answer in Linear");
    expect(html).toContain("signed-in owner account");
    for (const unsafeControl of [
      "answerModal",
      "modalAnswerInput",
      "submitApprovePlan",
      "submitModalAnswer",
      "btn-approve",
      "/api/actions/answer",
      "Agent resumed",
      "Plan Approved",
      "Answer delivered",
    ]) {
      expect(html).not.toContain(unsafeControl);
    }
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    if (!script) throw new Error("dashboard script missing");
    expect(() => new Script(script)).not.toThrow();
    const helpers = ["escapeHtml", "answerInLinearLink"].map((name) => {
      const source = script.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n    \\}`))?.[0];
      if (!source) throw new Error(`${name} missing`);
      return source;
    });
    const render = runInNewContext(`${helpers.join("\n")}\nanswerInLinearLink;`) as (item: {
      identifier: string;
      linearUrl: string | null;
    }) => string;
    const linked = render({
      identifier: "JRF-890",
      linearUrl: 'https://linear.app/jrf/issue/JRF-890?x="&y=1',
    });
    expect(linked).toContain('href="https://linear.app/jrf/issue/JRF-890?x=&quot;&amp;y=1"');
    expect(linked).toContain('rel="noopener noreferrer"');
    const fallback = render({ identifier: "JRF-890", linearUrl: null });
    expect(fallback).toContain('href="https://linear.app"');
    expect(fallback).toContain("Find JRF-890 in Linear");
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

  test("POST answer fails closed, including retries, without writing records, inbox, comments or delivery", async () => {
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
    const before = fileTree(w.root);
    const comments = structuredClone(w.linear.comments);
    const deliveries = structuredClone(w.orca.calls);
    for (const questionId of ["q_test_123", "q_test_123", "unknown-question"]) {
      const res = await fetch(`${server.url}/api/actions/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: "JRF-890",
          questionId,
          answerText: "Approved, proceed with tests.",
        }),
      });
      const data = await res.json();
      // Check all effects before status so a regression exposes its actual mutation.
      expect(fileTree(w.root)).toEqual(before);
      expect(w.linear.comments).toEqual(comments);
      expect(w.orca.calls).toEqual(deliveries);
      expect(res.status).toBe(503);
      expect(data.ok).toBe(false);
      expect(data.code).toBe("console_answer_unavailable");
      expect(data.error).toContain("Linear");
      expect(data.error).toContain("signed-in owner account");
      expect(data.error).not.toContain("Agent resumed");
    }
    expect(await readRecord(w.dirs, "JRF-890")).toEqual(record);
  });

  test("direct answer handler cannot bypass the unavailable API or write through an absent record", async () => {
    const before = fileTree(w.root);
    const comments = structuredClone(w.linear.comments);
    await expect(
      handleAnswerQuestion(w.dirs, "JRF-ABSENT", "unknown", "Approved", w.linear, w.clock),
    ).rejects.toThrow("Console answers are unavailable");
    expect(fileTree(w.root)).toEqual(before);
    expect(w.linear.comments).toEqual(comments);
  });
});
