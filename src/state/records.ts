import { mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { WingmateError } from "../shared/errors";
import type { Dirs } from "../shared/paths";
import { createExclusive, readText, writeAtomic } from "./fs";

export const STAGES = [
  "claimed",
  "working",
  "awaiting-human",
  "review",
  "blocked",
  "released",
  "done",
  "cancelled",
] as const;
export const PIPELINE = [
  "intake",
  "plan",
  "planVerify",
  "implement",
  "validate",
  "ui",
  "security",
  "pr",
] as const;
export type Stage = (typeof STAGES)[number];
export type PipelineStage = (typeof PIPELINE)[number];

const Iso = z
  .string()
  .datetime({ offset: true })
  .or(z.string().regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/));
const Gate = z.object({
  verdict: z.enum(["PASS", "FAIL", "NA", "STALE"]).nullable().default(null),
  failCount: z.number().int().default(0),
  at: Iso.nullable().default(null),
  evidencePath: z.string().nullable().default(null),
  headSha: z.string().nullable().default(null),
  dispatchId: z.string().nullable().default(null),
  note: z.string().nullable().default(null),
});

/** The §5.1 record, schema version 1. */
export const RecordSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal("linear-issue"),
  identifier: z.string(),
  linearId: z.string(),
  project: z.string(),
  repo: z.string(),
  routing: z.object({
    basis: z.enum(["rule", "default", "ambiguous"]),
    candidates: z.array(z.string()),
    rerouteFrom: z.string().nullable(),
  }),
  cycle: z.number().int().min(1),
  stage: z.enum(STAGES),
  paused: z.boolean(),
  pipelineStage: z.enum(PIPELINE),
  provider: z.enum(["claude", "codex"]),
  tier: z.literal("best"),
  method: z.enum(["loop", "graph"]).nullable(),
  autonomy: z.enum(["ask-first", "balanced", "autonomous"]),
  worktree: z
    .object({
      id: z.string(),
      path: z.string(),
      branch: z.string(),
      baseSha: z.string(),
      gitCommonDir: z.string(),
      gitdirName: z.string(),
    })
    .nullable(),
  coordinator: z.object({
    mode: z.literal("terminal"),
    terminalHandle: z.string().nullable(),
    paneKey: z.string().nullable(),
    sessionId: z.string().nullable(),
    argv: z.array(z.string()),
    launch: z.object({ model: z.string().nullable(), effort: z.string().nullable() }),
    startedAt: Iso.nullable(),
    childRunId: z.string().nullable(),
    attempt: z.number().int(),
    relaunches: z.number().int(),
    launchRetries: z.number().int(),
  }),
  attempts: z.array(
    z.object({
      cycle: z.number().int(),
      attempt: z.number().int(),
      provider: z.string(),
      startedAt: Iso,
      endedAt: Iso.nullable(),
      outcome: z.string().nullable(),
      reason: z.string().nullable(),
      terminalHandle: z.string().nullable(),
    }),
  ),
  handoffs: z.object({ total: z.number().int(), thisCycle: z.number().int() }),
  questions: z.array(
    z.object({
      id: z.string(),
      commentId: z.string().nullable(),
      askedAt: Iso,
      status: z.enum(["open", "answered", "stale"]),
      answerCommentId: z.string().nullable(),
      answeredAt: Iso.nullable(),
      resumeAttempts: z.number().int(),
      nonAnswerCommentIds: z.array(z.string()),
    }),
  ),
  gates: z.object(Object.fromEntries(PIPELINE.map((s) => [s, Gate])) as Record<PipelineStage, typeof Gate>),
  prs: z.array(
    z.object({
      repo: z.string(),
      number: z.number().int(),
      url: z.string(),
      state: z.string(),
      headSha: z.string(),
    }),
  ),
  timers: z.object({
    stageStartedAt: Iso,
    capMin: z.number(),
    nudgedAt: Iso.nullable(),
    nudges: z.number().int().default(0),
    graceEndsAt: Iso.nullable(),
    lastActivityAt: Iso,
  }),
  attention: z.array(z.string()),
  usage: z.object({
    tokens: z.number().nullable(),
    costUsd: z.number().nullable(),
    agentMinutes: z.number(),
    bySession: z.array(
      z.object({
        role: z.string(),
        provider: z.string(),
        sessionRef: z.string(),
        tokens: z.number().nullable(),
        costUsd: z.number().nullable(),
        agentMinutes: z.number(),
        provenance: z.enum(["measured-transcript", "timed", "unknown"]),
      }),
    ),
  }),
  budget: z.object({
    softTokens: z.number().nullable(),
    hardTokens: z.number().nullable(),
    capLifted: z.boolean(),
    softNoticeAt: Iso.nullable(),
  }),
  linear: z.object({
    state: z.string().nullable(),
    lifecycleLabel: z.string().nullable(),
    lifecycleLabelAtClaim: z.string().nullable(),
    pausedWith: z.string().nullable(),
    statusCommentId: z.string().nullable(),
    subscribed: z.boolean(),
    lastSeenUpdatedAt: Iso.nullable(),
    lastSeenCommentAt: Iso.nullable(),
    finishedAt: Iso.nullable(),
  }),
  outbox: z.object({ pending: z.number().int(), lastDrainedAt: Iso.nullable() }),
  history: z.array(
    z.object({
      at: Iso,
      from: z.string(),
      to: z.string(),
      cause: z.string(),
      evidence: z.string().nullable(),
    }),
  ),
  claimedAt: Iso,
  updatedAt: Iso,
});
export type WRecord = z.infer<typeof RecordSchema>;

