// src/ops/status.ts — §13.2 `wingmate status`: the dispatcher block, the queue with skip reasons, per-issue rows and (`--cost`) a 7-day
// cost aggregation with its provenance split. Local state only (no Linear or Orca call), and identifiers, enum codes, numbers and
// timestamps only: no title, description or comment text is ever read here. A state file that does not parse is reported as a
// problem code instead of failing the whole report.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Dirs } from "../shared/paths";
import { readText } from "../state/fs";
import { type Heartbeat, readHeartbeat, stopRequested } from "../state/heartbeat";
import { readQueue } from "../state/queue";
import { RecordSchema, type WRecord } from "../state/records";
import { readPause } from "./pause";

export interface IssueRow {
  identifier: string;
  project: string;
  stage: string;
  pipelineStage: string;
  provider: string;
  model: string | null;
  ageMin: number;
  waitingOn: string | null;
  paused: boolean;
  attention: string[];
  prUrl: string | null;
  costUsd: number | null;
  tokens: number | null;
}
export interface CostAgg {
  tokens: number;
  costUsd: number;
  agentMinutes: number;
  sessions: number;
}
export interface QueueRow {
  identifier: string;
  project: string;
  status: string;
  reason: string | null;
  detail: string | null;
}
export interface CostReport {
  since: string;
  records: number;
  total: CostAgg;
  byProvider: Record<string, CostAgg>;
  byProject: Record<string, CostAgg>;
  byProvenance: Record<string, CostAgg>;
}
export interface StatusReport {
  at: string;
  dispatcher: Heartbeat | null;
  stopRequested: boolean;
  pausedScopes: string[];
  queueAt: string | null;
  queue: QueueRow[];
  issues: IssueRow[];
  /** State files that could not be read, as codes (`record_invalid(JRF-1)`, `heartbeat_invalid`, …). */
  problems: string[];
  cost?: CostReport;
}
/** What the report reads: the state root and the clock (no Linear, no Orca). */
export interface StatusCtx {
  dirs: Dirs;
  now(): string;
}

const ACTIVE = new Set(["claimed", "working", "awaiting-human", "review", "blocked"]);
const WEEK_MS = 7 * 86_400_000;

function waitingOn(r: WRecord): string | null {
  if (r.paused) return "owner (paused)";
  if (r.stage === "awaiting-human") return "owner (question)";
  if (r.stage === "review") return "reviewer";
  if (r.stage === "blocked") return "owner (blocked)";
  return null;
}

/** Every record file of `dir` that parses; one that does not is a problem code, never a crash. */
async function readRecords(dir: string, problems: string[], label: string): Promise<WRecord[]> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
  const out: WRecord[] = [];
  for (const n of names.sort()) {
    const id = n.replace(/\.json$/, "");
    try {
      const text = await readText(join(dir, n));
      if (text === null) continue;
      const parsed = RecordSchema.safeParse(JSON.parse(text));
      if (parsed.success) out.push(parsed.data);
      else problems.push(`${label}_invalid(${id})`);
    } catch {
      problems.push(`${label}_invalid(${id})`);
    }
  }
  return out;
}

async function attempt<T>(problems: string[], code: string, read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    problems.push(code);
    return fallback;
  }
}

const zero = (): CostAgg => ({ tokens: 0, costUsd: 0, agentMinutes: 0, sessions: 0 });
const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

function costReport(records: WRecord[], now: string): CostReport {
  const since = new Date(Date.parse(now) - WEEK_MS).toISOString();
  const recent = records.filter((r) => r.updatedAt >= since);
  const report: CostReport = {
    since,
    records: recent.length,
    total: zero(),
    byProvider: {},
    byProject: {},
    byProvenance: {},
  };
  const add = (a: CostAgg, s: WRecord["usage"]["bySession"][number]) => {
    a.tokens += s.tokens ?? 0;
    a.costUsd = round(a.costUsd + (s.costUsd ?? 0), 6);
    a.agentMinutes = round(a.agentMinutes + s.agentMinutes, 3);
    a.sessions += 1;
  };
  const bucket = (into: Record<string, CostAgg>, key: string): CostAgg => {
    const cur = into[key];
    if (cur) return cur;
    const made = zero();
    into[key] = made;
    return made;
  };
  for (const r of recent)
    for (const s of r.usage.bySession) {
      add(report.total, s);
      add(bucket(report.byProvider, s.provider), s);
      add(bucket(report.byProject, r.project), s);
      add(bucket(report.byProvenance, s.provenance), s);
    }
  return report;
}

