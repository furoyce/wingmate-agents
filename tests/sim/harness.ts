// tests/sim/harness.ts — the simulation world: fake Linear/Orca/git with real worktrees, an injected clock, and the I1–I10
// invariants asserted after every simulated tick.
import { expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TickOptions, type TickSummary, tick } from "../../src/machine/tick";
import type { LinearIssue } from "../../src/ports";
import { readRecord, writeRecord } from "../../src/state/records";
import { OWNER, addLabeledByOwner, todo } from "../fakes/issues";
import { type World, makeWorld } from "../fakes/world";
import { assertInvariants, snapshot } from "./invariants";

export { OWNER, todo };
export type { World };
export const world = (): Promise<World> => makeWorld();

/** The report `gate validate` writes (§8.2 stage 4): per pinned command `$ <argv>`, `exit <code>` and an output digest. */
export const pinnedReport = (gates: string[][], codes: number[] = []): string =>
  `${gates.flatMap((g, i) => [`$ ${g.join(" ")}`, `exit ${codes[i] ?? 0}`, `sha256 ${"0".repeat(64)}`]).join("\n")}\n`;

/** Make a working record publishable exactly as the CLI would have: gates PASS/NA at HEAD, validate evidence for every pinned command, one commit ahead, a summary file. */
export async function readyToFinish(w: World, identifier: string) {
  const r = await readRecord(w.dirs, identifier);
  if (!r?.worktree) throw new Error(`${identifier} has no worktree`);
  const wt = r.worktree;
  const gates = w.cfg.projects[r.project]?.repos[r.repo]?.gates;
  if (!gates) throw new Error(`${identifier}: no pinned gates for ${r.project}/${r.repo}`);
  w.git.heads.set(wt.path, "headsha"); // the agent's commit
  const head = await w.git.revParse(wt.path, "HEAD");
  for (const g of ["intake", "plan", "planVerify", "implement", "validate", "ui", "security"] as const)
    r.gates[g] = {
      verdict: g === "ui" ? "NA" : "PASS",
      failCount: 0,
      at: w.ctx.now(),
      evidencePath: g === "validate" ? ".wingmate/evidence/validate/report.txt" : null,
      headSha: head,
      dispatchId: null,
      note: null,
    };
  mkdirSync(join(wt.path, ".wingmate", "evidence", "validate"), { recursive: true });
  writeFileSync(join(wt.path, ".wingmate", "evidence", "validate", "report.txt"), pinnedReport(gates));
  writeFileSync(join(wt.path, ".wingmate", "s.md"), "Implemented the leaderboard.");
  w.git.commits.set(wt.path, 1);
  await writeRecord(w.dirs, r);
  return r;
}

export function labeledByOwner(w: World, issue: LinearIssue) {
  addLabeledByOwner(w.linear, issue);
}

export interface RunOpts extends Partial<TickOptions> {
  /** Let the tick report `tick_error` attention or an `error` outcome (tests of failure paths). */
  allowErrors?: boolean;
}

/** One tick as the automation runs it, then every invariant, with the tick's own before/after for I3, I7, I8 and I10. */
export async function runTick(w: World, opts: RunOpts = {}): Promise<TickSummary> {
  const { allowErrors, ...tickOpts } = opts;
  const pre = await snapshot(w);
  const s = await tick(w.ctx, { dryRun: false, precheck: true, ...tickOpts });
  if (!allowErrors) {
    const errors = s.attention.filter((a) => a.code === "tick_error");
    const detail = await Promise.all(
      errors.map(
        async (a) =>
          (await w.ctx.ledger.readIssue(a.identifier)).filter((e) => e.type === "tick_error").at(-1)?.data,
      ),
    );
    expect({ outcome: s.outcome === "error" ? s.reason : "ok", errors: detail }).toEqual({
      outcome: "ok",
      errors: [],
    });
  }
  await assertInvariants(w, { pre, summary: s });
  return s;
}
export const advance = (w: World, min: number) => w.clock.advance(min * 60_000);
