// tests/unit/machine/publish.test.ts — §13.3(d) and §8.1 `finish`: every guard before any push, push → PR → attachment → one
// completion comment → review, the refusal path, and replay after a failure (§6.6, I4, I9); then publishing inside the tick.
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Intent, writeIntent } from "../../../src/kit/intents";
import { allowDepsGranted, publish, runGuards } from "../../../src/machine/publish";
import { reconcile } from "../../../src/machine/reconcile";
import { transition } from "../../../src/machine/states";
import type { LinearHistoryEntry, LinearIssue } from "../../../src/ports";
import { type WRecord, readRecord, writeRecord } from "../../../src/state/records";
import {
  OWNER,
  type World,
  advance,
  labeledByOwner,
  pinnedReport,
  readyToFinish,
  runTick,
  todo,
  world,
} from "../../sim/harness";

type FinishIntent = Extract<Intent, { kind: "finish" }>;
const COMPLETION = "<!-- wingmate:completion -->";
const ALLOW_DEPS = { id: "lb-allow-deps", name: "allow-deps", parentId: null, parentName: null };

async function rec(w: World, identifier: string): Promise<WRecord> {
  const r = await readRecord(w.dirs, identifier);
  if (!r) throw new Error(`no record ${identifier}`);
  return r;
}
function issueOf(w: World, id = "i1"): LinearIssue {
  const i = w.linear.issues.get(id);
  if (!i) throw new Error(`no issue ${id}`);
  return i;
}
function worktreeOf(r: WRecord): NonNullable<WRecord["worktree"]> {
  if (!r.worktree) throw new Error(`${r.identifier} has no worktree`);
  return r.worktree;
}
async function setup(): Promise<{ w: World; identifier: string; path: string }> {
  const w = await world();
  w.ctx.publishImpl = async () => ({ publish });
  labeledByOwner(w, todo("i1", "JRF-601"));
  await runTick(w);
  const r = await readyToFinish(w, "JRF-601");
  return { w, identifier: r.identifier, path: worktreeOf(r).path };
}
const finishIntent = (identifier: string, over: Partial<FinishIntent["payload"]> = {}): FinishIntent => ({
  id: "01J0000000000000000000FIN1",
  issue: identifier,
  createdAt: "2026-10-06T10:30:00.000Z",
  kind: "finish",
  payload: { summaryFile: ".wingmate/s.md", title: null, draft: false, repos: [], ...over },
});
const call = async (w: World, identifier: string, intent: FinishIntent = finishIntent(identifier)) =>
  publish(w.ctx, await rec(w, identifier), issueOf(w), intent, await reconcile(w.ctx));
const completions = (w: World) => w.linear.comments.filter((c) => c.body.startsWith(COMPLETION));
const inboxFiles = (path: string) =>
  existsSync(join(path, ".wingmate", "inbox"))
    ? readdirSync(join(path, ".wingmate", "inbox")).filter((n) => n.startsWith("publish-"))
    : [];
const grantEntry = (createdAt: string, actorId: string | null, botActorId: string | null = null) =>
  ({
    id: `h-deps-${createdAt}`,
    createdAt,
    actorId,
    botActorId,
    botActorType: botActorId ? "application" : null,
    addedLabelIds: [ALLOW_DEPS.id],
    removedLabelIds: [],
    fromStateId: null,
    toStateId: null,
  }) satisfies LinearHistoryEntry;

