// src/ops/notify.ts — §7.5 step 4: `wingmate doctor --notify-test <scratch issue>` posts one question as the Wingmate app on a scratch
// issue of a pilot project (so it lands in "Wingmate · Needs you"), moves it to `Needs-Human`, and records that the owner has yet to
// confirm both notifications; `doctor --confirm-notify` records the confirmation. Journaled like every Wingmate write.
import { projectFor } from "../config/schema";
import { renderQuestion } from "../linear/templates";
import type { Ctx } from "../machine/context";
import { LinearWrites } from "../machine/linearWrites";
import { WingmateError } from "../shared/errors";
import { IDENTIFIER_RE, newUlid } from "../shared/ids";
import { newRecord, readRecord } from "../state/records";

export interface NotifyState {
  askedAt: string;
  issue: string;
  confirmed: boolean;
  confirmedAt?: string | null;
}

const ACTIVE = new Set(["claimed", "working", "awaiting-human", "review", "blocked"]);
const CLOSED = new Set(["completed", "canceled"]);

export async function notifyTest(ctx: Ctx, identifier: string): Promise<NotifyState> {
  if (!IDENTIFIER_RE.test(identifier))
    throw new WingmateError("usage", "--notify-test needs a scratch issue identifier such as JRF-123");
  const rec = await readRecord(ctx.dirs, identifier).catch(() => null);
  if (rec && ACTIVE.has(rec.stage))
    throw new WingmateError(
      "notify_issue_active",
      `${identifier} is an issue Wingmate is working on (${rec.stage})`,
      "use a scratch issue no agent works on",
    );
  const issue = await ctx.linear.issueByIdentifier(identifier);
  if (!issue) throw new WingmateError("notify_issue_missing", `${identifier} was not found in Linear`);
  const project = issue.projectId ? projectFor(ctx.cfg, issue.projectId) : undefined;
  if (!project)
    throw new WingmateError(
      "notify_issue_not_pilot",
      `${identifier} is in no pilot project, so it would never reach "Wingmate · Needs you"`,
      "use a scratch issue in a pilot project",
    );
  if (CLOSED.has(issue.state.type))
    throw new WingmateError(
      "notify_issue_closed",
      `${identifier} is ${issue.state.name}`,
      "use an open scratch issue",
    );
  // a throwaway record: the journal and the secret scan key their entries by it; it is never written
  const r = newRecord({
    identifier,
    linearId: issue.id,
    project: project.key,
    repo: project.routing.default,
    provider: "claude",
    autonomy: project.autonomy,
    now: ctx.now(),
  });
  const questionId = newUlid();
  const body = renderQuestion({
    identifier,
    questionId,
    stage: "intake",
    context:
      "This is Wingmate's notification test (`wingmate doctor --notify-test`). No agent is working on this issue and no answer is needed. Confirm on the dispatcher host with `wingmate doctor --confirm-notify` once both notifications below have arrived.",
    options: [
      "the comment / mention notification arrived",
      'the "Wingmate · Needs you" view notification (issue added to view) arrived',
    ],
    recommend: null,
    mention: `@[owner](${ctx.cfg.workspace.owner})`,
  });
  const w = new LinearWrites(ctx);
  await w.postComment(r, issue, body, { key: `notify-test:${identifier}:${questionId}` });
  await w.setLifecycle(r, issue, "Needs-Human");
  await ctx.ledger.append({ at: ctx.now(), issue: identifier, type: "notify_test", data: { questionId } });
  return { askedAt: ctx.now(), issue: identifier, confirmed: false, confirmedAt: null };
}
