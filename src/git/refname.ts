// src/git/refname.ts — git's ref-name rules for a branch (`git check-ref-format --branch`), plus no leading `+` (a refspec's force
// marker): the only branch names Wingmate pushes to or puts on a git/gh command line (§13.3 d, h), so a name can never read as an
// option, a refspec or a force push.
const SPECIAL = /[~^:?*[\\]/;

export function isBranchName(name: string): boolean {
  if (!name || name === "@" || name === "HEAD" || name.startsWith("-") || name.startsWith("+")) return false;
  if (name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  if (name.includes("//") || name.includes("..") || name.includes("@{") || SPECIAL.test(name)) return false;
  for (const ch of name) {
    const c = ch.charCodeAt(0);
    if (c <= 0x20 || c === 0x7f) return false; // control characters and space
  }
  return name.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

/**
 * F7: the configured base (`repos.<name>.base`) as the one ref it names — `origin/<b>` is `refs/remotes/origin/<b>`, a full `refs/…`
 * name stays as it is, a bare name is a local branch. A short name is never handed to `rev-parse`: git disambiguates it across
 * `$GIT_DIR/<name>`, `refs/`, `refs/tags/`, `refs/heads/` and `refs/remotes/` (gitrevisions(7)), and an agent may create refs in the
 * shared git dir (only `refs/heads/<base>*` and `refs/remotes/**` are denied to it), so a shadowing ref would move the base.
 */
export function qualifiedBase(base: string): string {
  if (base.startsWith("refs/")) return base;
  return base.includes("/") ? `refs/remotes/${base}` : `refs/heads/${base}`;
}
