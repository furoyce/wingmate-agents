// src/orca/fleet.ts — Zod parsers for `worktree ps`, `terminal list` and `account list` envelopes (shapes from spike results §4).
import { z } from "zod";
import type { FleetSnapshot, ProviderLimits, RateLimits, TerminalRow } from "../ports";
import { fromEpochMs } from "../shared/time";

const Env = z.object({ ok: z.boolean(), result: z.unknown() });

const AgentZ = z.object({
  paneKey: z.string(),
  state: z.string(),
  agentType: z.string().nullable().optional(),
  stateStartedAt: z.number().nullable().optional(),
  updatedAt: z.number().nullable().optional(),
});
const RowZ = z.object({
  worktreeId: z.string(),
  repoId: z.string(),
  path: z.string(),
  branch: z.string().nullable().default(""),
  displayName: z.string().nullable().default(""),
  linkedLinearIssue: z.string().nullable().default(null),
  status: z.string().default("unknown"),
  liveTerminalCount: z.number().default(0),
  lastOutputAt: z.number().nullable().default(null),
  childWorktreeIds: z.array(z.string()).default([]),
  agents: z.array(AgentZ).default([]),
  isMainWorktree: z.boolean().default(false),
});
const PsZ = z.object({
  worktrees: z.array(RowZ),
  truncated: z.boolean().default(false),
  hostScope: z.object({ omittedHostIds: z.array(z.string()).default([]) }).default({}),
});

/** Orca reports epoch milliseconds; records and the machine use ISO-8601 UTC strings. */
const ms = (n: number | null | undefined): string | null => (n == null ? null : fromEpochMs(n));
const shortBranch = (b: string | null) => (b ?? "").replace(/^refs\/heads\//, "");

export function parseFleet(envelope: unknown): FleetSnapshot {
  const raw = Env.parse(envelope).result;
  const ps = PsZ.parse(raw);
  const cleanupVerified = z
    .object({
      truncated: z.boolean(),
      hostScope: z.object({ omittedHostIds: z.array(z.string()) }),
      worktrees: z.array(
        z.object({
          liveTerminalCount: z.number(),
          agents: z.array(AgentZ),
          childWorktreeIds: z.array(z.string()),
        }),
      ),
    })
    .safeParse(raw).success;
  return {
    cleanupVerified,
    truncated: ps.truncated,
    omittedHostIds: ps.hostScope.omittedHostIds,
    worktrees: ps.worktrees.map((w) => ({
      worktreeId: w.worktreeId,
      repoId: w.repoId,
      path: w.path,
      branch: shortBranch(w.branch),
      displayName: w.displayName ?? "",
      linkedLinearIssue: w.linkedLinearIssue,
      status: w.status,
      liveTerminalCount: w.liveTerminalCount,
      lastOutputAt: ms(w.lastOutputAt),
      childWorktreeIds: w.childWorktreeIds,
      isMainWorktree: w.isMainWorktree,
      agents: w.agents.map((a) => ({
        paneKey: a.paneKey,
        state: a.state,
        agentType: a.agentType ?? null,
        stateStartedAt: ms(a.stateStartedAt),
        updatedAt: ms(a.updatedAt),
      })),
    })),
  };
}

// `agentIdentity` is optional on terminal rows (absent on plain shells) and not part of the DTO.
const TermZ = z.object({
  handle: z.string(),
  tabId: z.string(),
  leafId: z.string(),
  worktreeId: z.string(),
  title: z.string().nullable().default(""),
  lastOutputAt: z.number().nullable().default(null),
});

export function parseTerminals(envelope: unknown): TerminalRow[] {
  const r = z.object({ terminals: z.array(TermZ) }).parse(Env.parse(envelope).result);
  return r.terminals.map((t) => ({
    handle: t.handle,
    tabId: t.tabId,
    leafId: t.leafId,
    worktreeId: t.worktreeId,
    title: t.title ?? "",
    lastOutputAt: ms(t.lastOutputAt),
  }));
}

export const joinPane = (row: TerminalRow): string => `${row.tabId}:${row.leafId}`;

const WindowZ = z.object({
  usedPercent: z.number(),
  windowMinutes: z.number(),
  resetsAt: z.number().nullable().optional(),
});
const BucketZ = WindowZ.extend({ name: z.string().default("bucket") });
const STATUSES = new Set(["ok", "unavailable", "error"]);

/**
 * `account list` → `rateLimits.<provider>.{session,weekly,…,status,error,updatedAt,buckets}`. The object also carries
 * non-provider keys (`claudeTarget`, `*Configured` booleans, …): an entry counts as a provider only when it is an
 * object with a `status` string or at least one usage window.
 */
export function parseRateLimits(envelope: unknown): RateLimits {
  const rl = z.object({ rateLimits: z.record(z.unknown()) }).parse(Env.parse(envelope).result).rateLimits;
  const out: RateLimits = {};
  for (const [provider, raw] of Object.entries(rl)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const o = raw as Record<string, unknown>;
    const windows: ProviderLimits["windows"] = {};
    const buckets: ProviderLimits["buckets"] = [];
    for (const [k, v] of Object.entries(o)) {
      if (k === "buckets") continue;
      const w = WindowZ.safeParse(v);
      if (w.success)
        windows[k] = {
          usedPercent: w.data.usedPercent,
          windowMinutes: w.data.windowMinutes,
          resetsAt: w.data.resetsAt ?? null,
        };
    }
    if (Array.isArray(o.buckets)) {
      for (const b of o.buckets) {
        const w = BucketZ.safeParse(b);
        if (w.success)
          buckets.push({
            name: w.data.name,
            usedPercent: w.data.usedPercent,
            windowMinutes: w.data.windowMinutes,
            resetsAt: w.data.resetsAt ?? null,
          });
      }
    }
    const hasStatus = typeof o.status === "string";
    if (!hasStatus && Object.keys(windows).length === 0) continue;
    const status =
      hasStatus && STATUSES.has(o.status as string) ? (o.status as ProviderLimits["status"]) : "unavailable";
    out[provider] = {
      status,
      error: typeof o.error === "string" ? o.error : null,
      updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : null,
      windows,
      buckets,
    };
  }
  return out;
}