export interface NewRecordInput {
  identifier: string;
  linearId: string;
  project: string;
  repo: string;
  provider: "claude" | "codex";
  autonomy: WRecord["autonomy"];
  now: string;
  cycle?: number;
  routing?: WRecord["routing"];
  capMin?: number;
}

export function newRecord(i: NewRecordInput): WRecord {
  const gates = Object.fromEntries(
    PIPELINE.map((s) => [
      s,
      {
        verdict: null,
        failCount: 0,
        at: null,
        evidencePath: null,
        headSha: null,
        dispatchId: null,
        note: null,
      },
    ]),
  ) as WRecord["gates"];
  return RecordSchema.parse({
    schemaVersion: 1,
    source: "linear-issue",
    identifier: i.identifier,
    linearId: i.linearId,
    project: i.project,
    repo: i.repo,
    routing: i.routing ?? { basis: "default", candidates: [], rerouteFrom: null },
    cycle: i.cycle ?? 1,
    stage: "claimed",
    paused: false,
    pipelineStage: "intake",
    provider: i.provider,
    tier: "best",
    method: null,
    autonomy: i.autonomy,
    worktree: null,
    coordinator: {
      mode: "terminal",
      terminalHandle: null,
      paneKey: null,
      sessionId: null,
      argv: [],
      launch: { model: null, effort: null },
      startedAt: null,
      childRunId: null,
      attempt: 1,
      relaunches: 0,
      launchRetries: 0,
    },
    attempts: [],
    handoffs: { total: 0, thisCycle: 0 },
    questions: [],
    gates,
    prs: [],
    timers: {
      stageStartedAt: i.now,
      capMin: i.capMin ?? 20,
      nudgedAt: null,
      nudges: 0,
      graceEndsAt: null,
      lastActivityAt: i.now,
    },
    attention: [],
    usage: { tokens: null, costUsd: null, agentMinutes: 0, bySession: [] },
    budget: { softTokens: null, hardTokens: null, capLifted: false, softNoticeAt: null },
    linear: {
      state: null,
      lifecycleLabel: null,
      lifecycleLabelAtClaim: null,
      pausedWith: null,
      statusCommentId: null,
      subscribed: false,
      lastSeenUpdatedAt: null,
      lastSeenCommentAt: null,
      finishedAt: null,
    },
    outbox: { pending: 0, lastDrainedAt: null },
    history: [],
    claimedAt: i.now,
    updatedAt: i.now,
  });
}

const file = (dirs: Dirs, id: string) => join(dirs.records, `${id}.json`);

/** The record as it is written to disk (schema order): two versions are the same record exactly when their texts are equal. */
export const recordText = (r: WRecord): string => JSON.stringify(RecordSchema.parse(r), null, 2);

/** The claim itself: O_EXCL create of the record file; a second claim fails with `record_exists`. */
export async function createRecordExclusive(dirs: Dirs, r: WRecord): Promise<void> {
  if (!(await createExclusive(file(dirs, r.identifier), recordText(r)))) {
    throw new WingmateError("record_exists", `record for ${r.identifier} already exists`);
  }
}

function parseRecord(id: string, path: string, text: string): WRecord {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new WingmateError("record_invalid", `${id}: not valid JSON (${path}): ${(e as Error).message}`);
  }
  const parsed = RecordSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new WingmateError("record_invalid", `${id}: ${issue?.path.join(".")} ${issue?.message}`);
  }
  return parsed.data;
}

export async function readRecord(dirs: Dirs, id: string): Promise<WRecord | null> {
  const text = await readText(file(dirs, id));
  return text === null ? null : parseRecord(id, file(dirs, id), text);
}

/** The cycles of `id` in the archive (`archive/<id>.<cycle>.json`), newest first. */
export async function archivedCycles(dirs: Dirs, id: string): Promise<number[]> {
  const names = await readdir(dirs.archive).catch(() => [] as string[]);
  return names
    .flatMap((n) => {
      const m = /^(.+)\.(\d+)\.json$/.exec(n);
      return m && m[1] === id ? [Number(m[2])] : [];
    })
    .sort((a, b) => b - a);
}

/** The record of `id`'s archived cycle `cycle`, or null when there is none. */
export async function readArchived(dirs: Dirs, id: string, cycle: number): Promise<WRecord | null> {
  const path = join(dirs.archive, `${id}.${cycle}.json`);
  const text = await readText(path);
  return text === null ? null : parseRecord(id, path, text);
}

export async function writeRecord(dirs: Dirs, r: WRecord): Promise<void> {
  await writeAtomic(file(dirs, r.identifier), recordText(r));
}

export async function listRecords(dirs: Dirs): Promise<WRecord[]> {
  await mkdir(dirs.records, { recursive: true });
  const names = (await readdir(dirs.records)).filter((n) => n.endsWith(".json"));
  const out: WRecord[] = [];
  for (const n of names) {
    const r = await readRecord(dirs, n.replace(/\.json$/, ""));
    if (r) out.push(r);
  }
  return out;
}

/** Move a finished record to `archive/<id>.<cycle>.json`, freeing the identifier for a new cycle. */
export async function archiveRecord(dirs: Dirs, id: string): Promise<void> {
  const r = await readRecord(dirs, id);
  if (!r) return;
  await mkdir(dirs.archive, { recursive: true });
  await rename(file(dirs, id), join(dirs.archive, `${id}.${r.cycle}.json`));
}
