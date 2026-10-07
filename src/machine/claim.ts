// src/machine/claim.ts — the §5.4 sequence as one journal entry with ordered steps; provisionAndLaunch is also the replay path
// (tick, unfinished claim steps) and the reroute launch.
import { basename, join } from "node:path";
import { z } from "zod";
import { type ProjectConfig, type RepoConfig, repoFor } from "../config/schema";
import { qualifiedBase } from "../git/refname";
import { githubUrl, remoteBranch } from "../git/remote";
import { discoverGitLinks, mainCheckoutTarget } from "../git/trust";
import { pointerBrief } from "../kit/brief";
import { installKit } from "../kit/install";
import { staleIntents } from "../kit/intents";
import { agentEnv, coordinatorArgv, launchCommand } from "../kit/settings";
import { MARK } from "../linear/markers";
import { resolveTier } from "../policy/providers";
import { capMinFor } from "../policy/timers";
import type { FleetSnapshot, GitPort, GitTarget, LinearIssue } from "../ports";
import { WingmateError, errorCode, errorText } from "../shared/errors";
import { run } from "../shared/exec";
import { newUlid, newUuid } from "../shared/ids";
import type { JournalEntry } from "../state/journal";
import {
  type WRecord,
  archivedCycles,
  createRecordExclusive,
  newRecord,
  readArchived,
} from "../state/records";
import { type Ctx, remainingMs } from "./context";
import { allowDepsGranted } from "./grants";
import { TickAbort, isTickAbort } from "./guard";
import { kitNonce, prepareLaunch } from "./launch";
import { LinearWrites } from "./linearWrites";
import { block } from "./release";
import { MIN_WAIT_MS, assertWaitBudget, waitForTui } from "./resume";
import { saveRecord, trackRecord } from "./save";
import { addAttention, dropAttention, ensureAttempt, transition } from "./states";
import { syncStatus } from "./status";

export interface ClaimInput {
  issue: LinearIssue;
  project: ProjectConfig;
  provider: "claude" | "codex";
  repoName: string;
  routing: WRecord["routing"];
  cycle?: number;
  existingStatusCommentId?: string | null;
}
export type Tier = { model: string; effort: string };

export const CLAIM_STEPS = ["linear", "worktree", "kit", "launch", "orcaMeta"];
const EPOCH = "1970-01-01T00:00:00.000Z";

/** F4: the keys of the record's current claim entry — its claim (cycle, attempt), or the reroute it is in. */
const claimKeys = (r: WRecord): string[] => [
  `claim:${r.identifier}:${r.cycle}:${r.coordinator.attempt}`,
  `reroute:${r.identifier}:${r.cycle}:${r.repo}`,
];

/** F4: the record's own open claim entry (the newest keyed to its current claim), never another cycle's or attempt's. */
export async function openClaimEntry(ctx: Ctx, r: WRecord): Promise<JournalEntry | undefined> {
  const keys = claimKeys(r);
  return (await ctx.journal.pending())
    .filter((e) => e.issue === r.identifier && e.kind === "claim" && keys.includes(e.key))
    .at(-1);
}

const lifecycleOf = (ctx: Ctx, issue: LinearIssue): string | null =>
  issue.labels.find((l) => ctx.meta.lifecycleIds.has(l.id))?.name ?? null;

export async function claimIssue(ctx: Ctx, c: ClaimInput): Promise<WRecord> {
  const tier = await resolveTier(c.provider, { home: ctx.home });
  if (!tier) throw new WingmateError("model_unresolved", `no tier best for ${c.provider}`);
  const r = newRecord({
    identifier: c.issue.identifier,
    linearId: c.issue.id,
    project: c.project.key,
    repo: c.repoName,
    provider: c.provider,
    autonomy: c.project.autonomy,
    now: ctx.now(),
    cycle: c.cycle ?? 1,
    routing: c.routing,
    capMin: capMinFor("intake", c.project.timers),
  });
  r.coordinator.launch = { model: tier.model, effort: tier.effort };
  r.linear.statusCommentId = c.existingStatusCommentId ?? null;
  r.budget = {
    softTokens: c.project.budgets.softTokens,
    hardTokens: c.project.budgets.hardTokens,
    capLifted: false,
    softNoticeAt: null,
  };
  r.linear.lifecycleLabelAtClaim = lifecycleOf(ctx, c.issue);
  r.linear.lifecycleLabel = r.linear.lifecycleLabelAtClaim;
  r.linear.state = c.issue.state.name;
  await createRecordExclusive(ctx.dirs, r); // step 1: the claim itself (O_EXCL)
  trackRecord(r); // F1: every later write of this claim is a compare-and-write
  const entry = await ctx.journal.intent({
    issue: r.identifier,
    kind: "claim",
    key: `claim:${r.identifier}:${r.cycle}:${r.coordinator.attempt}`,
    input: { provider: c.provider, repo: c.repoName },
    steps: CLAIM_STEPS,
  });
  try {
    await claimLinear(ctx, r, c.issue, entry.id);
    await provisionAndLaunch(ctx, r, c.issue, c.project, entry.id, tier);
    return r;
  } catch (err) {
    if (isTickAbort(err)) {
      await saveRecord(ctx, r); // keep the progress; the abort is not a failed step
      throw err;
    }
    await ctx.journal.failed(entry.id, errorText(err));
    addAttention(r, "claim_step_failed");
    await saveRecord(ctx, r);
    throw err;
  }
}

