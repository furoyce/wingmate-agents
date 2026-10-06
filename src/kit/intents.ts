// src/kit/intents.ts — the outbox: `issue` verbs write intents here; the dispatcher executes them at the next tick (§8.1, D17).
// Intent files are an external boundary (an agent can write them directly), so the schema is strict: file paths stay inside
// the worktree and ids are alphanumeric (an id names its file).
import { mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { monotonicFactory } from "ulid";
import { z } from "zod";
import { WingmateError } from "../shared/errors";
import { IDENTIFIER_RE } from "../shared/ids";
import { readText, writeAtomic } from "../state/fs";
import { O_READ_NOFOLLOW, renameInWorktree, safeRel, worktreeDir } from "./local";

/** Monotonic within one process: intents written in the same millisecond still list (and execute) in write order. */
const nextId = monotonicFactory();
const Id = z.string().regex(/^[0-9A-Za-z]{1,64}$/, "must be alphanumeric");
const RelPath = z
  .string()
  .min(1)
  .refine((p) => safeRel(p) !== null, "must be a relative path inside the worktree");
const GateStage = z.enum(["intake", "plan", "planVerify", "implement", "validate", "ui", "security"]);
const base = { id: Id, issue: z.string().regex(IDENTIFIER_RE), createdAt: z.string().datetime() };

export const IntentSchema = z.discriminatedUnion("kind", [
  z.object({
    ...base,
    kind: z.literal("ask"),
    payload: z.object({
      questionFile: RelPath,
      options: z.array(z.string().min(1)),
      recommend: z.number().int().positive().nullable(),
      append: Id.nullable().default(null),
      reask: Id.nullable().default(null),
    }),
  }),
  z.object({
    ...base,
    kind: z.literal("gate"),
    payload: z.object({
      stage: GateStage,
      verdict: z.enum(["PASS", "FAIL", "NA"]),
      evidencePath: RelPath.nullable(),
      note: z.string().nullable(),
      method: z.enum(["loop", "graph"]).nullable(),
      headSha: z.string().nullable(),
      dispatchId: z.string().nullable(),
    }),
  }),
  z.object({ ...base, kind: z.literal("note"), payload: z.object({ text: z.string().min(1).max(2000) }) }),
  z.object({
    ...base,
    kind: z.literal("finish"),
    payload: z.object({
      summaryFile: RelPath,
      title: z.string().nullable(),
      draft: z.boolean(),
      repos: z.array(z.string()),
    }),
  }),
  z.object({
    ...base,
    kind: z.literal("handoff"),
    payload: z.object({ reason: z.string().min(1), repo: z.string().nullable() }),
  }),
  z.object({
    ...base,
    kind: z.literal("followup"),
    payload: z.object({ title: z.string().min(1), bodyFile: RelPath }),
  }),
  z.object({ ...base, kind: z.literal("run"), payload: z.object({ runId: z.string().min(1) }) }),
]);
export type Intent = z.infer<typeof IntentSchema>;
type IntentInput = z.input<typeof IntentSchema>;
type NewIntent = {
  [K in Intent["kind"]]: { issue: string; kind: K; payload: Extract<IntentInput, { kind: K }>["payload"] };
}[Intent["kind"]];

const dir = (wt: string) => join(wt, ".wingmate", "outbox");
const zodIssue = (e: z.ZodError) => {
  const i = e.issues[0];
  return `${i?.path.join(".") ?? ""} ${i?.message ?? ""}`.trim();
};

/** Appends an intent file named by its ULID (sortable → execution order). */
export async function writeIntent(wt: string, i: NewIntent): Promise<Intent> {
  const parsed = IntentSchema.safeParse({ ...i, id: nextId(), createdAt: new Date().toISOString() });
  if (!parsed.success)
    throw new WingmateError("intent_invalid", `intent_invalid: ${i.kind}: ${zodIssue(parsed.error)}`);
  await writeAtomic(join(dir(wt), `${parsed.data.id}.json`), JSON.stringify(parsed.data, null, 2));
  return parsed.data;
}

/** Pending intents in ULID order; a malformed file is an error naming the file (never skipped silently). */
export async function listIntents(wt: string): Promise<Intent[]> {
  await mkdir(dir(wt), { recursive: true });
  const out: Intent[] = [];
  for (const n of (await readdir(dir(wt))).filter((x) => x.endsWith(".json")).sort()) {
    const t = await readText(join(dir(wt), n));
    if (t === null) continue; // consumed between readdir and read
    let raw: unknown;
    try {
      raw = JSON.parse(t);
    } catch (e) {
      throw new WingmateError("intent_invalid", `intent_invalid: ${n}: ${(e as Error).message}`);
    }
    const p = IntentSchema.safeParse(raw);
    if (!p.success) throw new WingmateError("intent_invalid", `intent_invalid: ${n}: ${zodIssue(p.error)}`);
    if (`${p.data.id}.json` !== n)
      throw new WingmateError(
        "intent_invalid",
        `intent_invalid: ${n}: id ${p.data.id} does not match the file name`,
      );
    out.push(p.data);
  }
  return out;
}

/** Intents are a few hundred bytes; a larger file is invalid rather than read into the dispatcher whole. */
const MAX_INTENT_BYTES = 256 * 1024;
const OUTBOX = ".wingmate/outbox";

/**
 * One outbox file's text, read without following a symlink (F7): not the file itself and, on macOS, no directory of its path
 * either (`O_READ_NOFOLLOW`). null when it was consumed meanwhile.
 */
async function readIntentText(box: string, n: string): Promise<string | { error: string } | null> {
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(join(box, n), O_READ_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") return { error: "a symlink in its path (never followed)" };
    throw e;
  }
  try {
    const buf = Buffer.alloc(MAX_INTENT_BYTES + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead > MAX_INTENT_BYTES) return { error: `larger than ${MAX_INTENT_BYTES} bytes` };
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

/** One outbox file parsed on its own: the intent, or why it is not one (an id that cannot name its file is invalid). */
async function readOne(box: string, n: string): Promise<Intent | { error: string } | null> {
  const t = await readIntentText(box, n);
  if (t === null || typeof t !== "string") return t; // consumed between readdir and read, or unreadable as an intent
  let raw: unknown;
  try {
    raw = JSON.parse(t);
  } catch (e) {
    return { error: `not JSON (${(e as Error).message})` };
  }
  const p = IntentSchema.safeParse(raw);
  if (!p.success) return { error: zodIssue(p.error) };
  if (`${p.data.id}.json` !== n) return { error: `id ${p.data.id} does not match the file name` };
  return p.data;
}

/**
 * The dispatcher's read of the outbox: every file parsed on its own, so one invalid file cannot wedge every tick — valid intents
 * come back in ULID order, invalid files are named for `quarantineIntent`. The outbox must be a plain directory of the worktree
 * (F7: `outbox_unsafe` otherwise); `create` makes it when missing (the plan-only path passes false).
 */
export async function readIntentFiles(
  wt: string,
  create = true,
): Promise<{ intents: Intent[]; invalid: { file: string; error: string }[] }> {
  const box = await worktreeDir(wt, OUTBOX, create);
  const intents: Intent[] = [];
  const invalid: { file: string; error: string }[] = [];
  for (const n of (await readdir(box)).filter((x) => x.endsWith(".json")).sort()) {
    const one = await readOne(box, n);
    if (one === null) continue;
    if ("error" in one) invalid.push({ file: n, error: one.error });
    else intents.push(one);
  }
  return { intents, invalid };
}

/** The checked outbox and one of its subdirectories (created when missing); F7: never a symlink, always inside the worktree. */
export async function outboxDirs(wt: string, sub: "invalid" | "failed" | "done") {
  const box = await worktreeDir(wt, OUTBOX, true);
  return { box, dest: await worktreeDir(wt, `${OUTBOX}/${sub}`, true) };
}

/** Moves an outbox file aside — `invalid/` (unparseable) or `failed/` (failed three times) — where the dispatcher never reads it. */
export async function quarantineIntent(wt: string, file: string, where: "invalid" | "failed"): Promise<void> {
  if (!/^[^/\\]+\.json$/.test(file) || file.startsWith("."))
    throw new WingmateError("intent_invalid", `intent_invalid: bad outbox file name ${JSON.stringify(file)}`);
  const { box, dest } = await outboxDirs(wt, where);
  await renameInWorktree(box, dest, file);
}

/** Executed intents move to `outbox/done/` (kept for the agent's own audit; never re-read by the dispatcher). */
export async function consumeIntent(wt: string, id: string): Promise<void> {
  if (!Id.safeParse(id).success)
    throw new WingmateError("intent_invalid", `intent_invalid: bad intent id ${id}`);
  const { box, dest } = await outboxDirs(wt, "done");
  await renameInWorktree(box, dest, `${id}.json`);
}
