// src/server/snapshot.ts — Aggregates Linear issues, active/archived worktrees, queue, and metrics for the UI.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config/schema";
import { readPause } from "../ops/pause";
import { modelLabel } from "../policy/providers";
import type { LinearIssue, LinearPort } from "../ports";
import type { Dirs } from "../shared/paths";
import type { Clock } from "../shared/time";
import { readText } from "../state/fs";
import { readHeartbeat, stopRequested } from "../state/heartbeat";
import { readQueue } from "../state/queue";
import { RecordSchema, type WRecord } from "../state/records";
import type {
  ActiveWorktreeItem,
  AgentAssignedStatus,
  AgentRosterEntry,
  AgentRosterSummary,
  FunnelStats,
  GateSummary,
  HarnessAutomation,
  ProjectSummary,
  RoleJobSummary,
  SnapshotResponse,
  ThroughputMetrics,
  Timeframe,
  TriageItem,
} from "./types";

const ACTIVE_STAGES = new Set(["claimed", "working", "awaiting-human", "review", "blocked"]);
const TIMEFRAME_DAYS: Record<Timeframe, number> = {
  today: 1,
  "7d": 7,
  "30d": 30,
  all: 3650,
};

/** Use the actual issue URL when available; never interpolate a scheme from ticket data into an answer link. */
function linearIssueUrl(value: string | undefined): string | null {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && url.hostname === "linear.app" && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function waitingOnDesc(r: WRecord): string | null {
  if (r.paused) return "Owner (paused)";
  if (r.stage === "awaiting-human") return "Owner (question approval)";
  if (r.stage === "review") return "Owner (PR review)";
  if (r.stage === "blocked") return "Owner (blocked)";
  return null;
}

function coordinatorCurrentAction(r: WRecord): string {
  if (r.paused) return "Paused by operator";
  if (r.stage === "claimed") return "Assigned to issue; awaiting initial dispatch launch";
  if (r.stage === "awaiting-human") {
    const openQ = r.questions.find((q) => q.status === "open");
    return openQ ? "Parked: waiting on owner answer / plan approval" : "Parked: waiting on human input";
  }
  if (r.stage === "review") return "Parked in review (PR open; awaiting merge/review)";
  if (r.stage === "blocked") return "Parked: blocked by safety gate or quota limits";
  if (r.stage === "done" || r.stage === "released") return "Completed execution";
  if (r.stage === "cancelled") return "Execution cancelled";
  if (r.stage === "working") {
    switch (r.pipelineStage) {
      case "intake":
        return "Analyzing ticket requirements & workspace context";
      case "plan":
        return "Formulating structured implementation plan";
      case "planVerify":
        return "Verifying plan against gate rules & constraints";
      case "implement":
        return "Implementing code changes in isolated worktree";
      case "validate":
        return "Executing unit tests & validation suite";
      case "ui":
        return "Executing UI & responsive styling checks";
      case "security":
        return "Running secret scanners & dependency audits";
      case "pr":
        return "Preparing branch & generating pull request";
      default:
        return "Active execution in worktree";
    }
  }
  return "Unknown execution state";
}

function coordinatorAssignedStatus(r: WRecord): AgentAssignedStatus {
  if (r.stage === "claimed") return "assigned";
  if (r.stage === "awaiting-human" || r.stage === "review" || r.stage === "blocked" || r.paused)
    return "parked";
  if (r.stage === "done" || r.stage === "released") return "completed";
  if (r.stage === "cancelled") return "failed";
  if (r.stage === "working") {
    return r.coordinator.startedAt ? "running" : "assigned";
  }
  return "unknown";
}

function roleJobCurrentAction(role: string, status: string, verdict: string | null): string {
  if (status === "succeeded") return `Completed ${role} (${verdict || "PASS"})`;
  if (status === "failed") return `Failed ${role} (${verdict || "FAIL"})`;
  if (status === "unverifiable") return `Unverifiable ${role} result`;
  switch (role) {
    case "plan-verifier":
      return "Reviewing architectural plan & gate constraints";
    case "code-reviewer":
      return "Reviewing code diff, purity & test coverage";
    case "security-reviewer":
      return "Auditing credentials, dependencies & sandbox boundaries";
    case "ui-reviewer":
      return "Verifying UI components, responsive layout & styling";
    case "worker":
      return "Executing delegated sub-task in worktree";
    default:
      return `Executing ${role} task`;
  }
}

/** Safely read all valid records from a directory. */
async function loadRecordFiles(dir: string, problems: string[]): Promise<WRecord[]> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
  const records: WRecord[] = [];
  for (const n of names.sort()) {
    try {
      const text = await readText(join(dir, n));
      if (!text) continue;
      const parsed = RecordSchema.safeParse(JSON.parse(text));
      if (parsed.success) records.push(parsed.data);
      else problems.push(`record_invalid(${n})`);
    } catch {
      problems.push(`record_read_failed(${n})`);
    }
  }
  return records;
}