/** §5.4 step 2, as Wingmate with the pre-write re-read: In Progress, `In-Agent`, the owner subscribed, the status comment. */
export async function claimLinear(ctx: Ctx, r: WRecord, issue: LinearIssue, entryId: string): Promise<void> {
  const w = new LinearWrites(ctx);
  await w.setState(r, issue, "In Progress");
  await w.setLifecycle(r, issue, "In-Agent");
  await w.subscribeOwner(r, issue);
  await syncStatus(ctx, r, issue, null, "claiming");
  await ctx.journal.stepDone(entryId, "linear", { statusCommentId: r.linear.statusCommentId });
  await saveRecord(ctx, r);
}

const worktreeName = (r: WRecord) =>
  `wm-${r.identifier.toLowerCase()}${r.routing.rerouteFrom ? `-${r.repo}` : ""}`;

/**
 * C22: the git dirs an earlier cycle recorded for a worktree this claim reuses — read from the archived records (dispatcher-owned,
 * §13.3 a), never from the worktree, whose links that cycle's agent could rewrite. Null when no archived cycle had the worktree.
 */
async function recordedGitDirs(
  ctx: Ctx,
  identifier: string,
  worktreeId: string,
): Promise<{ gitCommonDir: string; gitdirName: string } | null> {
  for (const cycle of await archivedCycles(ctx.dirs, identifier)) {
    const wt = (await readArchived(ctx.dirs, identifier, cycle))?.worktree;
    if (wt?.id === worktreeId) return { gitCommonDir: wt.gitCommonDir, gitdirName: wt.gitdirName };
  }
  return null;
}

/**
 * Why a claim's base did not verify (F3). `stale`: the local base ref is in the history of GitHub's commit — this clone has not fetched
 * since GitHub's base moved. `diverged`: it is not, git cannot tell, it names no commit, or a ref stands ready to replace GitHub's
 * commit in Orca's checkout (one named after it; F7: any replace ref) — a rewrite (an agent's sandbox may write packed-refs), kept as
 * evidence and handled as tampering. `unverifiable`: GitHub has no such branch, or the repository's main checkout cannot be used.
 */
export type BaseVerdict = "stale" | "diverged" | "unverifiable";
/** C30's verdict on the claim's base: GitHub's commit, verified here; or why it was not (F3). */
export type BaseCheck =
  | { ok: true; sha: string; fetched: boolean }
  | {
      ok: false;
      verdict: BaseVerdict;
      remote: string | null;
      local: string | null;
      fetched: boolean;
      detail: string;
    };
type BaseRefusal = Extract<BaseCheck, { ok: false }>;
/** Twelve characters of a commit name: a blocked comment's detail never carries a full digest. */
const short = (sha: string | null) => (sha ? sha.slice(0, 12) : "unresolved");
const unverifiable = (detail: string): BaseRefusal => ({
  ok: false,
  verdict: "unverifiable",
  remote: null,
  local: null,
  fetched: false,
  detail,
});

/**
 * C30 (Ruling R29): the claim's base is the remote truth — `refs/heads/<base branch>` of the configured GitHub URL (`git ls-remote`),
 * that commit fetched from the same URL when this repository lacks it — and the local qualified base ref must resolve to exactly it.
 * An agent's sandbox may rewrite the shared git dir's `packed-refs`, so a local `origin/main` alone can name a commit an agent made;
 * a clone that has not fetched since GitHub's base moved mismatches too (fail closed). F3: the two are told apart by ancestry before
 * anyone fetches over the evidence. The detail becomes the blocked comment's.
 */
