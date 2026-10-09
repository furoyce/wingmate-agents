import { basename } from "node:path";
import { discoverGitLinks } from "../../src/git/trust";
import { newRecord, writeRecord } from "../../src/state/records";
import { makeWorld } from "./world";

/** All filesystem and effect paths belong to makeWorld's temporary root. */
export async function cleanupWorld() {
  const w = await makeWorld();
  const project = "bouncr";
  const repo = "api";
  const config = w.cfg.projects[project]?.repos[repo];
  if (!config) throw new Error("fixture repo missing");
  const wt = await w.orca.worktreeCreate({
    repoId: config.orcaRepo,
    name: "wm-cleanup",
    baseBranch: "basesha",
    linearIssue: "JRF-501",
    comment: "fixture",
  });
  const links = await discoverGitLinks(wt.path, null);
  const r = newRecord({
    identifier: "JRF-501",
    linearId: "i1",
    project,
    repo,
    provider: "claude",
    autonomy: "balanced",
    now: w.ctx.now(),
  });
  r.worktree = {
    ...wt,
    branch: w.orca.rows.get(wt.id)?.branch ?? "",
    baseSha: "basesha",
    gitCommonDir: links.commonDir,
    gitdirName: basename(links.gitDir),
  };
  r.stage = "done";
  r.history.push({ at: w.ctx.now(), from: "working", to: "done", cause: "owner_done", evidence: "" });
  await writeRecord(w.dirs, r);
  const claim = await w.ctx.journal.intent({
    issue: r.identifier,
    kind: "claim",
    key: `claim:${r.identifier}:1:1`,
    input: {},
    steps: ["worktree"],
  });
  await w.ctx.journal.stepDone(claim.id, "worktree", { id: wt.id, branch: r.worktree.branch, reused: false });
  await w.ctx.journal.confirmed(claim.id);
  w.clock.advance(25 * 3_600_000);
  return { ...w, r, wt, claim };
}
export type CleanupWorld = Awaited<ReturnType<typeof cleanupWorld>>;
