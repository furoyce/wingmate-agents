// src/server/snapshot.ts — Aggregates Linear issues, active/archived worktrees, queue, and metrics for the UI.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config/schema";
import { type InstallState, readInstallState } from "../ops/install";
import { GLOBAL_SCOPE, readPause } from "../ops/pause";
import { modelLabel } from "../policy/providers";
import type { LinearIssue, LinearPort } from "../ports";
import type { Dirs } from "../shared/paths";
import type { Clock } from "../shared/time";
import { readText } from "../state/fs";
import { type Heartbeat, readLastTick, stopRequested } from "../state/heartbeat";
import { readQueue } from "../state/queue";
import { RecordSchema, type WRecord } from "../state/records";
import type {
  ActiveWorktreeItem,
  AgentAssignedStatus,
  AgentRosterEntry,
  AgentRosterSummary,
  DispatcherHealth,
  ExecutionTaskSummary,
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

/** A tick older than this is stale: the installer cadence is 5 minutes, so three missed ticks. */
export const HEARTBEAT_STALE_MIN = 15;
const HEALTHY_OUTCOMES = new Set(["idle", "work"]);

/**
 * Observed dispatcher health from the last tick: healthy only for a fresh tick whose outcome is idle/work. A fresh tick that
 * errored, lost its lock or could not reach Orca/Linear is degraded; a paused outcome is paused; an old one is stale.
 */
export function dispatcherHealth(
  heartbeat: Heartbeat | null,
  invalid: boolean,
  nowIso: string,
): DispatcherHealth {
  if (invalid)
    return { state: "unknown", outcome: null, ageMin: null, detail: "Last tick evidence is invalid" };
  if (!heartbeat) return { state: "unknown", outcome: null, ageMin: null, detail: "No tick observed" };
  const ageMs = Math.max(0, Date.parse(nowIso) - Date.parse(heartbeat.at));
  const ageMin = Math.floor(ageMs / 60_000);
  const base = { outcome: heartbeat.outcome, ageMin };
  const reason = heartbeat.reason ? `: ${heartbeat.reason}` : "";
  if (ageMs > HEARTBEAT_STALE_MIN * 60_000)
    return { ...base, state: "stale", detail: `Last tick ${ageMin}m ago (${heartbeat.outcome})` };
  if (heartbeat.outcome === "paused")
    return { ...base, state: "paused", detail: `Last tick ${ageMin}m ago: paused` };
  // Exit codes are not health: §4.3's precheck exits 1 even after a healthy idle/work tick, so judge the outcome.
  if (!HEALTHY_OUTCOMES.has(heartbeat.outcome))
    return {
      ...base,
      state: "degraded",
      detail: `Last tick ${ageMin}m ago: ${heartbeat.outcome} (exit ${heartbeat.exitCode})${reason}`,
    };
  return { ...base, state: "healthy", detail: `Last tick ${ageMin}m ago: ${heartbeat.outcome}` };
}

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

function coordinatorRoleStageDescription(r: WRecord): string {
  if (r.paused) return "Recorded stage: paused by operator";
  if (r.stage === "claimed") return "Recorded stage: claimed (awaiting initial launch)";
  if (r.stage === "awaiting-human") {
    const openQ = r.questions.find((q) => q.status === "open");
    return openQ
      ? "Recorded stage: awaiting-human (parked for owner answer / plan approval)"
      : "Recorded stage: awaiting-human (parked for owner input)";
  }
  if (r.stage === "review") return "Recorded stage: review (PR open, parked for review)";
  if (r.stage === "blocked") return "Recorded stage: blocked (safety gate / limit)";
  if (r.stage === "done") return "Recorded stage: done (completed)";
  if (r.stage === "released") return "Recorded stage: ownership released";
  if (r.stage === "cancelled") return "Recorded stage: cancelled";
  if (r.stage === "working") {
    return `Recorded pipeline stage: ${r.pipelineStage}`;
  }
  return `Recorded stage: ${r.stage}`;
}

function coordinatorAssignedStatus(r: WRecord): AgentAssignedStatus {
  if (r.paused) return "parked";
  if (r.stage === "claimed") return "assigned";
  if (r.stage === "awaiting-human" || r.stage === "review" || r.stage === "blocked") return "parked";
  if (r.stage === "done") return "completed";
  if (r.stage === "cancelled") return "failed";
  if (r.stage === "working") {
    return r.coordinator.startedAt ? "running" : "assigned";
  }
  return "unknown";
}

function roleJobActionDescription(role: string, status: string, verdict: string | null): string {
  if (status === "succeeded") {
    if (verdict) {
      return `Recorded role result: ${role} succeeded (${verdict})`;
    }
    return `Recorded role result: ${role} succeeded (verdict unknown)`;
  }
  if (status === "failed") {
    if (verdict) {
      return `Recorded role result: ${role} failed (${verdict})`;
    }
    return `Recorded role result: ${role} failed (verdict unknown)`;
  }
  if (status === "unverifiable") {
    return `Recorded role status: ${role} unverifiable`;
  }
  if (status === "starting") {
    return `Recorded role status: ${role} assigned (starting)`;
  }
  if (status === "running") {
    return `Recorded role status: ${role} running`;
  }
  return `Recorded role status: ${role} (${status})`;
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

  // 2. Read queue, heartbeat, and install state
  const queueData = await readQueue(dirs).catch(() => null);
  let invalidTickEvidence = false;
  let heartbeat = await readLastTick(dirs).catch(() => {
    invalidTickEvidence = true;
    return null;
  });
  if (
    heartbeat &&
    (heartbeat.kind !== "tick" ||
      !Number.isFinite(Date.parse(heartbeat.at)) ||
      Date.parse(heartbeat.at) > Date.parse(now))
  ) {
    invalidTickEvidence = true;
    heartbeat = null;
  }
  if (invalidTickEvidence) problems.push("last_tick_invalid");
  const isStopRequested = await stopRequested(dirs).catch(() => false);
  // An unreadable pause file is unknown pause state, never "not paused".
  let pauseStateKnown = true;
  const pausedScopes: string[] = await readPause(dirs).catch(() => {
    pauseStateKnown = false;
    problems.push("pause_invalid");
    return [] as string[];
  });
  const globalPaused = pausedScopes.includes(GLOBAL_SCOPE);

  let installState: InstallState | null = null;
  let installMalformed = false;
  try {
    installState = await readInstallState(dirs);
  } catch (err) {
    installMalformed = true;
    problems.push(`install_state_invalid: ${(err as Error).message}`);
  }

  // 3. Evaluate scheduler installation & heartbeat provenance
  let schedulerStatus: "active" | "degraded" | "paused" | "disabled" | "stale" | "unknown" = "unknown";
  const health = dispatcherHealth(heartbeat, invalidTickEvidence, now);
  let schedulerConfigured = false;
  let schedulerEnabled = false;
  let schedulerSchedule = "Not installed";
  let schedulerLastRunStatus = "Not installed";
  let schedulerProvenance = "No local installation record; scheduler state unknown";

  if (installMalformed) {
    schedulerStatus = "unknown";
    schedulerConfigured = false;
    schedulerEnabled = false;
    schedulerSchedule = "State unknown";
    schedulerLastRunStatus = "State unknown (malformed install.json)";
    schedulerProvenance = "Malformed local install state (install.json unparseable)";
  } else if (!installState) {
    schedulerStatus = "unknown";
    schedulerConfigured = false;
    schedulerEnabled = false;
    schedulerSchedule = "Unknown (no local installation record)";
    if (heartbeat) {
      schedulerLastRunStatus = `${heartbeat.outcome} (${heartbeat.durationMs}ms; origin unknown)`;
      schedulerProvenance =
        "No local installation record; scheduler state unknown (heartbeat origin unknown)";
    } else {
      schedulerLastRunStatus = "No local installation record (scheduler state unknown)";
      schedulerProvenance = "No local installation record; scheduler state unknown";
    }
  } else if (!installState.automationId) {
    // Missing automationId cannot support active; record is incomplete
    schedulerStatus = "unknown";
    schedulerConfigured = false;
    schedulerEnabled = false;
    schedulerSchedule = "Missing automationId in install.json";
    schedulerLastRunStatus = "Unconfigured (missing automationId in install.json)";
    schedulerProvenance = "Recorded install.json lacks automationId; live state unverified";
  } else if (!installState.enabled) {
    schedulerStatus = "disabled";
    schedulerConfigured = true;
    schedulerEnabled = false;
    schedulerSchedule = "Recorded disabled in install.json";
    if (heartbeat) {
      schedulerLastRunStatus = `Disabled (${heartbeat.outcome}; live state unverified)`;
      schedulerProvenance = "Recorded disabled in install.json (live state unverified)";
    } else {
      schedulerLastRunStatus = "Disabled (recorded in install.json; live state unverified)";
      schedulerProvenance = "Recorded disabled in install.json (live state unverified)";
    }
  } else {
    // Valid install record with automationId and recorded enabled: true
    schedulerConfigured = true;
    schedulerEnabled = true;
    schedulerSchedule = "Every 5 min (installer cadence; live schedule unverified)";
    if (invalidTickEvidence) {
      schedulerStatus = "unknown";
      schedulerLastRunStatus = "Invalid tick evidence (timestamp or record); health unknown";
      schedulerProvenance = "Recorded enabled in install.json; live state unverified, tick evidence invalid";
    } else if (!heartbeat) {
      schedulerStatus = "unknown";
      schedulerLastRunStatus = "Installed (awaiting first heartbeat)";
      schedulerProvenance =
        "Recorded enabled in install.json (live state unverified; awaiting first heartbeat)";
    } else {
      const heartbeatAgeMin = health.ageMin ?? 0;
      if (health.state === "stale") {
        schedulerStatus = "stale";
        schedulerLastRunStatus = `Stale (${Math.floor(heartbeatAgeMin)}m ago; last: ${heartbeat.outcome})`;
        schedulerProvenance = `Recorded enabled in install.json (live state unverified; tick stale ${Math.floor(heartbeatAgeMin)}m ago)`;
      } else {
        schedulerStatus =
          health.state === "healthy" ? "active" : health.state === "paused" ? "paused" : "degraded";
        schedulerEnabled = true;
        schedulerLastRunStatus = `${heartbeat.outcome} (${heartbeat.durationMs}ms, exit ${heartbeat.exitCode})`;
        schedulerProvenance = `Recorded enabled in install.json (live state unverified; fresh heartbeat ${heartbeat.durationMs}ms)`;
      }
    }
  }

  // 4. Query Linear if client is available
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

    // Build the agent roster scoped to current cycle and coordinator attempt
    const roster: AgentRosterEntry[] = [];
    const currentRoleJobs = r.roleJobs.filter(
      (j) => j.cycle === r.cycle && j.attempt === r.coordinator.attempt,
    );

    // 1. Primary coordinator agent
    const coordStatus = coordinatorAssignedStatus(r);
    const coordAction = coordinatorRoleStageDescription(r);
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
      recordedRoleStage: coordAction,
      currentAction: coordAction,
      worktreePath: r.worktree?.path ?? null,
      branch: r.worktree?.branch ?? null,
      terminalHandle: r.coordinator.terminalHandle,
      paneKey: r.coordinator.paneKey,
      startedAt: r.coordinator.startedAt,
      completedAt: r.stage === "done" ? r.updatedAt : null,
      verdict: null,
    });

    // 2. Role-worker agents (strictly scoped to current record cycle and coordinator attempt)
    for (const j of currentRoleJobs) {
      let roleStatus: AgentAssignedStatus = "unknown";
      if (j.status === "starting") roleStatus = "assigned";
      else if (j.status === "running") roleStatus = "running";
      else if (j.status === "succeeded") roleStatus = "completed";
      else if (j.status === "failed") roleStatus = "failed";
      else if (j.status === "unverifiable") roleStatus = "unknown";

      let detail: string = j.status;
      if (j.status === "succeeded") {
        detail = j.verdict ? `succeeded (${j.verdict})` : "succeeded (verdict unknown)";
      } else if (j.status === "failed") {
        detail = j.verdict ? `failed (${j.verdict})` : "failed (verdict unknown)";
      } else if (j.verdict) {
        detail = `${j.status} (${j.verdict})`;
      }
      if (j.launchUncertain) {
        detail += " [launch uncertain]";
      }

      const actionDesc = roleJobActionDescription(j.role, j.status, j.verdict);

      roster.push({
        id: j.id,
        role: j.role,
        provider: j.provider,
        model: null,
        assignedStatus: roleStatus,
        statusDetail: detail,
        provenance: "terminal-job",
        provenanceDetail: `Recorded roleJob schema (cycle ${j.cycle}, attempt ${j.attempt})`,
        livenessVerified: false,
        recordedRoleStage: actionDesc,
        currentAction: actionDesc,
        worktreePath: r.worktree?.path ?? null,
        branch: r.worktree?.branch ?? null,
        terminalHandle: j.terminalHandle,
        paneKey: j.paneKey,
        startedAt: j.createdAt,
        completedAt: j.completedAt,
        verdict: j.verdict,
      });
    }

    // 3. Execution tasks (native UI simulator recipes are test tasks, NOT coding agents)
    const executionTasks: ExecutionTaskSummary[] = (r.nativeUiJobs ?? []).map((nj) => {
      const isDone = nj.status === "succeeded" || nj.status === "failed";
      let recordedAction: string;
      if (nj.status === "running") {
        recordedAction = "Recorded native test status: executing recipe on simulator";
      } else if (isDone) {
        recordedAction = `Recorded native test result: completed (${nj.status})`;
      } else {
        recordedAction = `Recorded native test status: ${nj.status} (recipe unconfirmed)`;
      }

      let taskStatus: "running" | "completed" | "failed" | "unknown" = "unknown";
      if (nj.status === "running") taskStatus = "running";
      else if (nj.status === "succeeded") taskStatus = "completed";
      else if (nj.status === "failed") taskStatus = "failed";

      return {
        id: nj.id,
        kind: "native-ui-test",
        status: taskStatus,
        statusDetail: `${nj.status} (cycle ${nj.cycle}, attempt ${nj.attempt})`,
        recordedAction,
        requestedAt: nj.requestedAt,
        device: "iOS Simulator",
      };
    });

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
      executionTasks,
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

  // The dispatcher's queue is authoritative for eligibility: count only its eligible rows (skipped rows carry a reason). Without
  // a queue file the count falls back to Linear labels, which says nothing about eligibility, and is labeled as such.
  const agentReadyCount = queueData
    ? queueData.items.filter((i) => inScope(i.project) && i.status === "eligible").length
    : linearIssues.filter(
        (li) =>
          li.state.type === "unstarted" && li.labels.some((l) => cfg.labels.agent.supported.includes(l.name)),
      ).length;

  const inAgentCount = activeRecords.filter((r) => r.stage === "claimed" || r.stage === "working").length;
  const waitingHumanCount = activeRecords.filter(
    (r) => r.stage === "awaiting-human" || r.stage === "blocked",
  ).length;
  const reviewReadyCount = activeRecords.filter((r) => r.stage === "review").length;

  // Release relinquishes ownership; only recorded done or Linear-completed issues are completion evidence.
  // Count unique immutable issue IDs across both observed sources and repeated archive cycles; sources may overlap.
  // Neither source carries a merge receipt, and unavailable sources cannot establish a complete inventory.
  const recordedDoneIds = new Set(recentArchived.filter((r) => r.stage === "done").map((r) => r.linearId));
  const releasedIds = new Set(recentArchived.filter((r) => r.stage === "released").map((r) => r.linearId));
  const sourceCompletedIds = new Set(
    linearIssues.filter((li) => li.state.type === "completed" && li.updatedAt >= sinceIso).map((li) => li.id),
  );
  const doneCount = new Set([...recordedDoneIds, ...sourceCompletedIds]).size;

  const funnel: FunnelStats = {
    todo: todoCount,
    agentReady: agentReadyCount,
    inAgent: inAgentCount,
    waitingOnHuman: waitingHumanCount,
    reviewReady: reviewReadyCount,
    done: doneCount,
    agentReadyBasis: queueData ? "queue-eligible" : "linear-labels",
    completion: {
      recordedDone: recordedDoneIds.size,
      released: releasedIds.size,
      sourceCompleted: sourceCompletedIds.size,
      mergeVerified: null,
    },
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
  const gatePassRate = totalGates > 0 ? Math.round((passedGates / totalGates) * 1000) / 10 : null;

  const metrics: ThroughputMetrics = {
    timeframe,
    since: sinceIso,
    completedCount: doneCount,
    inProgressCount: inAgentCount + waitingHumanCount + reviewReadyCount,
    avgCycleMinutes,
    gatePassRate,
    gatesPassed: passedGates,
    gatesObserved: totalGates,
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
    const queuedCount =
      queueData?.items.filter((i) => i.project === key && i.status === "eligible").length ?? 0;
    const skippedCount =
      queueData?.items.filter((i) => i.project === key && i.status !== "eligible").length ?? 0;
    const completedCount = new Set(
      recentArchived.filter((r) => r.project === key && r.stage === "done").map((r) => r.linearId),
    ).size;
    const releasedCount = new Set(
      recentArchived.filter((r) => r.project === key && r.stage === "released").map((r) => r.linearId),
    ).size;

    // Slot is held if there is a working or claimed coordinator
    const holder = activeForProj.find((r) => r.stage === "working" || r.stage === "claimed");

    const teamSlug = cfg.workspace.team.toLowerCase();
    // Project automation is only enabled if the scheduler is installed and enabled, and scope is not paused
    const pausedBy: "global" | "project" | null = pausedScopes.includes(key)
      ? "project"
      : globalPaused
        ? "global"
        : null;
    const isPaused = pausedBy !== null;
    const projAutomationEnabled = pauseStateKnown && schedulerEnabled && !isPaused;
    let projAutomationStatus: ProjectSummary["automation"]["status"] = "not_installed";
    if (installMalformed || !pauseStateKnown) {
      projAutomationStatus = "unknown";
    } else if (!installState) {
      projAutomationStatus = "unknown";
    } else if (isPaused) {
      projAutomationStatus = "paused";
    } else if (!installState.automationId) {
      projAutomationStatus = "unknown";
    } else if (!installState.enabled) {
      projAutomationStatus = "disabled";
    } else {
      projAutomationStatus = schedulerStatus;
    }

    const cadenceText =
      installMalformed || !installState || !installState.automationId
        ? "Unknown"
        : !installState.enabled
          ? "Recorded disabled"
          : pausedBy === "project"
            ? "Paused (project)"
            : pausedBy === "global"
              ? "Paused (global)"
              : schedulerStatus === "stale"
                ? "Recorded */5; heartbeat stale"
                : "Recorded every 5 min";

    projects.push({
      key,
      name: key.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      linearProjectId: p.linearProject,
      linearProjectUrl: `https://linear.app/${teamSlug}/project/${p.linearProject}`,
      activeCount,
      queuedCount,
      skippedCount,
      completedCount,
      releasedCount,
      paused: pausedBy,
      slotHeldBy: holder ? holder.identifier : null,
      automation: {
        type: "orca",
        cadence: cadenceText,
        enabled: projAutomationEnabled,
        status: projAutomationStatus,
        provenance: schedulerProvenance,
      },
    });
  }

  // 9. Native Harness Automations & Routines (reflecting actual local installation evidence)
  const automations: HarnessAutomation[] = [
    {
      name: "Orca Dispatcher Automation",
      harness: "orca",
      targetProject: "All Configured Projects",
      schedule: schedulerSchedule,
      lastRunStatus: schedulerLastRunStatus,
      lastRunAt: heartbeat?.at ?? null,
      configured: schedulerConfigured,
      provenance: schedulerProvenance,
    },
    {
      name: "Claude Code Routine Relay",
      harness: "claude-code",
      targetProject: "Active Worktrees",
      schedule: "Unobserved (adapter not implemented)",
      lastRunStatus: "Adapter not implemented / unobserved",
      lastRunAt: null,
      configured: false,
      provenance: "No adapter implemented; host routine unobserved (no probe performed)",
    },
    {
      name: "Codex Scheduled Review Loop",
      harness: "codex",
      targetProject: "Pilot Worktrees",
      schedule: "Unobserved (adapter not implemented)",
      lastRunStatus: "Adapter not implemented / unobserved",
      lastRunAt: null,
      configured: false,
      provenance: "No adapter implemented; host routine unobserved (no probe performed)",
    },
  ];

  return {
    at: now,
    dispatcher: heartbeat,
    dispatcherHealth: health,
    stopRequested: isStopRequested,
    pausedScopes,
    pauseStateKnown,
    globalPaused,
    pausedProjects: pausedScopes.filter((s) => s !== GLOBAL_SCOPE),
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