export async function verifyBase(
  git: GitPort,
  t: GitTarget,
  repo: Pick<RepoConfig, "github" | "base">,
): Promise<BaseCheck> {
  const url = githubUrl(repo);
  const branch = remoteBranch(repo.base);
  const base = qualifiedBase(repo.base);
  const remote = await git.lsRemoteSha(t, url, branch);
  if (remote === null)
    return unverifiable(
      `GitHub has no branch ${branch} in ${repo.github}, so the base ${base} cannot be verified`,
    );
  const fetched = await git.fetchCommit(t, url, remote);
  const local = await git.revParse(t, base).catch((e: unknown) => {
    if (errorCode(e) === "git_dir_tampered") throw e; // moved since they were read: the claim step fails and replays
    return null;
  });
  if (local === remote) return { ok: true, sha: remote, fetched };
  // F3: a clone that has not fetched since GitHub's base moved holds an ancestor of GitHub's commit; a rewritten ref need not
  if (local !== null && (await git.isAncestor(t, local, remote)) === true) {
    const detail = `${base} is at ${short(local)} here, behind GitHub's ${branch} at ${short(remote)}: this clone has not fetched since`;
    return { ok: false, verdict: "stale", remote, local, fetched, detail };
  }
  const detail =
    local === null
      ? `${base} does not resolve to a commit here; GitHub's ${branch} is at ${short(remote)}: the ref may have been rewritten`
      : `${base} resolves to ${short(local)} here, which is not in the history of GitHub's ${branch} at ${short(remote)}: the ref may have been rewritten`;
  return { ok: false, verdict: "diverged", remote, local, fetched, detail };
}

/**
 * F1/F2: Orca resolves a `--base-branch` without a slash as `refs/heads/<name>` before the name itself (Orca 1.4.x `worktree create`),
 * so a ref of that name — an agent's sandbox can add one through packed-refs — would stand in for the commit.
 */
const shadowRef = (sha: string) => `refs/heads/${sha}`;

/**
 * F7: replace refs, as a blocked comment mentions them — by count only, since their names are agent-made. GitPort reads at most ten.
 */
const replaceRefsHeld = (n: number): string =>
  n === 1
    ? "a replace ref (refs/replace/…) exists"
    : `${n}${n >= 10 ? "+" : ""} replace refs (refs/replace/…) exist`;
/** R30: refs named after the base commit, as a blocked comment mentions them — by count, never by name (their paths are agent-made). */
const namedRefsHeld = (n: number, branch: string, sha: string): string =>
  `${n === 1 ? "a ref" : `${n}${n >= 10 ? "+" : ""} refs`} named after GitHub's ${branch} commit (…/${short(sha)}…) ${n === 1 ? "exists" : "exist"}`;
/**
 * R30: what any replace ref means for claims and how the owner removes them — said by the diverged next step, the block after a create
 * and runbook §12 alike. install's core.useReplaceRefs=false keeps Orca's checkout from following one; a claim refuses them still.
 */
const REPLACE_REFS_NEXT =
  "any replace ref refuses claims in this repository, yours included: in the repository's main checkout `git for-each-ref refs/replace/` lists them and `git update-ref -d <ref>` deletes each";

/**
 * F1/F2 (C30): the base, verified before Orca creates the issue worktree — in the repository's main checkout (`worktree ps`,
 * `isMainWorktree`), whose git dir is the common dir every worktree shares — so that Orca creates it from GitHub's commit. Orca's
 * `git worktree add` runs as the owner, outside the sandbox, and a post-checkout hook under a relative `core.hooksPath` (husky's
 * `.husky/_`) runs from the tree it checks out, as the repo setup does later (C27). So nothing here may stand in for GitHub's commit:
 * no `refs/heads/<commit>` (Orca resolves that name first), R30: no ref named after the commit in any namespace, and, F7, no replace
 * ref at all — one makes git check out other files under that commit with HEAD unchanged (install's core.useReplaceRefs=false keeps
 * Orca's git from following it; the claim refuses it still). A ref named after the commit planted after this check is the residual
 * (spec D14, runbook §16): the HEAD re-read after the create catches it, but a hook may already have run.
 */
