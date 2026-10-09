// src/linear/templates.ts — the comment bodies Wingmate writes (spec Appendix B). Status stays ≤ 6 KB.
import { MARK } from "./markers";

const MAX_STATUS_BYTES = 6144;
const NOTE_CAP = 5;
const NOTE_TRUNCATE = 200;

export interface StatusInput {
  identifier: string;
  stage: string;
  pipelineStage: string;
  waitingOn: string | null;
  nextAction: string;
  provider: string;
  model: string | null;
  effort: string | null;
  worktree: string | null;
  branch: string | null;
  agents: { coordinator: number; workers: number };
  gates: [string, string | null, number][];
  pr: string | null;
  cost: { tokens: number | null; costUsd: number | null; provenance: string; detail?: string };
  updatedAt: string;
  notes: string[];
}

const glyph = (v: string | null): string =>
  v === "PASS" ? "✓" : v === "FAIL" ? "✗" : v === "NA" ? "n/a" : v === "STALE" ? "stale" : "–";

export function renderStatus(s: StatusInput): string {
  const cost =
    s.cost.detail ??
    (s.cost.costUsd != null
      ? `$${s.cost.costUsd.toFixed(2)} (${s.cost.provenance})`
      : s.cost.tokens != null
        ? `${s.cost.tokens.toLocaleString()} tokens (${s.cost.provenance})`
        : "— (unknown)");
  const head = `${MARK.status}\n**Wingmate · ${s.stage} · ${s.pipelineStage}** · waiting on: ${s.waitingOn ?? "nobody"} · next: ${s.nextAction}\n\n| | |\n|---|---|\n| Provider | ${s.provider}${s.model ? ` · ${s.model}` : ""}${s.effort ? ` · effort ${s.effort}` : ""} |\n| Worktree | ${s.worktree ?? "—"}${s.branch ? ` · \`${s.branch}\`` : ""} |\n| Agents | coordinator ${s.agents.coordinator} · workers ${s.agents.workers} |\n| Gates | ${s.gates.map(([n, v, a]) => `${n} ${glyph(v)}${a > 1 ? `(${a})` : ""}`).join(" · ")} |\n| PR | ${s.pr ?? "—"} |\n| Cost | ${cost} |\n| Updated | ${s.updatedAt} |\n`;
  const foot =
    "\n_How to respond: reply in the question thread · move back to In Progress to request changes · add `human` to stop._\n";
  const render = (notes: string[]) => `${head}\n${notes.map((n) => `- ${n}`).join("\n")}${foot}`;
  let notes = s.notes.slice(-NOTE_CAP);
  let body = render(notes);
  // Shrink the activity log first by truncating notes, then by dropping the oldest, until the cap holds.
  if (Buffer.byteLength(body) > MAX_STATUS_BYTES) {
    notes = notes.map((n) => (n.length > NOTE_TRUNCATE ? `${n.slice(0, NOTE_TRUNCATE)}…` : n));
    body = render(notes);
  }
  while (Buffer.byteLength(body) > MAX_STATUS_BYTES && notes.length) {
    notes = notes.slice(1);
    body = render(notes);
  }
  return body;
}

export interface QuestionInput {
  identifier: string;
  questionId: string;
  stage: string;
  context: string;
  options: string[];
  recommend: number | null;
  mention: string;
}

export function renderQuestion(q: QuestionInput): string {
  const opts = q.options
    .map((o, i) => `${i + 1}. ${o}${q.recommend === i + 1 ? " (recommended)" : ""}`)
    .join("\n");
  return `${MARK.question(q.questionId)}\n${q.mention} **Wingmate needs your decision** on ${q.identifier} (stage ${q.stage}).\n\n${q.context}\n\nOptions:\n${opts}\n\nReply with a number or free text in this thread as your signed-in owner account. The Console's Answer in Linear link opens the issue; Console answer submission is unavailable. The agent is parked until an eligible reply is delivered on the next dispatcher tick. To stop instead, add the label \`human\`.`;
}

export const renderBlocked = (b: {
  identifier: string;
  reason: string;
  detail: string;
  retained: string[];
  nextAction: string;
}): string =>
  `${MARK.blocked}\n**Wingmate blocked ${b.identifier}** — \`${b.reason}\`: ${b.detail}\n\nRetained: ${b.retained.length ? b.retained.join(", ") : "nothing"}.\n\nNext action for you: ${b.nextAction}`;

/** §7.3: the completion comment and the PR body both carry this line. */
export const REQUEST_CHANGES =
  "To request changes: move this issue back to In Progress or reply in this Linear thread. Reviews left on GitHub or in Linear Reviews are not read in the pilot. To accept: approve and merge as usual; the GitHub integration moves the issue to Done.";

export const renderCompletion = (c: {
  prs: { url: string; repo: string }[];
  summary: string;
  gates: [string, string][];
  limitations: string[];
  followups: string[];
  cost?: string;
}): string =>
  `${MARK.completion}\n**Ready for review.** ${c.prs.map((p) => `[${p.repo} PR](${p.url})`).join(" · ")}\n\n${c.summary}\n\nGates: ${c.gates.map(([n, v]) => `${n} ${v}`).join(" · ")}\n${c.cost ? `\nUsage: ${c.cost}\n` : ""}${c.limitations.length ? `\nLimitations: ${c.limitations.join("; ")}\n` : ""}${c.followups.length ? `\nFollow-ups created: ${c.followups.join(", ")}\n` : ""}\n_${REQUEST_CHANGES}_`;

export const renderHandoff = (h: {
  from: string;
  to: string | null;
  trigger: string;
  summary: string;
  evidence: string[];
  openQuestions: string[];
  blockers: string[];
}): string =>
  `${MARK.handoff}\n## Handoff summary\n* What changed: ${h.summary}\n* Current status: handed from ${h.from} to ${h.to ?? "nobody (blocked)"} — trigger \`${h.trigger}\`\n* Recommended next owner: ${h.to ?? "owner"}\n\n## Evidence\n${h.evidence.map((e) => `* ${e}`).join("\n") || "* none"}\n\n## Open questions\n${h.openQuestions.map((q) => `* ${q}`).join("\n") || "* none"}\n\n## Blockers\n${h.blockers.map((b) => `* ${b}`).join("\n") || "* none"}`;
