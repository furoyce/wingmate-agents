// src/kit/intents.ts — the outbox: `issue` verbs write intents here; the dispatcher executes them at the next tick (§8.1, D17).
// Intent files are an external boundary (an agent can write them directly), so the schema is strict: file paths stay inside
// the worktree and ids are alphanumeric (an id names its file).
import { mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { monotonicFactory } from "ulid";
import { z } from "zod";
import { WingmateError } from "../shared/errors";
import { IDENTIFIER_RE } from "../shared/ids";
import { readText, writeAtomic } from "../state/fs";
import { safeRel } from "./local";

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

/** Executed intents move to `outbox/done/` (kept for the agent's own audit; never re-read by the dispatcher). */
export async function consumeIntent(wt: string, id: string): Promise<void> {
  if (!Id.safeParse(id).success)
    throw new WingmateError("intent_invalid", `intent_invalid: bad intent id ${id}`);
  await mkdir(join(dir(wt), "done"), { recursive: true });
  await rename(join(dir(wt), `${id}.json`), join(dir(wt), "done", `${id}.json`));
}
