import type { QueueRow } from "../ops/status";
// src/server/types.ts — DTO types for the Wingmate Console UI and API.
import type { Heartbeat } from "../state/heartbeat";

export type Timeframe = "today" | "7d" | "30d" | "all";

export interface FunnelStats {
  todo: number;
  agentReady: number;
  inAgent: number;
  waitingOnHuman: number;
  reviewReady: number;
  /** Unique issue IDs with observed done archives or Linear-completed state; excludes releases and unobserved sources. */
  done: number;
  /** `queue-eligible`: the dispatcher queue's eligible rows; `linear-labels`: no queue file, Linear labels only (eligibility unknown). */
  agentReadyBasis: "queue-eligible" | "linear-labels";
  completion: CompletionBreakdown;
}

/** Unique issue counts for each evidence source (may overlap). Releases are separate; mergeVerified is unobserved. */
export interface CompletionBreakdown {
  recordedDone: number;
  released: number;
  sourceCompleted: number;
  mergeVerified: number | null;
}

/** Observed scheduler health from the last tick's freshness and outcome (a heartbeat alone is not "healthy"). */
export interface DispatcherHealth {
  state: "healthy" | "degraded" | "paused" | "stale" | "unknown";
  outcome: string | null;
  ageMin: number | null;
  detail: string;
}

export interface TriageItem {
  identifier: string;
  linearId: string;
  title: string;
  project: string;
  projectKey: string;
  projectName: string;
  priority?: number;
  state: {
    id: string;
    name: string;
    type: string;
  };
  labels: string[];
  updatedAt: string;
  url: string;
  recommendedProvider: string;
}

export interface RoleJobSummary {
  id: string;
  role: string;
  provider: string;
  status: string;
  verdict: string | null;
  completedAt: string | null;
}

export type AgentAssignedStatus = "assigned" | "running" | "parked" | "completed" | "failed" | "unknown";
export type AgentProvenance = "record" | "terminal-job" | "native-job" | "inferred" | "unknown";

export interface AgentRosterEntry {
  id: string;
  role: string;
  provider: string;
  model: string | null;
  assignedStatus: AgentAssignedStatus;
  statusDetail: string;
  provenance: AgentProvenance;
  provenanceDetail: string;
  livenessVerified: boolean;
  recordedRoleStage: string;
  currentAction: string;
  worktreePath: string | null;
  branch: string | null;
  terminalHandle: string | null;
  paneKey: string | null;
  startedAt: string | null;
  completedAt: string | null;
  verdict: string | null;
}

export interface AgentRosterSummary {
  total: number;
  running: number;
  assigned: number;
  parked: number;
  completed: number;
  failed: number;
  unknown: number;
}

export interface ExecutionTaskSummary {
  id: string;
  kind: "native-ui-test";
  status: "running" | "completed" | "failed" | "unknown";
  statusDetail: string;
  recordedAction: string;
  requestedAt: string;
  device: string;
}

export interface GateSummary {
  verdict: "PASS" | "FAIL" | "NA" | "STALE" | null;
  failCount: number;
  at: string | null;
  note: string | null;
}

export interface ActiveWorktreeItem {
  identifier: string;
  linearId: string;
  linearUrl: string | null;
  title: string;
  project: string;
  repo: string;
  stage: string;
  pipelineStage: string;
  provider: string;
  model: string | null;
  worktreePath: string | null;
  branch: string | null;
  ageMin: number;
  waitingOn: string | null;
  paused: boolean;
  coordinator: {
    terminalHandle: string | null;
    paneKey: string | null;
    startedAt: string | null;
    attempt: number;
    relaunches: number;
  };
  roleJobs: RoleJobSummary[];
  roster: AgentRosterEntry[];
  rosterSummary: AgentRosterSummary;
  executionTasks?: ExecutionTaskSummary[];
  gates: Record<string, GateSummary>;
  openQuestion: {
    id: string;
    askedAt: string;
    prompt: string | null;
  } | null;
  prUrl: string | null;
  costUsd: number | null;
  tokens: number | null;
  attention: string[];
}

export interface ProjectSummary {
  key: string;
  name: string;
  linearProjectId: string;
  linearProjectUrl?: string;
  activeCount: number;
  /** Eligible queue rows only. */
  queuedCount: number;
  /** Queue rows the dispatcher skipped (each carries a reason). */
  skippedCount: number;
  /** Unique issue IDs with an archived done record for this project. */
  completedCount: number;
  /** Unique issue IDs with an archived ownership release for this project. */
  releasedCount: number;
  /** Which pause applies: the project's own scope, the global scope, or none. */
  paused: "global" | "project" | null;
  slotHeldBy: string | null;
  automation: {
    type: "orca" | "cron" | "manual";
    cadence: string;
    enabled: boolean;
    status?: "active" | "degraded" | "disabled" | "not_installed" | "paused" | "stale" | "unknown";
    provenance?: string;
  };
}

export interface ThroughputMetrics {
  timeframe: Timeframe;
  since: string;
  completedCount: number;
  inProgressCount: number;
  avgCycleMinutes: number;
  /** PASS / observed PASS-or-FAIL verdicts; null when there are no observed outcomes. */
  gatePassRate: number | null;
  gatesPassed: number;
  gatesObserved: number;
  tokens: number;
  costUsd: number;
  byProvider: Record<string, { tokens: number; costUsd: number; count: number }>;
  byProject: Record<string, { tokens: number; costUsd: number; count: number }>;
}

export interface HarnessAutomation {
  name: string;
  harness: "orca" | "claude-code" | "codex" | "cron" | "system";
  targetProject: string;
  schedule: string;
  lastRunStatus: string;
  lastRunAt: string | null;
  configured?: boolean;
  provenance?: string;
}

export type SnapshotQueueItem = QueueRow & { title?: string | null; linearUrl?: string };

export interface SnapshotResponse {
  at: string;
  dispatcher: Heartbeat | null;
  dispatcherHealth: DispatcherHealth;
  stopRequested: boolean;
  pausedScopes: string[];
  /** False when pause.json is unreadable: pause state is then unknown, not "not paused". */
  pauseStateKnown: boolean;
  globalPaused: boolean;
  pausedProjects: string[];
  funnel: FunnelStats;
  triage: TriageItem[];
  queue: SnapshotQueueItem[];
  activeWorktrees: ActiveWorktreeItem[];
  projects: ProjectSummary[];
  metrics: ThroughputMetrics;
  automations: HarnessAutomation[];
  problems: string[];
}
