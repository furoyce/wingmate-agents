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
