// src/machine/linearWrites.ts — every Linear write Wingmate makes (§11.2), each journaled (§6.6, Appendix D).
import { createHash } from "node:crypto";
import { z } from "zod";
import { scanText } from "../policy/secrets";
import type { LinearIssue } from "../ports";
import { WingmateError, errorText } from "../shared/errors";
import { newUuid } from "../shared/ids";
import type { JournalEntry } from "../state/journal";
import type { WRecord } from "../state/records";
import type { Ctx } from "./context";
import { isTickAbort } from "./guard";

const h = (o: unknown) => createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 16);
const EPOCH = "1970-01-01T00:00:00.000Z";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Created = z.object({ id: z.string().min(1) });
const CreatedIssue = z.object({ id: z.string().min(1), identifier: z.string().min(1) });

export interface JournalOp {
  kind: JournalEntry["kind"];
  key: string;
  input: unknown;
  /** Appendix D: a write keyed by a Wingmate id is skipped when a confirmed entry with that key exists (replay after a crash). */
  dedupe: boolean;
}

/**
 * One external write as a journal entry: intent → act → acted → confirmed; a failure stays `intent` with the error and its
 * attempt counted (three make it `poisoned`) and is rethrown. A deduplicated replay returns the confirmed entry's receipt.
 * REL-3 (Appendix D: confirm = the entity exists by id): with `confirm`, a create keyed by a Wingmate id that failed here may still
 * have been committed by Linear (a timeout, a 5xx after the commit, a lost response, or Linear refusing the id as taken) — the entity
 * is looked up by that id before an error is believed, and on a retry before it is sent again; found, the entry is confirmed.
 */
export async function journaled<T>(
  ctx: Ctx,
  r: WRecord,
  op: JournalOp,
  act: () => Promise<T>,
  receipt: z.ZodType<T>,
  confirm?: () => Promise<T | null>,
): Promise<T> {
  let retry = false;
  if (op.dedupe) {
    const same = (await ctx.journal.all()).filter(
      (e) => e.issue === r.identifier && e.kind === op.kind && e.key === op.key,
    );
    const prior = same.find((e) => e.state === "confirmed");
    if (prior) {
      const p = receipt.safeParse(prior.receipt);
      if (!p.success)
        throw new WingmateError(
          "journal_receipt_invalid",
          `${op.kind} ${op.key}: the confirmed receipt does not parse`,
        );
      return p.data;
    }
    retry = same.length > 0;
  }
  const e = await ctx.journal.intent({ issue: r.identifier, kind: op.kind, key: op.key, input: op.input });
  const found = async (): Promise<T | null> => {
    const got = confirm ? await confirm() : null;
    if (got === null) return null;
    await ctx.journal.acted(e.id, got);
    await ctx.journal.confirmed(e.id);
    return got;
  };
  let out: T;
  try {
    const earlier = retry ? await found() : null;
    if (earlier !== null) return earlier;
    out = await act();
  } catch (err) {
    if (!isTickAbort(err)) {
      const late = await found().catch(() => null);
      if (late !== null) return late;
    }
    await ctx.journal.failed(e.id, errorText(err));
    throw err;
  }
  await ctx.journal.acted(e.id, out ?? null);
  await ctx.journal.confirmed(e.id);
  return out;
}

/** §11.2: every outbound text passes the secret scanner; a hit rejects the write (never a redacted version). */
function assertNoSecret(r: WRecord, text: string): void {
  const f = scanText(text);
  if (f.length)
    throw new WingmateError(
      "secret_detected",
      `${r.identifier}: outbound text holds ${f.length} secret-like token(s) (${f.map((x) => x.pattern).join(",")})`,
      "the write was refused; the text is not posted",
    );
}

const sameIds = (a: { id: string }[], b: { id: string }[]) => {
  const x = new Set(a.map((l) => l.id));
  return x.size === new Set(b.map((l) => l.id)).size && b.every((l) => x.has(l.id));
};

export class LinearWrites {
  constructor(private readonly ctx: Ctx) {}

  /**
   * REL-3: the Wingmate id a keyed create was sent with before (its newest journal entry of that key), so a retry sends the same id —
   * Linear then refuses it as taken instead of creating a second entity — or a fresh one for a first attempt or an unkeyed write.
   */
  private async keyedId(r: WRecord, kind: JournalOp["kind"], key: string | undefined): Promise<string> {
    if (!key) return newUuid();
    const prior = (await this.ctx.journal.all())
      .filter((e) => e.issue === r.identifier && e.kind === kind && e.key === key)
      .at(-1);
    const id = (prior?.input as { id?: unknown } | null | undefined)?.id;
    return typeof id === "string" && UUID.test(id) ? id : newUuid();
  }

  /**
   * §5.2 "Linear wins" / I5: re-read the issue immediately before a label or state write; when its state or labels differ from the
   * snapshot this write was computed from, the owner changed it — the write is dropped (`linear_conflict`) and the next tick
   * re-derives from the owner's change. The snapshot is kept in step with Wingmate's own writes below.
   */
  private async assertUnchanged(r: WRecord, issue: LinearIssue): Promise<void> {
    const [fresh] = await this.ctx.linear.getIssues([issue.id]);
    if (!fresh)
      throw new WingmateError("linear_conflict", `${r.identifier}: the issue can no longer be read`);
    if (fresh.state.id !== issue.state.id || !sameIds(fresh.labels, issue.labels))
      throw new WingmateError(
        "linear_conflict",
        `${r.identifier}: the issue changed in Linear after this tick read it; the write was dropped`,
        "the next tick applies the owner's change",
      );
  }

