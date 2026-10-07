// src/machine/publish.ts — §13.3(d) and §8.1 `finish`: every guard first, then push → PR → attachment → one completion comment →
// Review-Ready + In Review → `review`, as one journal entry with ordered steps (§6.6, Appendix D). It runs only in the dispatcher's
// own process with the owner's git and gh session; from the worktree it reads only the files it names, through `worktreeFile`.
import { z } from "zod";
import { type ProjectConfig, type RepoConfig, repoFor } from "../config/schema";
import { isBranchName } from "../git/refname";
import type { Intent } from "../kit/intents";
import { readNoFollow, worktreeFile } from "../kit/local";
import { MARK } from "../linear/markers";
import { REQUEST_CHANGES, renderCompletion } from "../linear/templates";
import { depsChanged, depsPolicy } from "../policy/deps";
import { violations } from "../policy/pathguard";
import { type Finding, scanAddedLines, scanText } from "../policy/secrets";
import type { BranchHistory, LinearIssue } from "../ports";
import { WingmateError, errorCode, errorText } from "../shared/errors";
import { isIdentifier } from "../shared/ids";
import type { JournalEntry } from "../state/journal";
import { PIPELINE, type WRecord } from "../state/records";
import type { Ctx } from "./context";
import { isTickAbort } from "./guard";
import { LinearWrites } from "./linearWrites";
import type { Liveness } from "./liveness";
import type { Reconciled } from "./reconcile";
import { block } from "./release";
import { type Persisted, persistInbox, relaunch, sendPointer } from "./resume";
import { saveRecord } from "./save";
import { addAttention, dropAttention, enterPipelineStage, transition } from "./states";
import { addNote } from "./status";

type FinishIntent = Extract<Intent, { kind: "finish" }>;
type Worktree = NonNullable<WRecord["worktree"]>;
export interface GuardFailure {
  code: "nothing_to_publish" | "path_guard" | "secret_detected" | "dependency_policy" | "validate_stale";
  lines: string[];
}
/** What the journaled steps publish once the guards cleared the commit `head`. */
interface Cleared {
  wt: Worktree;
  repo: RepoConfig;
  head: string;
  title: string;
  body: string;
  summary: string;
  draft: boolean;
  limitations: string[];
}

const EPOCH = "1970-01-01T00:00:00.000Z";
const STEPS = ["push", "pr", "attach", "complete", "linear"];
/** Where `gate validate` writes its report (§8.2 stage 4). */
const VALIDATE_REPORT = ".wingmate/evidence/validate/report.txt";
const SUMMARY_MAX_BYTES = 64 * 1024;
const REPORT_MAX_BYTES = 1024 * 1024;
const SUMMARY_MAX = 4000;
/** The completion comment's summary: a prefix of the PR body's. */
const COMPLETION_SUMMARY_MAX = 1500;
const TITLE_MAX = 120;
const FINDINGS_SHOWN = 50;
const PrReceipt = z.object({ number: z.number().int().positive(), url: z.string().url() });
type Pr = z.infer<typeof PrReceipt>;
const ms = (iso: string) => Date.parse(iso);

function projectOf(ctx: Ctx, r: WRecord): ProjectConfig {
  const p = ctx.cfg.projects[r.project];
  if (!p)
    throw new WingmateError("unknown_project", `${r.identifier}: project ${r.project} is not configured`);
  return p;
}

/** An agent-named file, read only through `worktreeFile` (inside the worktree, not a symlink) and without following a symlink. */
async function agentText(wt: string, rel: string): Promise<string> {
  const f = await worktreeFile(wt, rel);
  if (!f.ok) throw new WingmateError("file_invalid", f.error);
  return (await readNoFollow(f.abs, SUMMARY_MAX_BYTES)).toString("utf8");
}

/**
 * §13.3(e): `allow-deps` counts only while the label is on the issue and its latest grant — the history entry that last added it — was
 * made by an approver as a human (no bot actor), before this cycle's claim or while the record was parked `awaiting-human` (the owner
 * granting it in answer to a question).
 */