describe("publish guards (§13.3 d)", () => {
  test("secret in added line blocks push", async () => {
    // Review Focus 5
    const { w, identifier, path } = await setup();
    w.git.added.set(path, [
      {
        path: "src/db.ts",
        line: 'const url = "postgresql://app:S3cretPassw0rd@ep-cool-sound-123456.us-east-2.aws.neon.tech/neondb"',
      },
    ]);
    w.git.changed.set(path, ["src/db.ts"]);
    expect(await call(w, identifier)).toBe(false);
    expect(w.git.pushed).toEqual([]);
    expect(w.gh.prs).toEqual([]);
    const r = await rec(w, identifier);
    expect(r.gates.security.verdict).toBe("FAIL");
    expect(r.gates.security.note).toBe("publish_guard:secret_detected");
    expect(r.gates.pr.verdict).toBeNull();
    expect(r.stage).toBe("working");
    expect(r.pipelineStage).toBe("security");
    const inbox = inboxFiles(path);
    expect(inbox.length).toBe(1);
    const finding = readFileSync(join(path, ".wingmate", "inbox", inbox[0] ?? ""), "utf8");
    expect(finding).toContain("secret_detected");
    expect(finding).not.toContain("S3cretPassw0rd"); // never echo the secret
    const nonce = (await w.ctx.ledger.readIssue(identifier)).find((e) => e.type === "kit_installed")?.data
      .nonce;
    expect(finding).toContain(`<untrusted nonce="${String(nonce)}">`); // fenced with the brief's nonce
    // the pointer is delivered in the same tick
    expect(
      w.orca.calls.some(
        (c) => c.verb === "terminalSend" && JSON.stringify(c.args).includes("publish refused"),
      ),
    ).toBe(true);
  });

  test("F1: a secret in an added Markdown line refuses with secret_detected and nothing is pushed (docs skip only entropy)", async () => {
    const { w, identifier, path } = await setup();
    w.git.changed.set(path, ["docs/setup.md"]);
    // a long keyed placeholder in a doc is no finding: only the entropy heuristic is skipped for docs
    w.git.added.set(path, [
      {
        path: "docs/setup.md",
        line: "token: 9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddccbbaa99887766554433221100",
      },
    ]);
    expect(await runGuards(w.ctx, await rec(w, identifier), issueOf(w), "t", "b")).toBeNull();
    w.git.added.set(path, [
      {
        path: "docs/setup.md",
        line: "DATABASE_URL=postgresql://app:S3cretPassw0rd@ep-cool-sound-123456.us-east-2.aws.neon.tech/neondb",
      },
      { path: "docs/setup.md", line: "GH_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12" },
    ]);
    expect(await call(w, identifier)).toBe(false);
    expect(w.git.pushed).toEqual([]);
    expect(w.gh.prs).toEqual([]);
    expect((await rec(w, identifier)).gates.security.note).toBe("publish_guard:secret_detected");
    const finding = readFileSync(join(path, ".wingmate", "inbox", inboxFiles(path)[0] ?? ""), "utf8");
    expect(finding).toContain("postgres_url in docs/setup.md");
    expect(finding).toContain("github in docs/setup.md");
    expect(finding).not.toContain("S3cretPassw0rd");
    expect(finding).not.toContain("ghij12");
  });

  test("a connection string in the PR body is refused too", async () => {
    const { w, identifier, path } = await setup();
    writeFileSync(join(path, ".wingmate", "s.md"), "Uses postgres://u:p@db.example.com/x for tests");
    expect(await call(w, identifier)).toBe(false);
    expect(w.git.pushed).toEqual([]);
    expect((await rec(w, identifier)).gates.security.note).toBe("publish_guard:secret_detected");
  });

  test("the PR title is scanned too: a token in --title refuses, and the finding withholds it", async () => {
    const { w, identifier, path } = await setup();
    const title = "Rotate GH_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12";
    expect(await call(w, identifier, finishIntent(identifier, { title }))).toBe(false);
    expect(w.git.pushed).toEqual([]);
    const finding = readFileSync(join(path, ".wingmate", "inbox", inboxFiles(path)[0] ?? ""), "utf8");
    expect(finding).not.toContain("ghij12");
  });

  test("the completion comment's shorter summary is scanned as it will be posted, before anything is pushed", async () => {
    const { w, identifier, path } = await setup();
    // a path-like token is no secret in the PR body; cut where the completion's summary ends, it reads as a keyed token
    const token = "q7Zp3Lm9Xc2Vb8Nn/4Qw6Er1Ty5Ui0Op7/As9Df8Gh7Jk6Lz5";
    const lead = `${"lorem ".repeat(242)}lorem.\ntoken: `;
    expect(lead.length + token.indexOf("/As9") + 1).toBe(1500); // the cut falls right after the second slash
    writeFileSync(join(path, ".wingmate", "s.md"), `${lead}${token}\n`);
    expect(await call(w, identifier)).toBe(false);
    expect(w.git.pushed).toEqual([]);
    expect(w.linear.writes.filter((x) => x.kind === "attachment")).toEqual([]);
    expect((await rec(w, identifier)).gates.security.note).toBe("publish_guard:secret_detected");
  });

  test("forbidden path → path_guard, nothing pushed", async () => {
    const { w, identifier, path } = await setup();
    w.git.changed.set(path, [".github/workflows/ci.yml", "src/a.ts"]);
    expect(await call(w, identifier)).toBe(false);
    expect(w.git.pushed).toEqual([]);
    expect((await rec(w, identifier)).gates.security.note).toBe("publish_guard:path_guard");
  });

  test("F3: a forbidden file added and removed again inside the branch is refused (path_guard): the push sends that commit too", async () => {
    const { w, identifier, path } = await setup();
    w.git.changed.set(path, ["src/a.ts"]); // the net diff no longer shows it
    w.git.history.set(path, { paths: ["src/a.ts", ".env", ".env"], added: [], messages: "add\n\nremove\n" });
    expect(await call(w, identifier)).toBe(false);
    expect(w.git.pushed).toEqual([]);
    expect(w.gh.prs).toEqual([]);
    expect((await rec(w, identifier)).gates.security.note).toBe("publish_guard:path_guard");
    const finding = readFileSync(join(path, ".wingmate", "inbox", inboxFiles(path)[0] ?? ""), "utf8");
    expect(finding).toContain("- .env matches the forbidden pattern **/.env* (in the branch history)\n");
    expect(finding.match(/\.env matches/g)).toHaveLength(1);
    expect(finding).toContain("rewrite the unpushed commits");
  });

  test("F3: a secret added by an earlier commit and removed by a later one refuses (secret_detected), value withheld", async () => {
    const { w, identifier, path } = await setup();
    const clean = { path: "src/db.ts", line: "const url = process.env.DATABASE_URL;" };
    w.git.changed.set(path, ["src/db.ts"]);
    w.git.added.set(path, [clean]);
    w.git.history.set(path, {
      paths: ["src/db.ts"],
      added: [
        {
          path: "src/db.ts",
          line: 'const url = "postgresql://app:S3cretPassw0rd@ep-cool-sound-123456.us-east-2.aws.neon.tech/neondb";',
        },
        clean,
      ],
      messages: "read the url from the environment\n\nconnect to the database\n",
    });
    expect(await call(w, identifier)).toBe(false);
    expect(w.git.pushed).toEqual([]);
    expect(w.gh.prs).toEqual([]);
    expect((await rec(w, identifier)).gates.security.note).toBe("publish_guard:secret_detected");
    const finding = readFileSync(join(path, ".wingmate", "inbox", inboxFiles(path)[0] ?? ""), "utf8");
    expect(finding).toContain("- postgres_url in src/db.ts (in the branch history; value withheld)\n");
    expect(finding).not.toContain("S3cretPassw0rd");
  });

  test("F3: a token in a commit message refuses too (the push sends the messages)", async () => {
    const { w, identifier, path } = await setup();
    w.git.history.set(path, {
      paths: [],
      added: [],
      messages: "Rotate GH_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12\n",
    });
    expect(await call(w, identifier)).toBe(false);
    expect(w.git.pushed).toEqual([]);
    const finding = readFileSync(join(path, ".wingmate", "inbox", inboxFiles(path)[0] ?? ""), "utf8");
    expect(finding).toContain("- github in a commit message (value withheld)\n");
    expect(finding).not.toContain("ghij12");
  });

  test("F3: a secret both at HEAD and in its commit is reported once, as at HEAD", async () => {
    const { w, identifier, path } = await setup();
    const line = { path: "src/db.ts", line: "const k = 'AKIAIOSFODNN7EXAMPLE';" };
    w.git.added.set(path, [line]);
    w.git.history.set(path, { paths: ["src/db.ts"], added: [line], messages: "add the key\n" });
    expect(await call(w, identifier)).toBe(false);
    const finding = readFileSync(join(path, ".wingmate", "inbox", inboxFiles(path)[0] ?? ""), "utf8");
    expect(finding.match(/aws in src\/db\.ts/g)).toEqual(["aws in src/db.ts"]);
    expect(finding).toContain("- aws in src/db.ts (value withheld)\n");
    expect(finding).not.toContain("rewrite the unpushed commits");
  });

  test("manifest change without allow-deps → dependency_policy; granted before claim by the owner → passes", async () => {
    const { w, identifier, path } = await setup();
    w.git.changed.set(path, ["package.json", "bun.lock"]);
    expect(await call(w, identifier)).toBe(false);
    expect((await rec(w, identifier)).gates.security.note).toBe("publish_guard:dependency_policy");
    const issue = issueOf(w);
    issue.labels.push(ALLOW_DEPS);
    w.linear.history.get("i1")?.unshift(grantEntry("2026-10-06T08:00:00.000Z", OWNER));
    const r = await rec(w, identifier);
    r.gates.security.verdict = "PASS";
    await writeRecord(w.dirs, r);
    expect(await runGuards(w.ctx, await rec(w, identifier), issue, "t", "b")).toBeNull();
  });

  test("allow-deps added by a non-approver never counts", async () => {
    const { w, identifier, path } = await setup();
    w.git.changed.set(path, ["package.json"]);
    const issue = issueOf(w);
    issue.labels.push(ALLOW_DEPS);
    w.linear.history.get("i1")?.unshift(grantEntry("2026-10-06T08:00:00.000Z", "guest"));
    expect((await runGuards(w.ctx, await rec(w, identifier), issue, "t", "b"))?.code).toBe(
      "dependency_policy",
    );
  });

  test("allow-deps counts when granted while the record was awaiting-human; not while it worked, never from a bot (§13.3 e)", async () => {
    const { w, identifier } = await setup();
    const issue = issueOf(w);
    issue.labels.push(ALLOW_DEPS);
    const r = await rec(w, identifier);
    r.history.push(
      { at: "2026-10-06T10:10:00.000Z", from: "working", to: "awaiting-human", cause: "ask", evidence: null },
      {
        at: "2026-10-06T10:20:00.000Z",
        from: "awaiting-human",
        to: "working",
        cause: "answer",
        evidence: null,
      },
    );
    const base = w.linear.history.get("i1") ?? [];
    const granted = async (entry: LinearHistoryEntry) => {
      w.linear.history.set("i1", [...base, entry]);
      return allowDepsGranted(w.ctx, r, issue);
    };
    expect(await granted(grantEntry("2026-10-06T10:15:00.000Z", OWNER))).toBe(true); // parked: the answer to a question
    expect(await granted(grantEntry("2026-10-06T10:25:00.000Z", OWNER))).toBe(false); // while the agent worked
    expect(await granted(grantEntry("2026-10-06T08:00:00.000Z", OWNER, "app-bot"))).toBe(false); // a bot, even as the owner
    issue.labels = issue.labels.filter((l) => l.id !== ALLOW_DEPS.id);
    expect(await granted(grantEntry("2026-10-06T08:00:00.000Z", OWNER))).toBe(false); // the label is no longer there
  });

  test("validate not PASS at HEAD → validate_stale", async () => {
    const { w, identifier } = await setup();
    const r = await rec(w, identifier);
    r.gates.validate.headSha = "olderhead";
    await writeRecord(w.dirs, r);
    expect((await runGuards(w.ctx, await rec(w, identifier), issueOf(w), "t", "b"))?.code).toBe(
      "validate_stale",
    );
  });

  test("validate evidence must show exit 0 for every pinned command; a missing, partial, failing or symlinked report is stale", async () => {
    const { w, identifier, path } = await setup();
    const gates = w.cfg.projects.bouncr?.repos.api?.gates ?? [];
    expect(gates.length).toBeGreaterThan(1);
    const report = join(path, ".wingmate", "evidence", "validate", "report.txt");
    const guard = async () =>
      (await runGuards(w.ctx, await rec(w, identifier), issueOf(w), "t", "b"))?.code ?? "cleared";
    writeFileSync(report, pinnedReport(gates.slice(0, 1))); // only the first pinned command
    expect(await guard()).toBe("validate_stale");
    writeFileSync(
      report,
      pinnedReport(
        gates,
        gates.map((_, i) => (i === 1 ? 1 : 0)),
      ),
    );
    expect(await guard()).toBe("validate_stale");
    rmSync(report);
    expect(await guard()).toBe("validate_stale");
    const outside = join(mkdtempSync(join(tmpdir(), "wm-outside-")), "report.txt");
    writeFileSync(outside, pinnedReport(gates));
    symlinkSync(outside, report);
    expect(await guard()).toBe("validate_stale"); // never followed out of the worktree
    rmSync(report);
    writeFileSync(report, pinnedReport(gates));
    expect(await guard()).toBe("cleared");
  });

  test("no commits beyond base → nothing_to_publish", async () => {
    const { w, identifier, path } = await setup();
    w.git.commits.set(path, 0);
    expect((await runGuards(w.ctx, await rec(w, identifier), issueOf(w), "t", "b"))?.code).toBe(
      "nothing_to_publish",
    );
  });

  test("second guard failure in the same cycle → blocked (publish_guard)", async () => {
    const { w, identifier, path } = await setup();
    w.git.changed.set(path, [".github/x.yml"]);
    expect(await call(w, identifier)).toBe(false);
    const r1 = await rec(w, identifier);
    r1.pipelineStage = "pr";
    await writeRecord(w.dirs, r1);
    expect(await call(w, identifier)).toBe(false);
    const r2 = await rec(w, identifier);
    expect(r2.stage).toBe("blocked");
    expect(r2.history.at(-1)?.cause).toBe("publish_guard");
    expect(w.git.pushed).toEqual([]);
    expect(w.linear.comments.filter((c) => c.body.startsWith("<!-- wingmate:blocked -->"))).toHaveLength(1);
  });

  test("C11: a refusal writes nothing through a symlinked .wingmate/inbox and sends no pointer to a file never written", async () => {
    const { w, identifier, path } = await setup();
    w.git.changed.set(path, [".github/x.yml"]);
    const outside = mkdtempSync(join(tmpdir(), "wm-outside-"));
    const inbox = join(path, ".wingmate", "inbox");
    rmSync(inbox, { recursive: true, force: true });
    symlinkSync(outside, inbox);
    const sends = w.orca.calls.filter((c) => c.verb === "terminalSend").length;
    expect(await call(w, identifier)).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
    expect(w.orca.calls.filter((c) => c.verb === "terminalSend").length).toBe(sends);
    const r = await rec(w, identifier);
    expect(r.attention).toContain("inbox_unsafe");
    expect(r.gates.security.note).toBe("publish_guard:path_guard");
    expect(w.git.pushed).toEqual([]);
  });

  test("a refusal with the coordinator gone relaunches a successor pointed at .wingmate/", async () => {
    const { w, identifier, path } = await setup();
    w.git.changed.set(path, [".github/x.yml"]);
    const r0 = await rec(w, identifier);
    w.orca.killTerminal(worktreeOf(r0).id, r0.coordinator.terminalHandle ?? "");
    expect(await call(w, identifier)).toBe(false);
    expect(inboxFiles(path)).toHaveLength(1);
    const relaunches = (await w.ctx.ledger.readIssue(identifier)).filter((e) => e.type === "relaunch");
    expect(relaunches.map((e) => e.data.reason)).toEqual(["publish_refused"]);
    expect((await rec(w, identifier)).coordinator.terminalHandle).not.toBe(r0.coordinator.terminalHandle);
  });

  test("an invalid record branch is never pushed (git ref-name rules)", async () => {
    const { w, identifier } = await setup();
    const r = await rec(w, identifier);
    worktreeOf(r).branch = "--upload-pack=touch /tmp/x";
    await writeRecord(w.dirs, r);
    await expect(call(w, identifier)).rejects.toMatchObject({ code: "branch_invalid" });
    expect(w.git.pushed).toEqual([]);
    expect(w.gh.prs).toEqual([]);
  });
});

