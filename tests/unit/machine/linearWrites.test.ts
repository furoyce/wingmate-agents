// tests/unit/machine/linearWrites.test.ts — journaled Linear writes, Linear-wins re-read (I5), outbound secret scan, status comment
import { describe, expect, test } from "bun:test";
import { LinearWrites } from "../../../src/machine/linearWrites";
import { addNote, syncStatus } from "../../../src/machine/status";
import type { LinearIssue } from "../../../src/ports";
import { WingmateError } from "../../../src/shared/errors";
import { type WRecord, newRecord } from "../../../src/state/records";
import { OWNER, addLabeledByOwner, todo } from "../../fakes/issues";
import { type World, makeWorld } from "../../fakes/world";

async function setup(): Promise<{ w: World; r: WRecord; issue: LinearIssue }> {
  const w = await makeWorld();
  addLabeledByOwner(w.linear, todo("i1", "JRF-501"));
  const [issue] = await w.linear.getIssues(["i1"]);
  if (!issue) throw new Error("issue missing");
  const r = newRecord({
    identifier: "JRF-501",
    linearId: "i1",
    project: "bouncr",
    repo: "api",
    provider: "claude",
    autonomy: "ask-first",
    now: w.ctx.now(),
  });
  return { w, r, issue };
}
const statusComments = (w: World) =>
  w.linear.comments.filter((c) => c.body.startsWith("<!-- wingmate:status -->"));

describe("LinearWrites", () => {
  test("a label write is journaled intent → acted → confirmed and replaces only the Lifecycle label", async () => {
    const { w, r, issue } = await setup();
    await new LinearWrites(w.ctx).setLifecycle(r, issue, "In-Agent");
    const live = w.linear.issues.get("i1");
    expect(live?.labels.map((l) => l.name).sort()).toEqual(["In-Agent", "agent-ready"]);
    expect(r.linear.lifecycleLabel).toBe("In-Agent");
    const entries = await w.ctx.journal.all();
    expect(entries.map((e) => [e.kind, e.state])).toEqual([["issueUpdate", "confirmed"]]);
    // the snapshot follows the write, so a second identical call writes nothing
    await new LinearWrites(w.ctx).setLifecycle(r, issue, "In-Agent");
    expect(w.linear.issueWrites).toHaveLength(1);
  });

  test("I5: an owner edit after the snapshot drops the write (linear_conflict) and nothing is overwritten", async () => {
    const { w, r, issue } = await setup();
    w.linear.setLabels("i1", ["agent-ready", "Blocked"], OWNER, w.ctx.now());
    const err = await new LinearWrites(w.ctx).setLifecycle(r, issue, "Needs-Human").catch((e: unknown) => e);
    expect(err instanceof WingmateError && err.code).toBe("linear_conflict");
    expect(w.linear.issues.get("i1")?.labels.map((l) => l.name)).toEqual(["agent-ready", "Blocked"]);
    expect(w.linear.issueWrites).toEqual([]);
    expect(await w.ctx.journal.all()).toEqual([]);
  });

  test("a failed write stays `intent` with the error and its attempt counted, and is rethrown", async () => {
    const { w, r, issue } = await setup();
    w.linear.failNext = "issueUpdate";
    await expect(new LinearWrites(w.ctx).setState(r, issue, "In Progress")).rejects.toThrow(
      /fake linear failure/,
    );
    const [e] = await w.ctx.journal.all();
    expect(e).toMatchObject({ kind: "issueUpdate", state: "intent", attempts: 1 });
    expect(e?.error).toContain("fake linear failure");
  });

  test("a keyed comment is posted once: the replay returns the confirmed comment instead of a second post", async () => {
    const { w, r, issue } = await setup();
    const lw = new LinearWrites(w.ctx);
    const a = await lw.postComment(r, issue, "question one", { key: "ask:01ABC" });
    const b = await lw.postComment(r, issue, "question one", { key: "ask:01ABC" });
    expect(b).toBe(a);
    expect(w.linear.comments).toHaveLength(1);
    // without a key every call is a new comment
    await lw.postComment(r, issue, "note");
    expect(w.linear.comments).toHaveLength(2);
  });

  test("§11.2: outbound text with a secret-shaped token is refused before any journal entry or Linear write", async () => {
    const { w, r, issue } = await setup();
    const secret = `token ${"sk-ant-api03-"}${"A".repeat(30)}`;
    const err = await new LinearWrites(w.ctx).postComment(r, issue, secret).catch((e: unknown) => e);
    expect(err instanceof WingmateError && err.code).toBe("secret_detected");
    expect(err instanceof Error && err.message).not.toContain("AAAA");
    expect(w.linear.comments).toEqual([]);
    expect(await w.ctx.journal.all()).toEqual([]);
  });

  test("the owner is subscribed once per cycle; an already subscribed owner costs no write", async () => {
    const { w, r, issue } = await setup();
    const lw = new LinearWrites(w.ctx);
    await lw.subscribeOwner(r, issue);
    await lw.subscribeOwner(r, issue);
    expect(w.linear.writes.filter((x) => x.kind === "subscribe")).toHaveLength(1);
    expect(r.linear.subscribed).toBe(true);
  });
});