export async function allowDepsGranted(ctx: Ctx, r: WRecord, issue: LinearIssue): Promise<boolean> {
  const labelId = ctx.meta.labels.find((l) => l.name === ctx.cfg.labels.allowDeps)?.id;
  if (!labelId || !issue.labels.some((l) => l.id === labelId)) return false;
  const grant = (await ctx.linear.issueHistory(issue.id, EPOCH))
    .filter((h) => h.addedLabelIds.includes(labelId))
    .sort((a, b) => ms(a.createdAt) - ms(b.createdAt))
    .at(-1);
  if (!grant || grant.botActorId || !grant.actorId || !ctx.cfg.workspace.approvers.includes(grant.actorId))
    return false;
  const at = ms(grant.createdAt);
  if (at < ms(r.claimedAt)) return true;
  return r.history.some((h, i) => {
    const out = r.history[i + 1];
    return h.to === "awaiting-human" && at >= ms(h.at) && (!out || at <= ms(out.at));
  });
}

/** `gate validate`'s report shows `exit 0` under the `$ <argv>` line of every pinned command, and no other exit anywhere. */
function provesExitZero(report: string, pinned: string[][]): boolean {
  const exitOf = new Map<string, string>();
  const lines = report.split("\n");
  for (const [i, line] of lines.entries()) {
    if (line.startsWith("exit ") && line !== "exit 0") return false; // a failed or timed-out command (output lines are `| `-prefixed)
    if (line.startsWith("$ ")) exitOf.set(line.slice(2), lines[i + 1] ?? "");
  }
  return pinned.every((argv) => exitOf.get(argv.join(" ")) === "exit 0");
}

/**
 * §8.1: `validate` is verified, not re-run inside the tick: the CLI-computed gate must be PASS at exactly the commit to publish, with
 * its evidence report (read through `worktreeFile`, never through a symlink) showing exit 0 for every pinned command.
 */
async function validateFailure(r: WRecord, wt: Worktree, repo: RepoConfig, head: string) {
  const v = r.gates.validate;
  if (v.verdict !== "PASS" || v.headSha !== head)
    return stale(
      `validate is ${v.verdict ?? "not run"} at ${v.headSha ?? "no commit"}; the commit to publish is ${head}`,
    );
  const f = await worktreeFile(wt.path, VALIDATE_REPORT, ".wingmate/evidence");
  const report = f.ok
    ? await readNoFollow(f.abs, REPORT_MAX_BYTES).then(
        (b) => b.toString("utf8"),
        () => null,
      )
    : null;
  if (report === null || !provesExitZero(report, repo.gates))
    return stale(`${VALIDATE_REPORT} is missing or does not show exit 0 for every pinned command`);
  return null;
}
const stale = (line: string): GuardFailure => ({ code: "validate_stale", lines: [line] });

/** Marks what only the pushed history shows (F3): HEAD no longer has it, but the push would still send the commit that does. */
const IN_HISTORY = "in the branch history";
const IN_MESSAGE = "in a commit message";
const OUTBOUND = "the PR or completion text";

/**
 * Secret findings over all that the push and the publish writes send: the net diff's added lines and the outbound text, then (F3) the
 * lines the branch's commits added — each one the net diff already shows is not repeated — and the commit messages. A finding names a
 * pattern and a place, never a value.
 */
function secretFindings(added: { path: string; line: string }[], history: BranchHistory, outbound: string) {
  const place = (f: Finding) => `${f.pattern} in ${f.path ?? OUTBOUND}`;
  const net = [...scanAddedLines(added), ...scanText(outbound, OUTBOUND)].map(place);
  const shown = new Set(net);
  const earlier = [...new Set(scanAddedLines(history.added).map(place))].filter((p) => !shown.has(p));
  const messages = [...new Set(scanText(history.messages).map((f) => `${f.pattern} ${IN_MESSAGE}`))];
  return [
    ...net.map((p) => `${p} (value withheld)`),
    ...earlier.map((p) => `${p} (${IN_HISTORY}; value withheld)`),
    ...messages.map((p) => `${p} (value withheld)`),
  ];
}

/**
 * §13.3(d), in its order, at the commit `head` (default: HEAD now): commits beyond the base, the path guard over every changed path
 * (renames from both sides, deletions included) against the merged `forbiddenPaths`, the secret scan over the added lines and the
 * outbound text (`title`, and `body`: the PR body, to which `publish` adds the completion comment's summary), the dependency policy,
 * and `validate` verified at that commit. The path guard and the secret scan also read every commit the push sends (F3): a path or
 * line one commit added and a later one removed is absent from the net diff, never from the pushed pack. Findings name patterns and
 * paths, never values.
 */