describe("publish success and replay (§6.6, I4, I9)", () => {
  test("push → PR → attachment → one completion comment → Review-Ready + In Review → stage review", async () => {
    const { w, identifier, path } = await setup();
    w.git.changed.set(path, ["src/a.ts"]);
    w.git.added.set(path, [{ path: "src/a.ts", line: "export const a = 1;" }]);
    expect(await call(w, identifier)).toBe(true);
    expect(w.git.pushed.length).toBe(1);
    expect(w.gh.prs.length).toBe(1);
    const r = await rec(w, identifier);
    expect(r.stage).toBe("review");
    expect(r.prs[0]?.url).toBe("https://github.com/fake/repo/pull/1");
    expect(r.gates.pr.verdict).toBe("PASS");
    expect(r.gates.pr.headSha).toBe("headsha");
    expect(r.gates.security.verdict).toBe("PASS");
    const issue = issueOf(w);
    expect(issue.state.name).toBe("In Review");
    expect(issue.labels.map((l) => l.name)).toContain("Review-Ready");
    expect(issue.attachments.map((a) => a.url)).toContain("https://github.com/fake/repo/pull/1");
    expect(completions(w).length).toBe(1);
    expect(existsSync(join(path, ".wingmate", "evidence"))).toBe(true);
    // the exact verified commit, on the record's own branch only
    expect(w.git.pushed).toEqual([`${path}:${worktreeOf(r).branch}`]);
    expect(w.git.remoteSha.get(worktreeOf(r).branch)).toBe("headsha");
    const entries = (await w.ctx.journal.all()).filter((e) => e.kind === "publish");
    expect(entries.map((e) => e.state)).toEqual(["confirmed"]);
    expect(entries[0]?.steps.map((s) => `${s.name}:${s.state}`)).toEqual([
      "push:done",
      "pr:done",
      "attach:done",
      "complete:done",
      "linear:done",
    ]);
  });

  test("the PR carries the identifier in its title and the request-changes line in its body", async () => {
    const { w, identifier } = await setup();
    const seen: { title: string; body: string; head: string }[] = [];
    const create = w.gh.prCreate.bind(w.gh);
    w.gh.prCreate = async (cwd, a) => {
      seen.push({ title: a.title, body: a.body, head: a.head });
      return create(cwd, a);
    };
    expect(await call(w, identifier)).toBe(true);
    expect(seen[0]?.title).toBe("iOS leaderboard (JRF-601)");
    expect(seen[0]?.body).toContain("To request changes: move this issue back to In Progress");
    expect(seen[0]?.body).toContain("https://linear.app/jrf/issue/JRF-601");
    expect(seen[0]?.head).toBe(worktreeOf(await rec(w, identifier)).branch);
  });

  test("a title the agent gave keeps the identifier, also when it names the issue only past the title's length", async () => {
    const { w, identifier } = await setup();
    const titles: string[] = [];
    const create = w.gh.prCreate.bind(w.gh);
    w.gh.prCreate = async (cwd, a) => {
      titles.push(a.title);
      return create(cwd, a);
    };
    const title = `${"Rework the scoring service ".repeat(6)}JRF-601`;
    expect(await call(w, identifier, finishIntent(identifier, { title }))).toBe(true);
    expect(titles[0]?.length).toBeLessThanOrEqual(120);
    expect(titles[0]?.endsWith(" (JRF-601)")).toBe(true);
  });

  test("the guards read the diff at the HEAD that is pushed, even when HEAD moves afterwards", async () => {
    const { w, identifier } = await setup();
    let heads = 0;
    w.git.revParse = async (_c: string, ref: string) =>
      ref === "HEAD" ? (heads++ ? "moved" : "headsha") : "basesha";
    const read: (string | undefined)[] = [];
    const changed = w.git.changedPaths.bind(w.git);
    const added = w.git.addedLines.bind(w.git);
    const ahead = w.git.commitsAhead.bind(w.git);
    w.git.changedPaths = async (cwd, base, head) => {
      read.push(head);
      return changed(cwd, base, head);
    };
    w.git.addedLines = async (cwd, base, head) => {
      read.push(head);
      return added(cwd, base, head);
    };
    w.git.commitsAhead = async (cwd, base, head) => {
      read.push(head);
      return ahead(cwd, base, head);
    };
    const history = w.git.historyChanges.bind(w.git);
    w.git.historyChanges = async (cwd, base, head) => {
      read.push(`history:${head}`);
      return history(cwd, base, head);
    };
    expect(await call(w, identifier)).toBe(true);
    expect(read).toEqual(["headsha", "headsha", "history:headsha", "headsha"]); // the pushed history too (F3)
    expect(w.git.remoteSha.get(worktreeOf(await rec(w, identifier)).branch)).toBe("headsha");
  });

  test("Linear failure after the PR exists → replay pushes nothing twice and keeps one PR, one attachment, one completion comment", async () => {
    const { w, identifier, path } = await setup();
    w.git.changed.set(path, ["src/a.ts"]);
    w.linear.failNext = "issueUpdate";
    await expect(call(w, identifier)).rejects.toThrow();
    expect(w.git.pushed.length).toBe(1);
    expect(w.gh.prs.length).toBe(1);
    expect((await rec(w, identifier)).attention).toContain("publish_step_failed");
    expect(await call(w, identifier)).toBe(true);
    expect(w.git.pushed.length).toBe(1);
    expect(w.gh.prs.length).toBe(1);
    expect(w.linear.writes.filter((x) => x.kind === "attachment").length).toBe(1);
    expect(completions(w).length).toBe(1);
    const r = await rec(w, identifier);
    expect(r.stage).toBe("review");
    expect(r.prs).toHaveLength(1);
    expect(r.attention).not.toContain("publish_step_failed");
    const entries = (await w.ctx.journal.all()).filter((e) => e.kind === "publish");
    expect(entries.map((e) => e.state)).toEqual(["confirmed"]); // the replay continued the same entry
  });

  test("a later finish edits the existing completion comment instead of posting a second one", async () => {
    const { w, identifier, path } = await setup();
    w.git.changed.set(path, ["src/a.ts"]);
    expect(await call(w, identifier)).toBe(true);
    const first = completions(w)[0];
    const r = await rec(w, identifier);
    await transition(w.ctx, r, "working", "review_feedback");
    r.pipelineStage = "implement";
    await writeRecord(w.dirs, r);
    w.git.revParse = async (_c: string, ref: string) => (ref === "HEAD" ? "headsha2" : "basesha");
    await readyToFinish(w, identifier);
    writeFileSync(join(path, ".wingmate", "s.md"), "Renamed the endpoint after review.");
    expect(await call(w, identifier)).toBe(true);
    expect(completions(w).map((c) => c.id)).toEqual([first?.id ?? ""]);
    expect(completions(w)[0]?.body).toContain("Renamed the endpoint after review.");
    expect(w.gh.prs.length).toBe(1);
    expect(w.linear.writes.filter((x) => x.kind === "attachment").length).toBe(1);
    expect(w.git.remoteSha.get(worktreeOf(r).branch)).toBe("headsha2");
    expect((await rec(w, identifier)).prs).toHaveLength(1);
  });

  test("the completion comment lists the follow-ups ledgered as followup_created", async () => {
    const { w, identifier } = await setup();
    await w.ctx.ledger.append({
      at: w.ctx.now(),
      issue: identifier,
      type: "followup_created",
      data: { identifier: "JRF-950" },
    });
    expect(await call(w, identifier)).toBe(true);
    expect(completions(w)[0]?.body).toContain("Follow-ups created: JRF-950");
  });
});

