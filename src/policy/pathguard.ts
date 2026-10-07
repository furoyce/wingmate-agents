// Minimal gitignore-style globs: `**` spans directories (`**/` optional prefix), `*` and `?` stay within a segment.
function toRegex(pattern: string): RegExp {
  let re = "";
  const p = pattern.replace(/^\.\//, "");
  for (let i = 0; i < p.length; i++) {
    const c = p[i] ?? "";
    if (c === "*" && p[i + 1] === "*") {
      const slash = p[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export const globMatch = (path: string, pattern: string): boolean =>
  toRegex(pattern).test(path.replace(/^\.\//, ""));

/** Every path that matches a forbidden pattern, with the first pattern that caught it (§13.3 d path guard). */
export const violations = (paths: string[], patterns: string[]): { path: string; pattern: string }[] =>
  paths.flatMap((path) => {
    const pattern = patterns.find((pt) => globMatch(path, pt));
    return pattern ? [{ path, pattern }] : [];
  });