export async function runGuards(
  ctx: Ctx,
  r: WRecord,
  issue: LinearIssue,
  title: string,
  body: string,
  head?: string,
): Promise<GuardFailure | null> {
  const wt = r.worktree;
  if (!wt) throw new WingmateError("publish_no_worktree", `${r.identifier} has no worktree`);
  const project = projectOf(ctx, r);
  const repo = repoFor(project, r.repo);
  const at = head ?? (await ctx.git.revParse(wt.path, "HEAD"));
  if ((await ctx.git.commitsAhead(wt.path, wt.baseSha, at)) === 0)
    return { code: "nothing_to_publish", lines: ["the branch has no commits beyond its base SHA"] };
  const changed = await ctx.git.changedPaths(wt.path, wt.baseSha, at);
  const history = await ctx.git.historyChanges(wt.path, wt.baseSha, at);
  const net = new Set(changed);
  const forbidden = [...project.forbiddenPaths, ...repo.forbiddenPaths];
  const vio = violations([...new Set([...changed, ...history.paths])], forbidden);
  if (vio.length)
    return {
      code: "path_guard",
      lines: vio.map(
        (v) =>
          `${v.path} matches the forbidden pattern ${v.pattern}${net.has(v.path) ? "" : ` (${IN_HISTORY})`}`,
      ),
    };
  const added = await ctx.git.addedLines(wt.path, wt.baseSha, at);
  const secrets = secretFindings(added, history, `${title}\n${body}`);
  if (secrets.length) return { code: "secret_detected", lines: secrets };
  const manifests = depsChanged(changed);
  if (manifests.length && !depsPolicy(changed, await allowDepsGranted(ctx, r, issue)).ok)
    return {
      code: "dependency_policy",
      lines: manifests.map(
        (p) => `${p} changed without an approver-granted ${ctx.cfg.labels.allowDeps} label`,
      ),
    };
  return validateFailure(r, wt, repo, at);
}

const gateTable = (r: WRecord): [string, string][] => PIPELINE.map((s) => [s, r.gates[s].verdict ?? "–"]);
const evidenceNames = (r: WRecord): string[] => [
  ...new Set(PIPELINE.flatMap((s) => r.gates[s].evidencePath ?? [])),
];

/** §8.2 stage 7: the PR title carries "(JRF-n)"; a title the agent gave is kept when it names the issue already. */
function prTitle(r: WRecord, issue: LinearIssue, given: string | null): string {
  const base = (given ?? "").replace(/\s+/g, " ").trim() || issue.title.replace(/\s+/g, " ").trim();
  if (base.slice(0, TITLE_MAX).includes(r.identifier)) return base.slice(0, TITLE_MAX);
  const tag = ` (${r.identifier})`;
  return `${base.slice(0, TITLE_MAX - tag.length).trimEnd()}${tag}`;
}

/** §8.2 stage 7: Linear link, gate table, evidence names (the files stay local, §13.3 f) and the §7.3 request-changes line. */
const renderPrBody = (p: {
  identifier: string;
  url: string;
  summary: string;
  gates: [string, string][];
  evidence: string[];
}): string =>
  [
    "## Summary",
    p.summary,
    "",
    "## Linear",
    `${p.identifier} — ${p.url}`,
    "",
    "## Gates",
    ...p.gates.map(([n, v]) => `- ${n}: ${v}`),
    "",
    "## Evidence",
    ...(p.evidence.length ? p.evidence.map((e) => `- ${e}`) : ["- none"]),
    "",
    "_Evidence stays in the issue worktree under `.wingmate/evidence/`; it is never committed or attached._",
    "",
    `_${REQUEST_CHANGES}_`,
    "",
    "_Opened by Wingmate from an isolated Orca worktree._",
  ].join("\n");

/**
 * §8.1 `finish`, run for the outbox: true once the PR is open and the issue is In Review (`review`); false when the guards refused
 * (nothing is pushed: a first refusal delivered its pointer, the second of the cycle blocked the issue). A failed step throws with
 * its progress on disk, and the retried intent continues the same journal entry — no second push, PR, attachment or comment.
 */
