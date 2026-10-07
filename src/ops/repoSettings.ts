// src/ops/repoSettings.ts — Ruling R30 (D14, Task 13 F7): the one setting Wingmate makes in a pilot repository. Orca's `git worktree
// add` runs as the owner, outside the sandbox, and would follow a replace ref an agent plants in the shared git dir (packed or loose)
// — unless the repository's own config says `core.useReplaceRefs=false`, which agents cannot write (`<common>/config` is denied,
// §13.3 b). `install` sets it in each pilot repository's main checkout; doctor's blocking `replace_refs_disabled` reads it back.
import type { Config } from "../config/schema";
import { mainCheckoutTarget } from "../git/trust";
import type { Ctx } from "../machine/context";
import type { FleetSnapshot, GitTarget } from "../ports";
import { errorCode } from "../shared/errors";

/** The setting as install and doctor name it. */
export const REPLACE_REFS_SETTING = "core.useReplaceRefs=false";

export interface RepoSetting {
  /** `<project>/<repo>`, as config/projects.yaml names it. */
  repo: string;
  /** The repository's main checkout in Orca's fleet (`isMainWorktree`); null when Orca lists none. */
  path: string | null;
  /** `set`: install wrote it now; `unchanged`: it was false already; `failed`: it is not set, for the reason in `detail`. */
  outcome: "set" | "unchanged" | "failed";
  detail: string | null;
}

interface MainCheckout {
  repo: string;
  path: string | null;
  target: GitTarget | null;
  /** Why there is no target: no main checkout in the fleet, or one that is not a plain clone (F1/F2's `mainCheckoutTarget`). */
  problem: string | null;
}

/** Every configured repository's main checkout (F1/F2: the `worktree ps` row with `isMainWorktree`) as a pinned git target. */
async function mainCheckouts(cfg: Config, fleet: FleetSnapshot): Promise<MainCheckout[]> {
  const out: MainCheckout[] = [];
  for (const [key, p] of Object.entries(cfg.projects))
    for (const [name, repo] of Object.entries(p.repos)) {
      const id = `${key}/${name}`;
      const row = fleet.worktrees.find((w) => w.repoId === repo.orcaRepo && w.isMainWorktree === true);
      if (!row) {
        out.push({ repo: id, path: null, target: null, problem: "main checkout not in the fleet" });
        continue;
      }
      try {
        out.push({ repo: id, path: row.path, target: await mainCheckoutTarget(row.path), problem: null });
      } catch (e) {
        out.push({
          repo: id,
          path: row.path,
          target: null,
          problem: `main checkout unusable (${errorCode(e)})`,
        });
      }
    }
  return out;
}

/**
 * R30 at install: `core.useReplaceRefs=false` in each pilot repository's own config, written only where it is not false already — the
 * common config is in every issue's integrity set (§6.3 step 6), so a needless rewrite is avoided. A repository that cannot be set is
 * listed `failed` (and logged); the install goes on, and doctor's blocking `replace_refs_disabled` refuses `--enable` until it is set.
 */
export async function disableReplaceRefsInPilots(ctx: Ctx): Promise<RepoSetting[]> {
  const fleet = await ctx.orca.worktreePs();
  const out: RepoSetting[] = [];
  for (const m of await mainCheckouts(ctx.cfg, fleet)) {
    const at = { repo: m.repo, path: m.path };
    if (!m.target) {
      ctx.log.warn({ repo: m.repo, problem: m.problem }, `install: ${REPLACE_REFS_SETTING} not set`);
      out.push({ ...at, outcome: "failed", detail: m.problem });
      continue;
    }
    try {
      if ((await ctx.git.useReplaceRefs(m.target)) === false) {
        out.push({ ...at, outcome: "unchanged", detail: null });
        continue;
      }
      await ctx.git.disableReplaceRefs(m.target);
      out.push({ ...at, outcome: "set", detail: null });
    } catch (e) {
      ctx.log.warn({ repo: m.repo, code: errorCode(e) }, `install: ${REPLACE_REFS_SETTING} not set`);
      out.push({ ...at, outcome: "failed", detail: errorCode(e) });
    }
  }
  return out;
}

/** A repository's line in doctor's detail: the value read back, or why none was. */
const shown = (value: boolean | null | string): string =>
  value === false
    ? "off"
    : typeof value === "string"
      ? value
      : `NOT off (${value === null ? "unset" : "true"}): run \`wingmate install\``;

/** R30 for doctor: the setting read back in every pilot repository's main checkout; ok only when it is false in each one. */
export async function replaceRefsDisabled(
  ctx: Ctx,
  fleet: FleetSnapshot | null,
): Promise<{ ok: boolean; detail: string }> {
  if (!fleet) return { ok: false, detail: "Orca's fleet was not read, so the main checkouts are unknown" };
  const rows: string[] = [];
  let all = true;
  for (const m of await mainCheckouts(ctx.cfg, fleet)) {
    const value = m.target
      ? await ctx.git.useReplaceRefs(m.target).catch((e: unknown) => `unreadable (${errorCode(e)})`)
      : (m.problem ?? "unknown");
    if (value !== false) all = false;
    rows.push(`${m.repo}: ${shown(value)}`);
  }
  return { ok: all, detail: rows.join("; ") };
}