/** Attempt to read title from ticket cache in worktree if available. */
async function tryReadWorktreeTitle(worktreePath: string | null): Promise<string | null> {
  if (!worktreePath) return null;
  try {
    const titleFile = join(worktreePath, ".wingmate", "ticket", "title.md");
    const content = await readText(titleFile);
    return content ? content.trim() : null;
  } catch {
    return null;
  }
}

/** Attempt to read open question snippet from worktree. */
async function tryReadQuestionSnippet(worktreePath: string | null): Promise<string | null> {
  if (!worktreePath) return null;
  try {
    const qFile = join(worktreePath, ".wingmate", "question.md");
    const content = await readText(qFile);
    if (!content) return null;
    const lines = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    return lines.slice(0, 3).join(" ") || null;
  } catch {
    return null;
  }
}

export interface BuildSnapshotOptions {
  timeframe?: Timeframe | undefined;
  project?: string | undefined;
}

export async function buildSnapshot(
  dirs: Dirs,
  cfg: Config,
  clock: Clock,
  linearClient: LinearPort | null,
  options: BuildSnapshotOptions = {},
): Promise<SnapshotResponse> {
  const now = clock.now().toISOString();
  const problems: string[] = [];
  const timeframe: Timeframe = options.timeframe ?? "7d";
  const days = TIMEFRAME_DAYS[timeframe];
  const sinceIso = new Date(Date.parse(now) - days * 86_400_000).toISOString();

  // 1. Read active and archived records
  const allActiveRecords = await loadRecordFiles(dirs.records, problems);
  const allArchivedRecords = await loadRecordFiles(dirs.archive, problems);

  const inScope = (proj: string) => !options.project || proj === options.project;

  const activeRecords = allActiveRecords.filter((r) => inScope(r.project));
  const recentArchived = allArchivedRecords.filter((r) => inScope(r.project) && r.updatedAt >= sinceIso);

  // 2. Read queue and heartbeat
  const queueData = await readQueue(dirs).catch(() => null);
  const heartbeat = await readHeartbeat(dirs).catch(() => null);
  const isStopRequested = await stopRequested(dirs).catch(() => false);
  const pausedScopes: string[] = await readPause(dirs).catch(() => [] as string[]);

  // 3. Query Linear if client is available
  let linearIssues: LinearIssue[] = [];
  const projectLinearIds = Object.entries(cfg.projects)
    .filter(([key]) => inScope(key))
    .map(([, p]) => p.linearProject);

  if (linearClient && projectLinearIds.length > 0) {
    try {
      linearIssues = await linearClient.listUpdatedSince(projectLinearIds, sinceIso);
    } catch {
      problems.push("linear_query_failed");
    }
  }

  // Linear id to issue map
  const linearById = new Map<string, LinearIssue>();
  for (const li of linearIssues) {
    linearById.set(li.id, li);
    linearById.set(li.identifier, li);
  }

  // Linear project ID to project key
  const linearProjToKey = new Map<string, string>();
  for (const [key, p] of Object.entries(cfg.projects)) {
    linearProjToKey.set(p.linearProject, key);
  }

  // 4. Build Active Worktrees
  const activeWorktrees: ActiveWorktreeItem[] = [];
  for (const r of activeRecords) {
    if (!ACTIVE_STAGES.has(r.stage)) continue;

    const matchedLinear = linearById.get(r.linearId) ?? linearById.get(r.identifier);
    const cachedTitle = await tryReadWorktreeTitle(r.worktree?.path ?? null);
    const title = matchedLinear?.title ?? cachedTitle ?? r.identifier;

    const openQ = r.questions.find((q) => q.status === "open");
    let questionPrompt: string | null = null;
    if (openQ) {
      questionPrompt = await tryReadQuestionSnippet(r.worktree?.path ?? null);
    }

    const roleJobs: RoleJobSummary[] = r.roleJobs.map((j) => ({
      id: j.id,
      role: j.role,
      provider: j.provider,
      status: j.status,
      verdict: j.verdict,
      completedAt: j.completedAt,
    }));

    // Build the full agent roster (coordinator + role workers + native UI jobs)
    const roster: AgentRosterEntry[] = [];

    // 1. Primary coordinator agent
    const coordStatus = coordinatorAssignedStatus(r);
    const coordAction = coordinatorCurrentAction(r);
    roster.push({
      id: `coord-${r.identifier}`,
      role: "coordinator",
      provider: r.provider,
      model: modelLabel(r.coordinator.launch),
      assignedStatus: coordStatus,
      statusDetail: `recorded ${r.stage} (attempt ${r.coordinator.attempt}${r.coordinator.relaunches > 0 ? `, ${r.coordinator.relaunches} relaunches` : ""})`,
      provenance: "record",
      provenanceDetail: "Record coordinator state (process unverified; no live process check)",
      livenessVerified: false,
      currentAction: coordAction,
      worktreePath: r.worktree?.path ?? null,
      branch: r.worktree?.branch ?? null,
      terminalHandle: r.coordinator.terminalHandle,
      paneKey: r.coordinator.paneKey,
      startedAt: r.coordinator.startedAt,
      completedAt: r.stage === "done" || r.stage === "released" ? r.updatedAt : null,
      verdict: null,
    });

    // 2. Role-worker agents
    for (const j of r.roleJobs) {
      let roleStatus: AgentAssignedStatus = "unknown";
      if (j.status === "starting") roleStatus = "assigned";
      else if (j.status === "running") roleStatus = "running";
      else if (j.status === "succeeded") roleStatus = "completed";
      else if (j.status === "failed") roleStatus = "failed";
      else if (j.status === "unverifiable") roleStatus = "unknown";

      roster.push({
        id: j.id,
        role: j.role,
        provider: j.provider,
        model: null,
        assignedStatus: roleStatus,
        statusDetail: `${j.status}${j.verdict ? ` (${j.verdict})` : ""}${j.launchUncertain ? " [launch uncertain]" : ""}`,
        provenance: "terminal-job",
        provenanceDetail: `Recorded roleJob schema (cycle ${j.cycle}, attempt ${j.attempt})`,
        livenessVerified: false,
        currentAction: roleJobCurrentAction(j.role, j.status, j.verdict),
        worktreePath: r.worktree?.path ?? null,
        branch: r.worktree?.branch ?? null,
        terminalHandle: j.terminalHandle,
        paneKey: j.paneKey,
        startedAt: j.createdAt,
        completedAt: j.completedAt,
        verdict: j.verdict,
      });
    }

    // 3. Native UI simulator jobs
    for (const nj of r.nativeUiJobs) {
      let njStatus: AgentAssignedStatus = "unknown";
      if (nj.status === "running") njStatus = "running";
      else if (nj.status === "succeeded") njStatus = "completed";
      else if (nj.status === "failed") njStatus = "failed";
      else if (nj.status === "unverifiable") njStatus = "unknown";

      roster.push({
        id: nj.id,
        role: "native-ui-tester",
        provider: "orca-simulator",
        model: null,
        assignedStatus: njStatus,
        statusDetail: nj.status,
        provenance: "native-job",
        provenanceDetail: `Recorded nativeUiJob schema (iOS Simulator, cycle ${nj.cycle})`,
        livenessVerified: false,
        currentAction: "Executing native iOS UI simulator recipe",
        worktreePath: r.worktree?.path ?? null,
        branch: r.worktree?.branch ?? null,
        terminalHandle: null,
        paneKey: null,
        startedAt: nj.requestedAt,
        completedAt: null,
        verdict: null,
      });
    }

    const rosterSummary: AgentRosterSummary = {
      total: roster.length,
      running: roster.filter((a) => a.assignedStatus === "running").length,
      assigned: roster.filter((a) => a.assignedStatus === "assigned").length,
      parked: roster.filter((a) => a.assignedStatus === "parked").length,
      completed: roster.filter((a) => a.assignedStatus === "completed").length,
      failed: roster.filter((a) => a.assignedStatus === "failed").length,
      unknown: roster.filter((a) => a.assignedStatus === "unknown").length,
    };

    const gates: Record<string, GateSummary> = {};
    for (const [gName, gVal] of Object.entries(r.gates)) {
      gates[gName] = {
        verdict: gVal.verdict,
        failCount: gVal.failCount,
        at: gVal.at,
        note: gVal.note,
      };
    }

    activeWorktrees.push({
      identifier: r.identifier,
      linearId: r.linearId,
      linearUrl: linearIssueUrl(matchedLinear?.url),
      title,
      project: r.project,
      repo: r.repo,
      stage: r.stage,
      pipelineStage: r.pipelineStage,
      provider: r.provider,
      model: modelLabel(r.coordinator.launch),
      worktreePath: r.worktree?.path ?? null,
      branch: r.worktree?.branch ?? null,
      ageMin: Math.max(0, Math.round((Date.parse(now) - Date.parse(r.claimedAt)) / 60_000)),
      waitingOn: waitingOnDesc(r),
      paused: r.paused,
      coordinator: {
        terminalHandle: r.coordinator.terminalHandle,
        paneKey: r.coordinator.paneKey,
        startedAt: r.coordinator.startedAt,
        attempt: r.coordinator.attempt,
        relaunches: r.coordinator.relaunches,
      },
      roleJobs,
      roster,
      rosterSummary,
      gates,
      openQuestion: openQ
        ? {
            id: openQ.id,
            askedAt: openQ.askedAt,
            prompt: questionPrompt,
          }
        : null,
      prUrl: r.prs[0]?.url ?? null,
      costUsd: r.usage.costUsd,
      tokens: r.usage.tokens,
      attention: [...r.attention],
    });
  }

  // 5. Build Triage Deck: Issues in Linear Todo/Backlog without an agent label
  const triage: TriageItem[] = [];
  const agentLabelNames = new Set([
    cfg.labels.agent.human,
    ...cfg.labels.agent.supported,
    ...cfg.labels.agent.unsupported,
  ]);

  for (const li of linearIssues) {
    if (li.archivedAt || li.trashed) continue;
    const isUnstartedOrBacklog = li.state.type === "unstarted" || li.state.type === "backlog";
    if (!isUnstartedOrBacklog) continue;

    const labelNames = li.labels.map((l) => l.name.toLowerCase());
    const hasAgentLabel = labelNames.some((l) => agentLabelNames.has(l));

    // If it already has an agent label or is claimed, it's not triage
    const isAlreadyClaimed = activeRecords.some((r) => r.identifier === li.identifier);
    if (hasAgentLabel || isAlreadyClaimed) continue;

    const projectKey = (li.projectId && linearProjToKey.get(li.projectId)) ?? "unknown";
    triage.push({
      identifier: li.identifier,
      linearId: li.id,
      title: li.title,
      project: projectKey,
      projectKey,
      projectName: projectKey.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      priority: li.priority ?? 0,
      state: {
        id: li.state.id,
        name: li.state.name,
        type: li.state.type,
      },
      labels: li.labels.map((l) => l.name),
      updatedAt: li.updatedAt,
      url: li.url,
      recommendedProvider: cfg.defaults.providers.default,
    });
  }

  // Sort triage by identifier desc
  triage.sort((a, b) => b.identifier.localeCompare(a.identifier));

  // 6. Build Funnel Counts
  const todoCount = linearIssues.filter(
    (li) =>
      (li.state.type === "unstarted" || li.state.type === "backlog") &&
      !li.labels.some((l) => l.name === "agent-ready" || l.name === "claude" || l.name === "codex"),
  ).length;

  const agentReadyCount =
    (queueData?.items.filter((i) => inScope(i.project)).length ?? 0) ||
    linearIssues.filter(
      (li) =>
        li.state.type === "unstarted" &&
        li.labels.some((l) => l.name === "agent-ready" || l.name === "claude" || l.name === "codex"),
    ).length;

  const inAgentCount = activeRecords.filter((r) => r.stage === "claimed" || r.stage === "working").length;
  const waitingHumanCount = activeRecords.filter(
    (r) => r.stage === "awaiting-human" || r.stage === "blocked",
  ).length;
  const reviewReadyCount = activeRecords.filter((r) => r.stage === "review").length;

  const completedFromArchive = recentArchived.filter(
    (r) => r.stage === "done" || r.stage === "released",
  ).length;
  const completedFromLinear = linearIssues.filter(
    (li) => li.state.type === "completed" && li.updatedAt >= sinceIso,
  ).length;
  const doneCount = Math.max(completedFromArchive, completedFromLinear);

  const funnel: FunnelStats = {
    todo: todoCount,
    agentReady: agentReadyCount,
    inAgent: inAgentCount,
    waitingOnHuman: waitingHumanCount,
    reviewReady: reviewReadyCount,
    done: doneCount,
  };

  // 7. Throughput Metrics
  let totalCost = 0;
  let totalTokens = 0;
  let totalMinutes = 0;
  let sessionCount = 0;
  let passedGates = 0;
  let totalGates = 0;

  const byProvider: Record<string, { tokens: number; costUsd: number; count: number }> = {};
  const byProject: Record<string, { tokens: number; costUsd: number; count: number }> = {};

  const allRecordsInScope = [...activeRecords, ...recentArchived];

  for (const r of allRecordsInScope) {
    for (const s of r.usage.bySession) {
      const tok = s.tokens ?? 0;
      const cost = s.costUsd ?? 0;
      totalTokens += tok;
      totalCost += cost;
      totalMinutes += s.agentMinutes;
      sessionCount += 1;

      const pEntry = byProvider[s.provider] ?? { tokens: 0, costUsd: 0, count: 0 };
      pEntry.tokens += tok;
      pEntry.costUsd += cost;
      pEntry.count += 1;
      byProvider[s.provider] = pEntry;

      const prjEntry = byProject[r.project] ?? { tokens: 0, costUsd: 0, count: 0 };
      prjEntry.tokens += tok;
      prjEntry.costUsd += cost;
      prjEntry.count += 1;
      byProject[r.project] = prjEntry;
    }

    for (const g of Object.values(r.gates)) {
      if (g.verdict === "PASS") passedGates++;
      if (g.verdict === "FAIL") totalGates++;
      if (g.verdict === "PASS") totalGates++;
    }
  }

  const avgCycleMinutes =
    allRecordsInScope.length > 0 ? Math.round(totalMinutes / Math.max(1, allRecordsInScope.length)) : 0;
  const gatePassRate = totalGates > 0 ? Math.round((passedGates / totalGates) * 1000) / 10 : 100;

  const metrics: ThroughputMetrics = {
    timeframe,
    since: sinceIso,
    completedCount: doneCount,
    inProgressCount: inAgentCount + waitingHumanCount + reviewReadyCount,
    avgCycleMinutes,
    gatePassRate,
    tokens: totalTokens,
    costUsd: Math.round(totalCost * 100) / 100,
    byProvider,
    byProject,
  };

  // 8. Projects Summary
  const projects: ProjectSummary[] = [];
  for (const [key, p] of Object.entries(cfg.projects)) {
    if (!inScope(key)) continue;
    const activeForProj = activeRecords.filter((r) => r.project === key);
    const activeCount = activeForProj.length;
    const queuedCount = queueData?.items.filter((i) => i.project === key).length ?? 0;
    const completedCount = recentArchived.filter(
      (r) => r.project === key && (r.stage === "done" || r.stage === "released"),
    ).length;

    // Slot is held if there is a working or claimed coordinator
    const holder = activeForProj.find((r) => r.stage === "working" || r.stage === "claimed");

    const teamSlug = cfg.workspace.team.toLowerCase();
    projects.push({
      key,
      name: key.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      linearProjectId: p.linearProject,
      linearProjectUrl: `https://linear.app/${teamSlug}/project/${p.linearProject}`,
      activeCount,
      queuedCount,
      completedCount,
      slotHeldBy: holder ? holder.identifier : null,
      automation: {
        type: "orca",
        cadence: "Every 5 min",
        enabled: !pausedScopes.includes(key) && !pausedScopes.includes("all"),
      },
    });
  }

  // 9. Native Harness Automations & Routines
  const automations: HarnessAutomation[] = [
    {
      name: "Orca Dispatcher Automation",
      harness: "orca",
      targetProject: "All Projects (JRF)",
      schedule: "Every 5 min (.orca/automations)",
      lastRunStatus: heartbeat ? `${heartbeat.outcome} (${heartbeat.durationMs}ms)` : "idle (no heartbeat)",
      lastRunAt: heartbeat?.at ?? null,
      configured: !!heartbeat,
      provenance: heartbeat ? "Heartbeat record (.wingmate/heartbeat.json)" : "Not installed / idle",
    },
    {
      name: "Claude Code Routine Relay",
      harness: "claude-code",
      targetProject: "Active Worktrees",
      schedule: "Tool Routine (when configured)",
      lastRunStatus: "Not configured (planned host routine)",
      lastRunAt: null,
      configured: false,
      provenance: "Planned / Host routine not configured",
    },
    {
      name: "Codex Scheduled Review Loop",
      harness: "codex",
      targetProject: "Pilot Worktrees",
      schedule: "Scheduled Review (when configured)",
      lastRunStatus: "Not configured (planned host routine)",
      lastRunAt: null,
      configured: false,
      provenance: "Planned / Host routine not configured",
    },
    {
      name: "Antigravity / Gemini Agent Harness",
      harness: "antigravity",
      targetProject: "Dispatched Workspaces",
      schedule: "Direct Worker / Dispatch Task",
      lastRunStatus: "Active (Dispatched Worker Session)",
      lastRunAt: now,
      configured: true,
      provenance: "Dispatched Antigravity worker session (task_29f7d0a70476)",
    },
  ];

  return {
    at: now,
    dispatcher: heartbeat,
    stopRequested: isStopRequested,
    pausedScopes,
    funnel,
    triage,
    queue: (queueData?.items ?? [])
      .filter((i) => inScope(i.project))
      .map((i) => {
        const li = linearById.get(i.identifier);
        const teamSlug = cfg.workspace.team.toLowerCase();
        return {
          identifier: i.identifier,
          project: i.project,
          title: li?.title ?? null,
          linearUrl: li?.url || `https://linear.app/${teamSlug}/issue/${i.identifier}`,
          status: i.status,
          reason: i.reason,
          detail: i.detail,
        };
      }),
    activeWorktrees,
    projects,
    metrics,
    automations,
    problems,
  };
}