export async function publish(
  ctx: Ctx,
  r: WRecord,
  issue: LinearIssue,
  intent: FinishIntent,
  rec: Reconciled,
): Promise<boolean> {
  const wt = r.worktree;
  if (!wt) throw new WingmateError("publish_no_worktree", `${r.identifier} has no worktree`);
  if (!isBranchName(wt.branch))
    throw new WingmateError(
      "branch_invalid",
      `${r.identifier}: the record's branch breaks git's ref-name rules; nothing was pushed`,
      "re-queue the issue (Orca names the branch at claim)",
    );
  const project = projectOf(ctx, r);
  const repo = repoFor(project, r.repo);
  const summary = (await agentText(wt.path, intent.payload.summaryFile)).slice(0, SUMMARY_MAX);
  const title = prTitle(r, issue, intent.payload.title);
  const gates = gateTable(r);
  const body = renderPrBody({
    identifier: r.identifier,
    url: issue.url,
    summary,
    gates,
    evidence: evidenceNames(r),
  });
  const head = await ctx.git.revParse(wt.path, "HEAD"); // the one commit every guard reads and the push sends
  // the completion comment's shorter summary prefix is scanned as it will be posted (a token cut at its end reads differently), so
  // no Linear write after the push can refuse it
  const scanned = `${body}\n${summary.slice(0, COMPLETION_SUMMARY_MAX)}`;
  const failure = await runGuards(ctx, r, issue, title, scanned, head);
  if (failure) return refusePublish(ctx, r, issue, failure, rec);
  const limitations = intent.payload.repos
    .filter((name) => name !== r.repo && Object.hasOwn(project.repos, name))
    .map((name) => `repo ${name} is not published (one repository per issue in slice 1)`);
  const draft = intent.payload.draft;
  return pushAndComplete(ctx, r, issue, { wt, repo, head, title, body, summary, draft, limitations });
}

/**
 * Appendix D: one `publish` entry per record, cycle, attempt and commit. A replay continues the open entry's remaining steps; any other
 * open entry of the issue (an earlier commit's) is superseded.
 */
async function publishEntry(ctx: Ctx, r: WRecord, head: string): Promise<JournalEntry> {
  const key = `publish:${r.identifier}:${r.cycle}:${r.coordinator.attempt}:${head}`;
  const open = (await ctx.journal.pending()).filter((e) => e.issue === r.identifier && e.kind === "publish");
  const mine = open.filter((e) => e.key === key).at(-1);
  for (const e of open) if (e !== mine) await ctx.journal.abandon(e.id, "superseded");
  return (
    mine ??
    (await ctx.journal.intent({
      issue: r.identifier,
      kind: "publish",
      key,
      input: { head, branch: r.worktree?.branch ?? null },
      steps: STEPS,
    }))
  );
}

/** Appendix D `gitPush`: the cleared commit to the record's branch unless origin has it already; `ls-remote` proves it. */
async function pushExact(ctx: Ctx, wt: Worktree, head: string): Promise<void> {
  if ((await ctx.git.lsRemoteSha(wt.path, wt.branch)) !== head) await ctx.git.push(wt.path, wt.branch, head);
  if ((await ctx.git.lsRemoteSha(wt.path, wt.branch)) !== head)
    throw new WingmateError("push_unconfirmed", `${wt.branch}: origin does not show the pushed commit`);
}