describe("syncStatus", () => {
  test("creates the one status comment, then edits it in place", async () => {
    const { w, r, issue } = await setup();
    await syncStatus(w.ctx, r, issue);
    const id = r.linear.statusCommentId;
    expect(statusComments(w)).toHaveLength(1);
    w.clock.advance(60_000);
    await syncStatus(w.ctx, r, issue);
    expect(r.linear.statusCommentId).toBe(id);
    expect(statusComments(w)).toHaveLength(1);
    expect(statusComments(w)[0]?.body).toContain("2026-10-06T10:01:00.000Z");
  });

  test("a record that lost its comment id reuses the issue's existing status comment (crash replay, re-claim)", async () => {
    const { w, r, issue } = await setup();
    await syncStatus(w.ctx, r, issue);
    const id = r.linear.statusCommentId;
    r.linear.statusCommentId = null;
    await syncStatus(w.ctx, r, issue);
    expect(r.linear.statusCommentId as string | null).toBe(id);
    expect(statusComments(w)).toHaveLength(1);
  });

  test("a transient edit failure is rethrown, never answered with a second status comment", async () => {
    const { w, r, issue } = await setup();
    await syncStatus(w.ctx, r, issue);
    w.linear.failNext = "commentUpdate";
    await expect(syncStatus(w.ctx, r, issue)).rejects.toThrow(/fake linear failure/);
    expect(statusComments(w)).toHaveLength(1);
  });

  test("a status comment Linear reports deleted is replaced and the old id ledgered", async () => {
    const { w, r, issue } = await setup();
    await syncStatus(w.ctx, r, issue);
    const old = r.linear.statusCommentId;
    w.linear.comments = [];
    w.linear.updateComment = async () => {
      throw new WingmateError("linear_graphql", "Entity not found: Comment");
    };
    await syncStatus(w.ctx, r, issue);
    expect(r.linear.statusCommentId).not.toBe(old);
    expect(statusComments(w)).toHaveLength(1);
    const replaced = (await w.ctx.ledger.readIssue("JRF-501")).find(
      (e) => e.type === "status_comment_replaced",
    );
    expect(replaced?.data.old).toBe(old ?? "");
  });

  test("activity notes persist through the ledger: a later record object still shows the last five", async () => {
    const { w, r, issue } = await setup();
    for (let n = 1; n <= 6; n++) addNote(r, `note ${n}`);
    await syncStatus(w.ctx, r, issue);
    const fresh: WRecord = structuredClone(r);
    await syncStatus(w.ctx, fresh, issue);
    const body = statusComments(w)[0]?.body ?? "";
    expect(body).toContain("10:00 note 6");
    expect(body).toContain("10:00 note 2");
    expect(body).not.toContain("10:00 note 1");
  });
});