async function baseBeforeCreate(
  ctx: Ctx,
  repo: RepoConfig,
  fleet: FleetSnapshot,
): Promise<{ check: BaseCheck; commonDir: string | null }> {
  const main = fleet.worktrees.find((w) => w.repoId === repo.orcaRepo && w.isMainWorktree === true);
  if (!main) {
    const detail = `Orca lists no main checkout of ${repo.github}, so the base cannot be verified before a worktree is created`;
    return { check: unverifiable(detail), commonDir: null };
  }
  let t: GitTarget;
  try {
    t = await mainCheckoutTarget(main.path);
  } catch (e) {
    const code = errorCode(e);
    if (code !== "main_checkout_unusable" && code !== "git_dir_tampered") throw e;
    const detail = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    if (code === "main_checkout_unusable") return { check: unverifiable(detail), commonDir: null };
    return { check: { ...unverifiable(detail), verdict: "diverged" }, commonDir: join(main.path, ".git") };
  }
  const check = await verifyBase(ctx.git, t, repo);
  if (!check.ok) return { check, commonDir: t.commonDir };
  const { sha, fetched } = check;
  const branch = remoteBranch(repo.base);
  const standIn = (local: string, detail: string): { check: BaseRefusal; commonDir: string } => ({
    check: { ok: false, verdict: "diverged", remote: sha, local, fetched, detail },
    commonDir: t.commonDir,
  });
  const shadow = await ctx.git.revParse(t, shadowRef(sha)).catch((e: unknown) => {
    if (errorCode(e) === "git_dir_tampered") throw e;
    return null;
  });
  if (shadow !== null)
    return standIn(
      shadow,
      `a ref refs/heads/${short(sha)}… named after GitHub's ${branch} commit exists here and resolves to ${short(shadow)}: Orca would create the worktree from it`,
    );
  // R30: a ref of that name in any namespace — Orca's resolution of a commit-named base may look past refs/heads/
  const named = await ctx.git.refsNamedAfter(t, sha);
  if (named.length > 0) {
    ctx.log.warn({ repo: repo.github, refs: named }, "claim refused: refs named after the base commit");
    // the base itself verified, so `local` names GitHub's commit: what is wrong is a name that could stand in for it
    return standIn(
      sha,
      `${namedRefsHeld(named.length, branch, sha)} here: a ref of that name can stand in for the commit when Orca resolves the base it is given`,
    );
  }
  const replaced = await ctx.git.replaceRefs(t);
  if (replaced.length === 0) return { check, commonDir: t.commonDir };
  ctx.log.warn({ repo: repo.github, refs: replaced }, "claim refused: replace refs in the repository");
  // the base itself verified, so `local` names GitHub's commit: what is wrong is what Orca's git would read under it
  return standIn(
    sha,
    `${replaceRefsHeld(replaced.length)} here: git reads another object in place of the object a replace ref names, so Orca's checkout of GitHub's ${branch} commit ${short(sha)} could hold other files while its HEAD still names that commit`,
  );
}

/** F3: what a base block asks of the owner — a stale clone fetches; a diverged ref is evidence, kept before anything fetches over it. */
function baseNext(verdict: BaseVerdict, commonDir: string | null): string {
  const requeue = "then move the issue back to Todo to re-queue it";
  if (verdict === "stale")
    return `this clone is behind GitHub: run \`git fetch origin\` in the repository's main checkout, ${requeue}`;
  if (verdict === "diverged") {
    const common = commonDir ?? "<the repository's .git>";
    return `treat this as possible tampering and keep the evidence: copy ${common}/packed-refs aside first (with ${common}/refs/replace/ if it exists), run \`wingmate stop --all\` and follow the rotation steps (docs/linear-app-setup.md); only then, in the repository's main checkout, run \`git fetch origin\` and delete any ref the detail points at that you did not make (\`git update-ref -d <ref>\`); ${REPLACE_REFS_NEXT}; ${requeue}`;
  }
  return `fix the cause the detail names (repos.<name>.base against the repository's branches on GitHub, or Orca's main checkout of the repository), ${requeue}`;
}

/**
 * C30: blocked as a failed setup is (§5.4 step 4) — attention (F3: `base_diverged` for a possible rewrite), a ledger event naming both
 * commits and the verdict, then the Blocked label and comment, the claim entry abandoned. F1/F2: a claim that would create its worktree
 * blocks before Orca creates anything; one that reuses a worktree, before anything runs there — no kit, no setup, no terminal either way.
 */
async function baseMismatch(
  ctx: Ctx,
  r: WRecord,
  issue: LinearIssue,
  entryId: string,
  repo: RepoConfig,
  check: BaseRefusal,
  at: { commonDir: string | null; reused: boolean },
): Promise<void> {
  const base = qualifiedBase(repo.base);
  const branch = remoteBranch(repo.base);
  const { remote, local, verdict } = check;
  ctx.log.warn(
    { issue: r.identifier, base, remote, local, verdict },
    "claim refused: the base is not verified as GitHub's",
  );
  addAttention(r, verdict === "diverged" ? "base_diverged" : "base_mismatch");
  const data = { base, branch, remote, local, verdict, reused: at.reused };
  await ctx.ledger.append({ at: ctx.now(), issue: r.identifier, type: "base_mismatch", data });
  await block(ctx, r, issue, "base_mismatch", check.detail, baseNext(verdict, at.commonDir));
  await ctx.journal.abandon(entryId, "base_mismatch");
}

/**
 * F7 and R30 (c, e): what a worktree this claim created must show before anything runs there — its HEAD, read with the dispatcher's own
 * pinned git (C22: `--git-dir`/`--work-tree`, replace refs ignored; never Orca's cached `worktree show` head), at the verified commit,
 * and no replace ref in the repository. Its setup runs outside the sandbox on the premise that it holds nothing an agent made (C27).
 * A read that fails refuses too (fail closed): a replay would take the worktree for a reused one and skip these checks. A ref named
 * after the commit planted after the pre-create check is what can move HEAD; one added and removed again within the create is not
 * seen (spec D14, runbook §16). Short commit names and codes only: the detail is the blocked comment's. Null when it passes.
 */