export async function statusReport(
  ctx: StatusCtx,
  o: { cost?: boolean; project?: string } = {},
): Promise<StatusReport> {
  const now = ctx.now();
  const problems: string[] = [];
  const inScope = (project: string) => !o.project || project === o.project;
  const records = (await readRecords(ctx.dirs.records, problems, "record")).filter((r) => inScope(r.project));
  const issues: IssueRow[] = records
    .filter((r) => ACTIVE.has(r.stage))
    .sort((a, b) => a.claimedAt.localeCompare(b.claimedAt) || a.identifier.localeCompare(b.identifier))
    .map((r) => ({
      identifier: r.identifier,
      project: r.project,
      stage: r.stage,
      pipelineStage: r.pipelineStage,
      provider: r.provider,
      model: r.coordinator.launch.model,
      ageMin: Math.max(0, Math.round((Date.parse(now) - Date.parse(r.claimedAt)) / 60_000)),
      waitingOn: waitingOn(r),
      paused: r.paused,
      attention: [...r.attention],
      prUrl: r.prs[0]?.url ?? null,
      costUsd: r.usage.costUsd,
      tokens: r.usage.tokens,
    }));
  const queue = await attempt(problems, "queue_invalid", () => readQueue(ctx.dirs), null);
  const report: StatusReport = {
    at: now,
    dispatcher: await attempt(problems, "heartbeat_invalid", () => readHeartbeat(ctx.dirs), null),
    stopRequested: await attempt(problems, "stop_flag_invalid", () => stopRequested(ctx.dirs), false),
    pausedScopes: await attempt(problems, "pause_invalid", () => readPause(ctx.dirs), []),
    queueAt: queue?.at ?? null,
    queue: (queue?.items ?? [])
      .filter((i) => inScope(i.project))
      .map((i) => ({
        identifier: i.identifier,
        project: i.project,
        status: i.status,
        reason: i.reason,
        detail: i.detail,
      })),
    issues,
    problems,
  };
  if (o.cost) {
    const archived = (await readRecords(ctx.dirs.archive, problems, "archived")).filter((r) =>
      inScope(r.project),
    );
    report.cost = costReport([...records, ...archived], now);
  }
  return report;
}

const money = (n: number) => `$${n.toFixed(2)}`;
const aggLine = (k: string, v: CostAgg) =>
  `- ${k}: ${money(v.costUsd)}, ${v.tokens} tokens, ${v.agentMinutes} agent-min (${v.sessions} sessions)`;

/** Markdown for `status` / `status --md`: identifiers, enum codes, numbers and timestamps only. */
export function renderStatusMd(r: StatusReport): string {
  const d = r.dispatcher;
  const lines = [
    `## Wingmate — ${r.at}`,
    "",
    `Dispatcher: ${d ? `${d.kind} ${d.outcome}${d.reason ? ` (${d.reason})` : ""} at ${d.at}, ${d.durationMs} ms, exit ${d.exitCode}` : "no heartbeat yet"}`,
  ];
  // F10 (§9.1): the last heartbeat's quota notices, per provider (advisory: a stale snapshot still counts as available)
  const quota = Object.entries(d?.quota ?? {}).flatMap(([p, n]) =>
    n ? [`${p} ${n.attention.join(", ")} (snapshot ${n.ageMin} min old)`] : [],
  );
  if (quota.length) lines.push(`Quota: ${quota.join("; ")}`);
  if (r.pausedScopes.length) lines.push(`Paused: ${r.pausedScopes.join(", ")}`);
  if (r.stopRequested) lines.push("Stop requested: yes (ticks abort until the stop finishes)");
  if (r.problems.length) lines.push(`Problems: ${r.problems.join(", ")}`);
  lines.push("");
  if (r.issues.length) {
    lines.push(
      "| Issue | Project | Stage | Pipeline | Provider | Age | Waiting on | Cost | PR | Attention |",
      "|---|---|---|---|---|---|---|---|---|---|",
    );
    for (const i of r.issues)
      lines.push(
        `| ${i.identifier} | ${i.project} | ${i.stage} | ${i.pipelineStage} | ${i.provider}${i.model ? ` · ${i.model}` : ""} | ${i.ageMin} min | ${i.waitingOn ?? "—"} | ${i.costUsd != null ? money(i.costUsd) : i.tokens != null ? `${i.tokens} tokens` : "—"} | ${i.prUrl ?? "—"} | ${i.attention.join(", ") || "—"} |`,
      );
  } else lines.push("_No active issues._");
  if (r.queue.length) {
    lines.push("", `### Queue${r.queueAt ? ` (${r.queueAt})` : ""}`);
    for (const q of r.queue)
      lines.push(
        `- ${q.identifier} (${q.project}): ${q.status}${q.reason ? ` — ${q.reason}${q.detail ? `(${q.detail})` : ""}` : ""}`,
      );
  }
  if (r.cost) {
    const c = r.cost;
    lines.push("", `### Cost (7 days since ${c.since}; ${c.records} records)`, aggLine("total", c.total));
    lines.push("By provider:", ...Object.entries(c.byProvider).map(([k, v]) => aggLine(k, v)));
    lines.push("By project:", ...Object.entries(c.byProject).map(([k, v]) => aggLine(k, v)));
    lines.push("By provenance:", ...Object.entries(c.byProvenance).map(([k, v]) => aggLine(k, v)));
  }
  return `${lines.join("\n")}\n`;
}
