import type { Config, ProjectConfig } from "../config/schema";
import { projectFor } from "../config/schema";
import type { FleetSnapshot, LinearHistoryEntry, LinearIssue } from "../ports";
import type { SkipReason } from "../state/queue";
import type { WRecord } from "../state/records";

export type Verdict =
  | { status: "eligible"; provider: "claude" | "codex" | "agent-ready"; project: ProjectConfig }
  | { status: "skipped"; reason: SkipReason; detail: string | null };

export interface EligibilityCtx {
  cfg: Config;
  /** Agent-group label name → Linear label id (for the authorship lookup in history). */
  agentLabelIds: Map<string, string>;
  lifecycleGroupId: string;
  agentGroupId: string;
  /** `null` on the cheap pre-check (no history fetched yet); the authorship rule is then skipped. */
  history: LinearHistoryEntry[] | null;
  fleet: FleetSnapshot;
  records: WRecord[];
  pausedScopes: string[];
  liveCoordinator: (r: WRecord) => boolean;
}

// §5.3: terminal records never veto a re-claim; an active record does.
const TERMINAL = new Set(["blocked", "released", "done", "cancelled"]);
const VETO_LIFECYCLE = ["In-Agent", "Needs-Human", "Review-Ready", "Blocked"];
const CLOSED = ["completed", "canceled"];

const skip = (reason: SkipReason, detail: string | null = null): Verdict => ({
  status: "skipped",
  reason,
  detail,
});

export function evaluateCandidate(issue: LinearIssue, ctx: EligibilityCtx): Verdict {
  const project = issue.projectId ? projectFor(ctx.cfg, issue.projectId) : undefined;
  if (!project) return skip("not_todo", "not a pilot project");
  if (issue.archivedAt || issue.trashed) return skip("archived");
  if (issue.state.type !== "unstarted") return skip("not_todo", issue.state.name);
  if (ctx.pausedScopes.includes("global")) return skip("paused", "global");
  if (ctx.pausedScopes.includes(project.key)) return skip("paused", project.key);

  const agentLabels = issue.labels.filter(
    (l) => l.parentId === ctx.agentGroupId || l.parentName === ctx.cfg.labels.agentGroup,
  );
  const lifecycle = issue.labels
    .filter((l) => l.parentId === ctx.lifecycleGroupId || l.parentName === ctx.cfg.labels.lifecycleGroup)
    .map((l) => l.name);
  if (agentLabels.length > 1)
    return skip("conflicting_agent_labels", agentLabels.map((l) => l.name).join(","));
  const agent = agentLabels[0];
  if (!agent) return skip("not_todo", "no Agent label");
  if (agent.name === ctx.cfg.labels.agent.human) return skip("human");
  if (!ctx.cfg.labels.agent.supported.includes(agent.name)) return skip("unsupported_provider", agent.name);

  const veto = lifecycle.find((n) => VETO_LIFECYCLE.includes(n));
  if (veto) return skip("veto_label", veto);
  const openChild = issue.children.find((c) => !CLOSED.includes(c.stateType));
  if (openChild) return skip("has_open_children", openChild.identifier);
  const prereq = issue.prerequisites.find((p) => !CLOSED.includes(p.stateType));
  if (prereq) return skip("prerequisite_open", prereq.identifier);

  const owner = ctx.fleet.worktrees.find(
    (w) => w.linkedLinearIssue === issue.identifier && w.agents.some((a) => a.state === "working"),
  );
  if (owner) return skip("live_owner", owner.worktreeId);
  const rec = ctx.records.find((r) => r.identifier === issue.identifier && !TERMINAL.has(r.stage));
  if (rec)
    return skip("live_owner", `record ${rec.stage}${ctx.liveCoordinator(rec) ? " (coordinator live)" : ""}`);

  if (ctx.history) {
    const labelId = ctx.agentLabelIds.get(agent.name) ?? agent.id;
    const added = [...ctx.history].reverse().find((h) => h.addedLabelIds.includes(labelId));
    if (added && (added.botActorId || !added.actorId || !ctx.cfg.workspace.approvers.includes(added.actorId)))
      return skip("label_by_unlisted_actor", added.actorId ?? added.botActorId ?? "unknown");
  }
  return {
    status: "eligible",
    provider: agent.name === "agent-ready" ? "agent-ready" : (agent.name as "claude" | "codex"),
    project,
  };
}