async function startRefusal(
  ctx: Ctx,
  r: WRecord,
  repo: RepoConfig,
  t: GitTarget,
  sha: string,
): Promise<{ detail: string; next: string } | null> {
  const base = qualifiedBase(repo.base);
  const unverified = (what: string, e: unknown) => {
    if (isTickAbort(e)) throw e;
    ctx.log.warn(
      { issue: r.identifier, code: errorCode(e), err: errorText(e) },
      `new worktree: ${what} unreadable`,
    );
    return {
      detail: `${what} could not be read after Orca created this worktree from the verified ${base} commit ${short(sha)} (${errorCode(e)}): its start cannot be verified`,
      next: `treat it as possible tampering (runbook: tampering; a hook may have run during the create): run \`git rev-parse HEAD\` in this worktree and \`git for-each-ref refs/replace/\` in the repository's main checkout; if HEAD is not that commit or a replace ref exists, run \`wingmate stop --all\` and follow the rotation steps (docs/linear-app-setup.md); remove this worktree, then move the issue back to Todo to re-queue it`,
    };
  };
  let head: string;
  try {
    head = await ctx.git.revParse(t, "HEAD");
  } catch (e) {
    return unverified("the new worktree's HEAD", e);
  }
  if (head !== sha)
    return {
      detail: `the new worktree starts at ${short(head)}, not at the verified ${base} commit ${short(sha)} it was created from: a ref in the repository's shared git dir may stand in for that commit`,
      next: "treat it as a possible escape (runbook: tampering; a hook may have run during the create): run `wingmate stop --all` and follow the rotation steps (docs/linear-app-setup.md), inspect the refs under the repository's .git named after that commit or like the base (refs/heads/<commit>, tags, heads), remove this worktree, then move the issue back to Todo to re-queue it",
    };
  let late: string[];
  try {
    late = await ctx.git.replaceRefs(t);
  } catch (e) {
    return unverified("the repository's replace refs", e);
  }
  if (late.length === 0) return null;
  ctx.log.warn({ issue: r.identifier, refs: late }, "replace refs appeared while Orca created the worktree");
  return {
    detail: `${replaceRefsHeld(late.length)} in the repository's shared git dir after Orca created this worktree from the verified ${base} commit ${short(sha)}: its checkout may hold other files than that commit's`,
    next: `treat it as a possible escape (runbook: tampering; a hook may have run during the create): copy ${t.commonDir}/packed-refs aside, run \`wingmate stop --all\` and follow the rotation steps (docs/linear-app-setup.md), remove this worktree; ${REPLACE_REFS_NEXT}; then move the issue back to Todo to re-queue it`,
  };
}

/**
 * REL-2: the `worktree` step's receipt written before Orca's create — this claim is about to create the issue worktree from the verified
 * commit — so a replay after a create whose own step never finished (a crash, a timeout that took effect, the precheck killed) still
 * knows the worktree is its own: the start check runs and so does the setup (C27), never the `reused` path.
 */
const Creating = z.object({ created: z.literal(true), sha: z.string().min(1) });
async function creatingReceipt(ctx: Ctx, entryId: string): Promise<string | null> {
  const step = (await ctx.journal.get(entryId)).steps.find((s) => s.name === "worktree");
  const p = Creating.safeParse(step?.state === "pending" ? step.receipt : null);
  return p.success ? p.data.sha : null;
}

/**
 * §5.4 step 3: the issue worktree — the one already linked to the issue when it exists (a previous cycle, or a crash after
 * `worktree create`), else a new one. F1/F2 (C30): a new one only once its base is verified in the repository's main checkout, with
 * no ref there standing in for that commit (R30: none named after it; F7: no replace ref either), and created from that commit; a ref
 * planted between that check and Orca's checkout is the residual (spec D14, runbook §16). C22: its git dirs come from its own gitfile
 * and commondir, accepted only in a linked worktree's layout and, for a reused worktree, only as an earlier cycle recorded them; the
 * agent's sandbox grants and denies are spelled from them, so a mismatch blocks the issue (`kit_tampered`) before any git runs there.
 * C30: a reused worktree's base is checked there (the local base ref — F7: its full ref — must name GitHub's commit), else
 * `base_mismatch`; a worktree this claim created must pass `startRefusal`, else `kit_tampered` — all before kit, setup or launch.
 * False when it blocked.
 */
