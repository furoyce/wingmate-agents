import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Dirs } from "../shared/paths";
import { readText } from "./fs";

export const LedgerEventSchema = z.object({
  at: z.string(),
  issue: z.string().nullable(),
  type: z.string(),
  data: z.record(z.unknown()).default({}),
});
export type LedgerEvent = z.infer<typeof LedgerEventSchema>;

/** Append-only JSONL ledger (§13.2): one global file plus one file per issue. */
export class Ledger {
  constructor(private dirs: Dirs) {}
  async append(ev: LedgerEvent): Promise<void> {
    await mkdir(this.dirs.ledger, { recursive: true });
    const line = `${JSON.stringify(LedgerEventSchema.parse(ev))}\n`;
    await appendFile(join(this.dirs.ledger, "global.jsonl"), line, { flag: "a" });
    if (ev.issue) await appendFile(join(this.dirs.ledger, `${ev.issue}.jsonl`), line, { flag: "a" });
  }
  async readIssue(issue: string): Promise<LedgerEvent[]> {
    const t = await readText(join(this.dirs.ledger, `${issue}.jsonl`));
    if (!t) return [];
    return t
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => LedgerEventSchema.parse(JSON.parse(l)));
  }
}