  /** Replaces the Lifecycle label within its single-select group; other labels are never touched (§5.2). No-op when already set. */
  async setLifecycle(r: WRecord, issue: LinearIssue, name: string | null): Promise<void> {
    const m = this.ctx.meta;
    const current = issue.labels.find((l) => m.lifecycleIds.has(l.id))?.name ?? null;
    if (current !== name || issue.labels.filter((l) => m.lifecycleIds.has(l.id)).length > 1) {
      await this.assertUnchanged(r, issue);
      const keep = issue.labels.filter((l) => !m.lifecycleIds.has(l.id));
      const target = name
        ? [
            {
              id: m.labelId(name),
              name,
              parentId: m.lifecycleGroupId,
              parentName: this.ctx.cfg.labels.lifecycleGroup,
            },
          ]
        : [];
      const labelIds = [...keep.map((l) => l.id), ...target.map((l) => l.id)];
      await journaled(
        this.ctx,
        r,
        { kind: "issueUpdate", key: h({ labelIds }), input: { labelIds }, dedupe: false },
        () => this.ctx.linear.updateIssue(issue.id, { labelIds }).then(() => null),
        z.null(),
      );
      issue.labels = [...keep, ...target];
    }
    r.linear.lifecycleLabel = name;
  }

  /** §11.2: Todo → In Progress at claim, In Progress → In Review at finish; nothing else. */
  async setState(r: WRecord, issue: LinearIssue, stateName: string): Promise<void> {
    if (issue.state.name !== stateName) {
      await this.assertUnchanged(r, issue);
      const stateId = this.ctx.meta.stateId(stateName);
      await journaled(
        this.ctx,
        r,
        { kind: "issueUpdate", key: h({ stateId }), input: { stateId }, dedupe: false },
        () => this.ctx.linear.updateIssue(issue.id, { stateId }).then(() => null),
        z.null(),
      );
      const s = this.ctx.meta.states.find((x) => x.id === stateId);
      if (!s) throw new WingmateError("linear_shape", `state ${stateName} has no team metadata`);
      issue.state = { ...s };
    }
    r.linear.state = stateName;
  }

  async subscribeOwner(r: WRecord, issue: LinearIssue): Promise<void> {
    const owner = this.ctx.cfg.workspace.owner;
    if (!issue.subscriberIds.includes(owner)) {
      await journaled(
        this.ctx,
        r,
        { kind: "subscribe", key: `sub:${owner}:${r.cycle}`, input: { owner }, dedupe: true },
        () => this.ctx.linear.subscribe(issue.id, owner).then(() => null),
        z.null(),
      );
      issue.subscriberIds = [...issue.subscriberIds, owner];
    }
    r.linear.subscribed = true;
  }

  /**
   * Creates a comment under a Wingmate UUID sent as Linear's `input.id`. With `key` (an intent id, a blocked transition), a replay
   * after a crash finds the confirmed entry and returns its comment instead of posting a second one.
   */
  async postComment(
    r: WRecord,
    issue: LinearIssue,
    body: string,
    opts: { parentId?: string; key?: string } = {},
  ): Promise<string> {
    assertNoSecret(r, body);
    const id = await this.keyedId(r, "commentCreate", opts.key);
    const exists = async () =>
      (await this.ctx.linear.listComments([issue.id], EPOCH)).some((c) => c.id === id) ? { id } : null;
    const made = await journaled(
      this.ctx,
      r,
      {
        kind: "commentCreate",
        key: opts.key ?? id,
        input: { id, parentId: opts.parentId ?? null },
        dedupe: !!opts.key,
      },
      () =>
        this.ctx.linear.createComment(
          issue.id,
          body,
          opts.parentId ? { id, parentId: opts.parentId } : { id },
        ),
      Created,
      opts.key ? exists : undefined,
    );
    return made.id;
  }

  async editComment(r: WRecord, commentId: string, body: string): Promise<void> {
    assertNoSecret(r, body);
    await journaled(
      this.ctx,
      r,
      { kind: "commentUpdate", key: `${commentId}:${h(body)}`, input: { commentId }, dedupe: false },
      () => this.ctx.linear.updateComment(commentId, body).then(() => null),
      z.null(),
    );
  }

  async attach(r: WRecord, issue: LinearIssue, url: string, title: string): Promise<void> {
    await journaled(
      this.ctx,
      r,
      { kind: "attachmentLinkURL", key: `${issue.id}:${url}`, input: { url }, dedupe: true },
      () => this.ctx.linear.createAttachment(issue.id, url, title).then(() => null),
      z.null(),
    );
  }

  /** §8.1 `followup`: a parented Backlog issue in the same team and project; `key` (the intent id) makes a replay idempotent. */
  async createFollowup(
    r: WRecord,
    issue: LinearIssue,
    title: string,
    description: string,
    key?: string,
  ): Promise<{ id: string; identifier: string }> {
    assertNoSecret(r, `${title}\n${description}`);
    const id = await this.keyedId(r, "issueCreate", key);
    const exists = async () => {
      const [made] = await this.ctx.linear.getIssues([id]);
      return made ? { id: made.id, identifier: made.identifier } : null;
    };
    return journaled(
      this.ctx,
      r,
      { kind: "issueCreate", key: key ?? id, input: { id, title }, dedupe: !!key },
      () =>
        this.ctx.linear.createIssue({
          id,
          teamId: issue.teamId,
          projectId: issue.projectId,
          parentId: issue.id,
          title,
          description,
          stateId: this.ctx.meta.stateByType("backlog"),
        }),
      CreatedIssue,
      key ? exists : undefined,
    );
  }
}