async function provisionWorktree(
  ctx: Ctx,
  r: WRecord,
  issue: LinearIssue,
  repo: RepoConfig,
  entryId: string,
): Promise<boolean> {
  const name = worktreeName(r);
  const fleet = await ctx.orca.worktreePs();
  const existing = fleet.worktrees.find(
    (x) => x.linkedLinearIssue === r.identifier && x.displayName === name && x.repoId === repo.orcaRepo,
  );
  // REL-2: a worktree this claim's own create made (its receipt says so) is a created one on replay too, from the commit it verified
  let verified: string | null = existing ? await creatingReceipt(ctx, entryId) : null;
  const reused = !!existing && verified === null;
  let created: { id: string; path: string };
  if (existing) created = { id: existing.worktreeId, path: existing.path };
  else {
    const pre = await baseBeforeCreate(ctx, repo, fleet);
    if (!pre.check.ok) {
      await baseMismatch(ctx, r, issue, entryId, repo, pre.check, {
        commonDir: pre.commonDir,
        reused: false,
      });
      return false;
    }
    verified = pre.check.sha;
    await ctx.journal.stepReceipt(entryId, "worktree", { created: true, sha: verified });
    // F1/F2: from the verified commit itself, never the configured base's name (§5.4 step 3, amended)
    created = await ctx.orca.worktreeCreate({
      repoId: repo.orcaRepo,
      name,
      baseBranch: verified,
      linearIssue: r.identifier,
      comment: "wingmate: claimed",
    });
  }
  const shown = await ctx.orca.worktreeShow(created.id);
  let t: GitTarget;
  try {
    const recorded = reused ? await recordedGitDirs(ctx, r.identifier, created.id) : null;
    t = await discoverGitLinks(shown.path, recorded);
  } catch (e) {
    if (errorCode(e) !== "git_dir_tampered") throw e;
    const detail = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    const next =
      "inspect the worktree's .git file and its gitdir's commondir, then move the issue back to Todo to re-queue it when it is safe";
    await block(ctx, r, issue, "kit_tampered", detail, next);
    return false;
  }
  // C30: GitHub's base commit (ls-remote of the configured URL), which the local base ref — F7: its full ref, never the short name git
  // would disambiguate across the shared git dir's ref namespaces — must name: checked here, through the git dirs an earlier cycle
  // recorded (C22), for a reused worktree; a created one's base was verified before Orca made it (F1/F2)
  const check: BaseCheck =
    verified !== null ? { ok: true, sha: verified, fetched: false } : await verifyBase(ctx.git, t, repo);
  r.worktree = {
    id: created.id,
    path: shown.path,
    branch: shown.branch.replace(/^refs\/heads\//, ""),
    baseSha: check.ok ? check.sha : (check.remote ?? check.local ?? shown.head),
    gitCommonDir: t.commonDir,
    gitdirName: basename(t.gitDir),
  };
  if (!check.ok) {
    await baseMismatch(ctx, r, issue, entryId, repo, check, { commonDir: t.commonDir, reused: true });
    return false;
  }
  const refused = reused ? null : await startRefusal(ctx, r, repo, t, check.sha);
  if (refused) {
    await block(ctx, r, issue, "kit_tampered", refused.detail, refused.next);
    return false;
  }
  await ctx.journal.stepDone(entryId, "worktree", {
    id: created.id,
    branch: shown.branch,
    reused,
  });
  await saveRecord(ctx, r);
  return true;
}

const WorktreeStep = z.object({ reused: z.boolean() });
/** §5.4 step 4's cap on the repo setup. */
const SETUP_CAP_MS = 10 * 60_000;
/** REL-2: what a setup leaves of the tick for the coordinator's terminal and its first launch wait. */
const SETUP_RESERVE_MS = 30_000;
/**
 * REL-2 (§4.3): the setup's timeout — its 10-minute cap, ending SETUP_RESERVE_MS before the tick's deadline (run() kills the setup's
 * process group at it, so nothing outlives the tick); null when that leaves no useful time.
 */
function setupTimeoutMs(ctx: Ctx): number | null {
  const ms = Math.min(SETUP_CAP_MS, remainingMs(ctx) - SETUP_RESERVE_MS);
  return ms < MIN_WAIT_MS ? null : Math.floor(ms);
}
/**
 * C27 (§5.4 step 4, amended): the repo setup runs outside the sandbox, so only in a worktree this claim created — never in one it
 * reused (an earlier cycle's agent may have left a hook or a package script there) and never in a reroute's. The `worktree` step's
 * receipt says which; a receipt that does not say counts as reused. Null when the setup runs.
 */
async function setupSkip(ctx: Ctx, entryId: string): Promise<"reused" | "reroute" | null> {
  const entry = await ctx.journal.get(entryId);
  if (entry.key.startsWith("reroute:")) return "reroute";
  const step = WorktreeStep.safeParse(entry.steps.find((s) => s.name === "worktree")?.receipt);
  return step.success && !step.data.reused ? null : "reused";
}

/**
 * §5.4 step 4: kit (with tier `best` of both providers for review roles, and C28 the allow-deps grant as it stands at claim), install
 * policy, hashes; then the repo's setup, only in a worktree this claim created (C27).
 */
async function installAndSetup(
  ctx: Ctx,
  r: WRecord,
  issue: LinearIssue,
  project: ProjectConfig,
  repo: RepoConfig,
  entryId: string,
  tier: Tier,
): Promise<boolean> {
  const wt = r.worktree;
  if (!wt) throw new WingmateError("kit_no_worktree", `${r.identifier} has no worktree`);
  const kitDir = ctx.kitDirFor(r.identifier);
  const nonce = newUlid();
  const comments = (await ctx.linear.listComments([issue.id], EPOCH)).filter(
    (x) => !x.body.startsWith(MARK.status),
  );
  const tiers = {
    claude: await resolveTier("claude", { home: ctx.home }),
    codex: await resolveTier("codex", { home: ctx.home }),
  };
  const res = await installKit({
    worktreePath: wt.path,
    kitDir,
    record: r,
    cfg: ctx.cfg,
    project,
    issue: {
      identifier: r.identifier,
      title: issue.title,
      description: issue.description,
      url: issue.url,
      comments: comments.map((x) => ({ author: x.userId ?? x.botActorId ?? "unknown", body: x.body })),
      parent: issue.parent?.identifier ?? null,
      children: issue.children
        .filter((ch) => ch.stateType !== "completed" && ch.stateType !== "canceled")
        .map((ch) => ch.identifier),
    },
    nonce,
    launch: tier,
    tiers,
    toolchainPaths: ctx.toolchainPaths,
    allowDeps: await allowDepsGranted(ctx, r, issue),
  });
  await ctx.ledger.append({
    at: ctx.now(),
    issue: r.identifier,
    type: "kit_installed",
    data: { hashes: res.hashes, nonce, courtesySettings: res.courtesySettings },
  });
  const skip = repo.setup === "none" ? null : await setupSkip(ctx, entryId);
  if (skip)
    await ctx.ledger.append({
      at: ctx.now(),
      issue: r.identifier,
      type: "setup_skipped",
      data: { reason: skip },
    });
  else if (repo.setup !== "none") {
    const timeoutMs = setupTimeoutMs(ctx);
    if (timeoutMs === null) throw new TickAbort("error", "tick_deadline"); // no time for it in this tick: the next tick replays it
    const s = await run(repo.setup, { cwd: wt.path, timeoutMs, env: agentEnv(kitDir) });
    await ctx.ledger.append({
      at: ctx.now(),
      issue: r.identifier,
      type: "setup",
      data: { code: s.code, timedOut: s.timedOut, timeoutMs },
    });
    if (s.timedOut && timeoutMs < SETUP_CAP_MS) {
      // REL-2: cut off by the tick's budget, not failed: the claim step fails (journaled) and the next tick replays it once
      addAttention(r, "setup_timed_out");
      await saveRecord(ctx, r);
      await ctx.journal.failed(entryId, "setup_timed_out");
      return false;
    }
    dropAttention(r, "setup_timed_out");
    if (s.code !== 0) {
      // the command's output can carry secrets: the blocked comment names only the exit code
      await block(
        ctx,
        r,
        issue,
        "setup_failed",
        `the repository setup command exited ${s.code}${s.timedOut ? " (timeout)" : ""}`,
        "fix the setup command in config/projects.yaml or the repo, then move the issue back to Todo to re-queue",
      );
      await ctx.journal.abandon(entryId, "setup_failed");
      return false;
    }
  }
  await ctx.journal.stepDone(entryId, "kit", { nonce });
  return true;
}

/**
 * §5.4 step 5: the coordinator terminal (never a second one while a handle is recorded). F5 (§6.6, Appendix D): a `terminal create`
 * that took effect but reported a failure (a timeout, an unparseable receipt) is never repeated — `terminal list` proves the effect,
 * and the worktree's terminal titled `wingmate <identifier>` is adopted with the argv and session the failed attempt recorded.
 */
async function createCoordinator(ctx: Ctx, r: WRecord, tier: Tier): Promise<void> {
  const wt = r.worktree;
  if (!wt) throw new WingmateError("kit_no_worktree", `${r.identifier} has no worktree`);
  await prepareLaunch(ctx, r);
  const kitDir = ctx.kitDirFor(r.identifier);
  const title = `wingmate ${r.identifier}`;
  const prior = (await ctx.orca.terminalList(wt.id)).find((t) => t.title === title);
  if (!prior || !r.coordinator.argv.length) {
    const sessionId = newUuid();
    r.coordinator.argv = coordinatorArgv({
      provider: r.provider,
      model: tier.model,
      effort: tier.effort,
      sessionId,
      kitDir,
      worktreePath: wt.path,
    });
    r.coordinator.sessionId = r.provider === "claude" ? sessionId : null;
  }
  if (prior)
    await ctx.ledger.append({
      at: ctx.now(),
      issue: r.identifier,
      type: "terminal_adopted",
      data: { handle: prior.handle },
    });
  else r.coordinator.startedAt = ctx.now();
  const term = prior
    ? { handle: prior.handle, tabId: prior.tabId, leafId: prior.leafId }
    : await ctx.orca.terminalCreate(wt.id, title, launchCommand(r.coordinator.argv, agentEnv(kitDir)));
  r.coordinator.terminalHandle = term.handle;
  r.coordinator.paneKey = `${term.tabId}:${term.leafId}`;
  await saveRecord(ctx, r);
}

/**
 * C14: nothing an earlier cycle or attempt left pending in a reused worktree's outbox reaches the coordinator about to launch — those
 * intents move to `outbox/stale/` (ledgered with their count). It runs while no terminal is recorded, so no coordinator of this
 * launch has been given its brief yet and none of its own intents can be there.
 */
async function staleOutbox(ctx: Ctx, r: WRecord): Promise<void> {
  if (!r.worktree) return;
  const count = await staleIntents(r.worktree.path);
  if (count)
    await ctx.ledger.append({ at: ctx.now(), issue: r.identifier, type: "intents_staled", data: { count } });
}

/**
 * REL-1 (§5.4 step 5): a claim whose coordinator proved it started by itself — its pane working, or its own `stage.json` — while the
 * claim entry was still open (the brief went out in a tick that ended before the record was written): `working`, the entry closed.
 */
export async function launchProven(ctx: Ctx, r: WRecord, entryId: string, how: string): Promise<void> {
  await transition(ctx, r, "working", "turn_started", how);
  ensureAttempt(ctx, r);
  dropAttention(r, "launch_not_ready", "launch_unconfirmed", "claim_step_failed");
  await ctx.journal.stepDone(entryId, "launch", { stage: how });
  await ctx.journal.stepDone(entryId, "orcaMeta", null);
  await ctx.journal.confirmed(entryId);
  await saveRecord(ctx, r);
}

/**
 * Steps worktree → kit → launch → orcaMeta of §5.4. Each step is skipped when the record already proves it happened, so a crashed
 * claim replays without a second worktree or terminal (S7). A launch that never reaches tui-idle leaves the record `claimed` with
 * the failure journaled; the next tick waits on the same handle again. REL-1: its waits never run past the tick's deadline, and a
 * replay counts itself (`launchRetries`) before it starts, so one the precheck killed mid-wait counts all the same.
 */
export async function provisionAndLaunch(
  ctx: Ctx,
  r: WRecord,
  issue: LinearIssue,
  project: ProjectConfig,
  entryId: string,
  tier: Tier,
): Promise<void> {
  const repo = repoFor(project, r.repo);
  if (!r.worktree && !(await provisionWorktree(ctx, r, issue, repo, entryId))) return;
  if (!r.coordinator.terminalHandle) {
    await staleOutbox(ctx, r);
    if (!(await installAndSetup(ctx, r, issue, project, repo, entryId, tier))) return;
    await createCoordinator(ctx, r, tier);
  }
  const wt = r.worktree;
  const handle = r.coordinator.terminalHandle;
  if (!wt || !handle)
    throw new WingmateError("launch_failed", `${r.identifier}: no worktree or terminal after provisioning`);
  assertWaitBudget(ctx);
  if (!(await waitForTui(ctx, r, handle))) {
    addAttention(r, "launch_not_ready");
    await saveRecord(ctx, r);
    await ctx.journal.failed(entryId, "launch_not_ready");
    return;
  }
  const nonce = (await kitNonce(ctx, r)) ?? "";
  const receipt = await ctx.orca.terminalSend(handle, pointerBrief(r.identifier, wt.path, nonce), 10);
  if (receipt.stage === "turn_started") {
    await transition(ctx, r, "working", "turn_started");
    ensureAttempt(ctx, r);
    dropAttention(r, "launch_not_ready", "launch_unconfirmed", "claim_step_failed");
  } else {
    addAttention(r, "launch_unconfirmed");
    await ctx.ledger.append({
      at: ctx.now(),
      issue: r.identifier,
      type: "launch_unconfirmed",
      data: { requestId: receipt.requestId },
    });
  }
  await ctx.journal.stepDone(entryId, "launch", receipt);
  await ctx.orca
    .worktreeSet(wt.id, { workspaceStatus: "in-progress", comment: r.pipelineStage })
    .catch((e: unknown) => {
      if (isTickAbort(e)) throw e;
      ctx.log.warn({ issue: r.identifier, err: errorText(e) }, "worktree set failed");
    });
  await ctx.journal.stepDone(entryId, "orcaMeta", null);
  await ctx.journal.confirmed(entryId);
  await saveRecord(ctx, r);
}