/** `gh pr create --head <branch>`, reusing the branch's open PR (Appendix D `prCreate`; never `--web`, never a merge). */
const openPr = (ctx: Ctx, c: Cleared): Promise<Pr> =>
  ctx.gh.prCreate(c.wt.path, {
    head: c.wt.branch,
    base: c.repo.base.replace(/^origin\//, ""),
    title: c.title,
    body: c.body,
    draft: c.draft,
  });

function prReceipt(e: JournalEntry): Pr {
  const p = PrReceipt.safeParse(e.steps.find((s) => s.name === "pr")?.receipt);
  if (!p.success)
    throw new WingmateError(
      "journal_receipt_invalid",
      `publish ${e.key}: the pr step's receipt does not parse`,
    );
  return p.data;
}

function recordPr(r: WRecord, pr: Pr, head: string): void {
  const known = r.prs.find((p) => p.url === pr.url);
  if (known) Object.assign(known, { state: "OPEN", headSha: head });
  else r.prs.push({ repo: r.repo, number: pr.number, url: pr.url, state: "OPEN", headSha: head });
}

/** The follow-ups the outbox created (ledger `followup_created`), each once. */
async function followups(ctx: Ctx, r: WRecord): Promise<string[]> {
  const ids = (await ctx.ledger.readIssue(r.identifier))
    .filter((e) => e.type === "followup_created")
    .map((e) => e.data.identifier)
    .filter((x): x is string => typeof x === "string" && isIdentifier(x));
  return [...new Set(ids)];
}

/** §11.2: exactly one completion comment per issue — Wingmate's existing one is edited (a later finish), else one is posted. */
async function completionComment(ctx: Ctx, w: LinearWrites, r: WRecord, issue: LinearIssue, c: Cleared) {
  const body = renderCompletion({
    prs: r.prs.map((p) => ({ url: p.url, repo: p.repo })),
    summary: c.summary.slice(0, COMPLETION_SUMMARY_MAX),
    gates: gateTable(r),
    limitations: c.limitations,
    followups: await followups(ctx, r),
  });
  const existing = (await ctx.linear.listComments([issue.id], EPOCH))
    .filter((x) => x.body.startsWith(MARK.completion) && x.botActorId !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (existing) await w.editComment(r, existing.id, body);
  else await w.postComment(r, issue, body, { key: `completion:${r.identifier}:${r.cycle}:${c.head}` });
}

/** §8.1: `review` only once the PR is open and the issue is In Review; the Orca card follows (best effort). */
async function toReview(ctx: Ctx, r: WRecord, wt: Worktree, pr: Pr): Promise<void> {
  await transition(ctx, r, "review", "finish_published", pr.url);
  r.pipelineStage = "pr";
  dropAttention(r, "publish_step_failed");
  addNote(r, `PR ${pr.url}`);
  await ctx.orca
    .worktreeSet(wt.id, { workspaceStatus: "in-review", comment: `PR #${pr.number}` })
    .catch((e: unknown) => {
      if (isTickAbort(e)) throw e;
      ctx.log.warn({ issue: r.identifier, code: errorCode(e) }, "worktree set failed");
    });
}

/** A failed step keeps its progress on disk; the entry counts the failure (three poison it) and the issue is flagged. */
async function stepFailed(ctx: Ctx, r: WRecord, entryId: string, err: unknown): Promise<void> {
  if (!isTickAbort(err)) {
    await ctx.journal.failed(entryId, errorText(err));
    if ((await ctx.journal.get(entryId)).state === "poisoned") addAttention(r, "journal_poisoned");
    addAttention(r, "publish_step_failed");
    ctx.log.warn({ issue: r.identifier, code: errorCode(err) }, "publish step failed");
  }
  await saveRecord(ctx, r); // an abort is no failed step, but what it already did is kept all the same
}

/** The journaled steps; each one done in an earlier attempt of this entry is skipped (its receipt reused). */
async function pushAndComplete(ctx: Ctx, r: WRecord, issue: LinearIssue, c: Cleared): Promise<boolean> {
  const entry = await publishEntry(ctx, r, c.head);
  const done = (step: string) => entry.steps.some((s) => s.name === step && s.state === "done");
  const w = new LinearWrites(ctx);
  try {
    if (!done("push")) {
      await pushExact(ctx, c.wt, c.head);
      await ctx.journal.stepDone(entry.id, "push", { head: c.head, branch: c.wt.branch });
    }
    const pr = done("pr") ? prReceipt(entry) : await openPr(ctx, c);
    if (!done("pr")) await ctx.journal.stepDone(entry.id, "pr", pr);
    recordPr(r, pr, c.head);
    await saveRecord(ctx, r);
    if (!done("attach")) {
      await w.attach(r, issue, pr.url, `${r.repo} PR #${pr.number}`);
      await ctx.journal.stepDone(entry.id, "attach", null);
    }
    const at = ctx.now();
    r.gates.security = {
      ...r.gates.security,
      verdict: "PASS",
      at,
      headSha: c.head,
      note: "recomputed at publish",
    };
    r.gates.pr = { ...r.gates.pr, verdict: "PASS", at, headSha: c.head, note: pr.url };
    if (!done("complete")) {
      await completionComment(ctx, w, r, issue, c);
      await ctx.journal.stepDone(entry.id, "complete", null);
    }
    await w.setLifecycle(r, issue, "Review-Ready");
    await w.setState(r, issue, "In Review");
    await ctx.journal.stepDone(entry.id, "linear", null);
    await toReview(ctx, r, c.wt, pr);
    await ctx.journal.confirmed(entry.id);
    await saveRecord(ctx, r);
    return true;
  } catch (err) {
    await stepFailed(ctx, r, entry.id, err);
    throw err;
  }
}

/** The finding as the coordinator reads it (fenced by `persistInbox`): codes, patterns and paths — never a secret's value. */
function findingText(r: WRecord, f: GuardFailure): string {
  const shown = f.lines.slice(0, FINDINGS_SHOWN);
  const more = f.lines.length - shown.length;
  const inHistory = f.lines.some((l) => l.includes(IN_HISTORY) || l.includes(IN_MESSAGE));
  return [
    `publish refused: ${f.code}`,
    ...shown.map((l) => `- ${l}`),
    ...(more > 0 ? [`- and ${more} more`] : []),
    "",
    ...(inHistory
      ? [
          "The push sends every commit of the branch, so a finding in the branch history or in a commit message would be published although HEAD no longer has it: rewrite the unpushed commits until none of them contains it.",
          "",
        ]
      : []),
    `Fix the findings and commit, re-run \`wingmate issue ${r.identifier} gate security\` (and \`gate validate\` when HEAD moved), then \`wingmate issue ${r.identifier} finish\` again.`,
  ].join("\n");
}

/** The pointer to the finding, in this tick (§7.1 step 4 delivery); a coordinator that is gone gets a successor pointed at `.wingmate/`. */
async function pointTo(ctx: Ctx, r: WRecord, inbox: Persisted | "gone" | "unsafe", live: Liveness) {
  if (inbox === "unsafe") return; // nothing was written, so nothing to point at (attention inbox_unsafe)
  const pointer = (rel: string) =>
    `publish refused — read ${rel}, fix, re-gate security and run finish again`;
  const d =
    inbox === "gone" ? "exited" : await sendPointer(ctx, r, "publish", inbox, pointer(inbox.rel), live);
  if (d === "exited") await relaunch(ctx, r, "publish_refused");
}

/**
 * §8.1 `finish` refusal: the finding goes to `.wingmate/inbox/publish-<ulid>.md` (C11 containment, fenced with the brief's nonce),
 * `security` → FAIL (`publish_guard:<code>`), `pr` pending, back to the security stage, and the pointer goes out now — one of the
 * tick's resumes (the outbox counts it). Nothing is pushed. The second refusal of the cycle blocks (`publish_guard`). A refusal is
 * ledgered only once its pointer went out, so a retry after a failed delivery is still the first.
 */
async function refusePublish(
  ctx: Ctx,
  r: WRecord,
  issue: LinearIssue,
  f: GuardFailure,
  rec: Reconciled,
): Promise<false> {
  const prior = (await ctx.ledger.readIssue(r.identifier)).filter(
    (e) => e.type === "publish_refused" && e.data.cycle === r.cycle,
  ).length;
  const inbox = await persistInbox(ctx, r, "publish", findingText(r, f), "security");
  const at = ctx.now();
  r.gates.security = {
    ...r.gates.security,
    verdict: "FAIL",
    failCount: r.gates.security.failCount + 1,
    at,
    note: `publish_guard:${f.code}`,
  };
  r.gates.pr = { ...r.gates.pr, verdict: null };
  enterPipelineStage(ctx, r, "security");
  addNote(r, `publish refused: ${f.code}`);
  ctx.log.warn({ issue: r.identifier, code: f.code }, "publish refused");
  const data = { code: f.code, cycle: r.cycle, findings: f.lines.length };
  const refused = { at, issue: r.identifier, type: "publish_refused", data };
  if (prior >= 1) {
    await ctx.ledger.append(refused);
    const where = typeof inbox === "object" ? inbox.rel : "the worktree";
    const next = `inspect ${where}, fix the findings, then move the issue back to Todo to re-queue it`;
    await block(ctx, r, issue, "publish_guard", f.code, next);
    return false;
  }
  await pointTo(ctx, r, inbox, rec.liveness.get(r.identifier) ?? "exited");
  await ctx.ledger.append(refused);
  await saveRecord(ctx, r);
  return false;
}
