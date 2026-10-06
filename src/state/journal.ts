import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { newUlid } from "../shared/ids";
import type { Dirs } from "../shared/paths";
import type { Clock } from "../shared/time";
import { iso } from "../shared/time";
import { readText, writeAtomic } from "./fs";

export const JOURNAL_KINDS = [
  "commentCreate",
  "commentUpdate",
  "issueUpdate",
  "issueCreate",
  "attachmentLinkURL",
  "subscribe",
  "worktreeCreate",
  "terminalCreate",
  "terminalSend",
  "terminalClose",
  "runCreate",
  "workerStop",
  "workerAbandon",
  "workerRelease",
  "orchestrationSend",
  "gitPush",
  "prCreate",
  "claim",
  "publish",
  "handoff",
  "stop",
  "release",
  "cleanup",
] as const;

export const JournalEntrySchema = z.object({
  id: z.string(),
  issue: z.string(),
  kind: z.enum(JOURNAL_KINDS),
  key: z.string(),
  input: z.unknown(),
  state: z.enum(["intent", "acted", "confirmed", "abandoned", "poisoned"]),
  attempts: z.number().int(),
  createdAt: z.string(),
  actedAt: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  receipt: z.unknown().nullable(),
  error: z.string().nullable(),
  steps: z
    .array(
      z.object({ name: z.string(), state: z.enum(["pending", "done"]), receipt: z.unknown().nullable() }),
    )
    .default([]),
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

/** One file per external write (§6.6): intent → acted → confirmed; three failed replays poison the entry. */
export class Journal {
  constructor(
    private dirs: Dirs,
    private clock: Clock,
  ) {}
  private path(id: string) {
    return join(this.dirs.journal, `${id}.json`);
  }
  private async save(e: JournalEntry) {
    await writeAtomic(this.path(e.id), JSON.stringify(JournalEntrySchema.parse(e), null, 2));
  }
  async intent(i: {
    issue: string;
    kind: JournalEntry["kind"];
    key: string;
    input: unknown;
    steps?: string[];
  }): Promise<JournalEntry> {
    const e: JournalEntry = {
      id: newUlid(),
      issue: i.issue,
      kind: i.kind,
      key: i.key,
      input: i.input,
      state: "intent",
      attempts: 0,
      createdAt: iso(this.clock.now()),
      actedAt: null,
      confirmedAt: null,
      receipt: null,
      error: null,
      steps: (i.steps ?? []).map((name) => ({ name, state: "pending" as const, receipt: null })),
    };
    await this.save(e);
    return e;
  }
  async get(id: string): Promise<JournalEntry> {
    const t = await readText(this.path(id));
    if (t === null) throw new Error(`journal ${id} missing`);
    return JournalEntrySchema.parse(JSON.parse(t));
  }
  async acted(id: string, receipt: unknown) {
    const e = await this.get(id);
    e.state = "acted";
    e.actedAt = iso(this.clock.now());
    e.receipt = receipt;
    e.attempts += 1;
    await this.save(e);
  }
  async confirmed(id: string) {
    const e = await this.get(id);
    e.state = "confirmed";
    e.confirmedAt = iso(this.clock.now());
    await this.save(e);
  }
  async stepDone(id: string, name: string, receipt: unknown) {
    const e = await this.get(id);
    const s = e.steps.find((x) => x.name === name);
    if (s) {
      s.state = "done";
      s.receipt = receipt;
    }
    await this.save(e);
  }
  async failed(id: string, error: string) {
    const e = await this.get(id);
    e.attempts += 1;
    e.error = error;
    if (e.attempts >= 3) e.state = "poisoned";
    await this.save(e);
  }
  async abandon(id: string, error: string) {
    const e = await this.get(id);
    e.state = "abandoned";
    e.error = error;
    await this.save(e);
  }
  async all(): Promise<JournalEntry[]> {
    await mkdir(this.dirs.journal, { recursive: true });
    const out: JournalEntry[] = [];
    for (const n of await readdir(this.dirs.journal)) {
      if (n.endsWith(".json")) out.push(await this.get(n.replace(/\.json$/, "")));
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }
  async pending(): Promise<JournalEntry[]> {
    return (await this.all()).filter((e) => e.state === "intent" || e.state === "acted");
  }
}
