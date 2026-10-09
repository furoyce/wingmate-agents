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
  done: number;
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

export interface GateSummary {
  verdict: "PASS" | "FAIL" | "NA" | "STALE" | null;
  failCount: number;
  at: string | null;
  note: string | null;
}

export interface ActiveWorktreeItem {
  identifier: string;
  linearId: string;
  title: string;
  linearUrl: string;
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
  queuedCount: number;
  completedCount: number;
  slotHeldBy: string | null;
  automation: {
    type: "orca" | "cron" | "manual";
    cadence: string;
    enabled: boolean;
  };
}

export interface ThroughputMetrics {
  timeframe: Timeframe;
  since: string;
  completedCount: number;
  inProgressCount: number;
  avgCycleMinutes: number;
  gatePassRate: number;
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
}

export type SnapshotQueueItem = QueueRow & { title?: string | null; linearUrl?: string };

export interface SnapshotResponse {
  at: string;
  dispatcher: Heartbeat | null;
  stopRequested: boolean;
  pausedScopes: string[];
  funnel: FunnelStats;
  triage: TriageItem[];
  queue: SnapshotQueueItem[];
  activeWorktrees: ActiveWorktreeItem[];
  projects: ProjectSummary[];
  metrics: ThroughputMetrics;
  automations: HarnessAutomation[];
  problems: string[];
}
