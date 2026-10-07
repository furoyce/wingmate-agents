// src/git/diff.ts — unified-diff parsing shared by the `gate` verb (agent side) and GitCli (dispatcher side).

/** Added lines of a unified diff, attributed to their file; header lines are recognized only outside hunks. */
export function parseAddedLines(diff: string): { path: string; line: string }[] {
  const added: { path: string; line: string }[] = [];
  let path = "";
  let inHunk = false;
  for (const l of diff.split("\n")) {
    if (l.startsWith("diff --git ")) {
      inHunk = false;
      path = "";
    } else if (!inHunk) {
      if (l.startsWith("+++ ")) path = l.startsWith("+++ b/") ? l.slice(6) : l.slice(4);
      else if (l.startsWith("@@")) inHunk = true;
    } else if (l.startsWith("+")) added.push({ path, line: l.slice(1) });
  }
  return added;
}