describe("publishing in the tick (§6.3 step 2, §6.7, §8.1 finish)", () => {
  async function working(): Promise<{ w: World; identifier: string; path: string; pane: [string, string] }> {
    const w = await world(); // the test world publishes for real
    labeledByOwner(w, todo("i1", "JRF-601"));
    await runTick(w);
    const r = await readyToFinish(w, "JRF-601");
    return {
      w,
      identifier: r.identifier,
      path: worktreeOf(r).path,
      pane: [worktreeOf(r).id, r.coordinator.paneKey ?? ""],
    };
  }
  const finish = (w: World, path: string, pane: [string, string]) => {
    w.orca.setAgentState(pane[0], pane[1], "done", w.ctx.now()); // the coordinator ended its turn after `finish`
    return writeIntent(path, {
      issue: "JRF-601",
      kind: "finish",
      payload: { summaryFile: ".wingmate/s.md", title: null, draft: false, repos: [] },
    });
  };
  const pending = (path: string) =>
    readdirSync(join(path, ".wingmate", "outbox")).filter((n) => n.endsWith(".json"));

  test("a refused finish is one of the tick's resumes: the finding's pointer goes out in the same tick", async () => {
    const { w, identifier, path, pane } = await working();
    w.git.changed.set(path, [".github/workflows/ci.yml"]);
    await finish(w, path, pane);
    advance(w, 5);
    const s = await runTick(w);
    expect(s.finished).toEqual([]);
    expect(s.resumes).toEqual([identifier]);
    expect(await rec(w, identifier)).toMatchObject({ stage: "working", pipelineStage: "security" });
    expect(pending(path)).toEqual([]); // the refused intent is consumed; the agent runs finish again
    const sends = w.orca.calls.filter((c) => c.verb === "terminalSend").map((c) => JSON.stringify(c.args));
    expect(sends.filter((t) => t.includes("publish refused"))).toHaveLength(1);
  });

  test("the second refused finish of the cycle blocks (publish_guard) and is listed as blocked", async () => {
    const { w, identifier, path, pane } = await working();
    w.git.changed.set(path, [".github/workflows/ci.yml"]);
    await finish(w, path, pane);
    advance(w, 5);
    await runTick(w);
    await finish(w, path, pane);
    advance(w, 5);
    const s = await runTick(w);
    expect(s.blocked).toEqual([identifier]);
    expect((await rec(w, identifier)).stage).toBe("blocked");
    expect(w.git.pushed).toEqual([]);
  });

  test("a reconcile-only tick, or one with no resume left, keeps the finish pending; nothing is pushed until then", async () => {
    const { w, identifier, path, pane } = await working();
    await finish(w, path, pane);
    writeFileSync(join(w.dirs.state, "pause.json"), JSON.stringify(["global"]));
    advance(w, 5);
    let s = await runTick(w);
    expect(s.reconcileOnly).toBe(true);
    expect(s.finished).toEqual([]);
    expect(pending(path)).toHaveLength(1);
    rmSync(join(w.dirs.state, "pause.json"));
    w.cfg.defaults.dispatcher.resumesPerTick = 0;
    advance(w, 5);
    s = await runTick(w);
    expect(s.finished).toEqual([]);
    expect(w.git.pushed).toEqual([]);
    expect(pending(path)).toHaveLength(1);
    w.cfg.defaults.dispatcher.resumesPerTick = 3;
    advance(w, 5);
    s = await runTick(w);
    expect(s.finished).toEqual([identifier]);
    expect(w.git.pushed).toHaveLength(1);
  });

  test("a follow-up the agent created before finishing is listed in the one completion comment", async () => {
    const { w, identifier, path, pane } = await working();
    writeFileSync(join(path, ".wingmate", "f.md"), "Extract the scoring helper.");
    await writeIntent(path, {
      issue: identifier,
      kind: "followup",
      payload: { title: "Refactor scoring", bodyFile: ".wingmate/f.md" },
    });
    await finish(w, path, pane);
    advance(w, 5);
    expect((await runTick(w)).finished).toEqual([identifier]);
    const created = (await w.ctx.ledger.readIssue(identifier)).find((e) => e.type === "followup_created");
    expect(typeof created?.data.identifier).toBe("string");
    expect(completions(w)).toHaveLength(1);
    expect(completions(w)[0]?.body).toContain(`Follow-ups created: ${String(created?.data.identifier)}`);
  });
});
