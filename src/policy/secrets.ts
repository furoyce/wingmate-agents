export interface Finding {
  pattern: string;
  path?: string;
  excerpt: string;
}

// §13.3(d): the pattern set ported from ehr-dispatch guard/screen plus provider-specific shapes.
const PATTERNS: [string, RegExp][] = [
  ["anthropic", /sk-ant-[a-z0-9]{2,8}-[A-Za-z0-9_-]{20,}/],
  ["github", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ["github_pat", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ["aws", /\bAKIA[0-9A-Z]{16}\b/],
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["postgres_url", /postgres(ql)?:\/\/[^\s:@/]+:[^\s@/]+@/],
  ["supabase_key", /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{20,}\b/],
  ["slack", /\bxox[abp]-[A-Za-z0-9-]{20,}\b/],
  ["neon", /\bnpg_[A-Za-z0-9]{20,}\b/],
  ["openai", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTROPY_CANDIDATE = /\b[A-Za-z0-9+/=_-]{32,}\b/g;
// A key-like word must end right before the value (word boundary): `GH_TOKEN=`, `SECRET_KEY =`, `token:`,
// `Authorization: Bearer` qualify; `keyof`, `secretVersion:`, `authorizationHeaderName` do not.
const KEY_CONTEXT =
  /(token|secret|key|password|passwd|pwd|credential|authorization|auth|bearer)\b[^\n]{0,20}$/i;
const PLACEHOLDER_LINE = /ci-not-a-real-key|example\.invalid|sha256|sha1|md5/i;
// Shapes that are long and keyed but are code, not credentials.
const PATH_LIKE = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+){2,}$/;
const SCREAMING_SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const HAS_DIGIT = /\d/;

function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * The spans one entropy candidate is judged as: the whole token, then (Ruling R18) each piece of it split on `=` and `:`. A dotenv
 * line `NAME=value` without spaces is one candidate (`=` and `_` are in the class), so its value is judged on its own with the line
 * up to it — `NAME=` — as key context; judging the whole token first keeps every earlier detection.
 */
function candidateSpans(tok: string, at: number): { tok: string; at: number }[] {
  const out = [{ tok, at }];
  let offset = at;
  if (/[=:]/.test(tok))
    for (const piece of tok.split(/[=:]/)) {
      if (piece.length >= 32) out.push({ tok: piece, at: offset });
      offset += piece.length + 1;
    }
  return out;
}

/** A keyed high-entropy token that is not a UUID, a path, a SCREAMING_SNAKE constant or digit-free (`before` is the line up to it). */
function keyedSecret(tok: string, before: string): boolean {
  if (UUID.test(tok) || PATH_LIKE.test(tok) || SCREAMING_SNAKE.test(tok) || !HAS_DIGIT.test(tok))
    return false;
  // a bare 40+ hex digest (git SHA, checksum) is noise unless a key-like name introduces it: only keyed tokens count
  return KEY_CONTEXT.test(before) && entropy(tok) >= 3.5;
}

/**
 * Findings carry a six-character prefix only — a finding is itself written to Linear and logs (§11.2).
 * One secret yields one finding: a match whose span overlaps an earlier finding is not reported again.
 * `entropy: false` skips the keyed high-entropy heuristic; the patterns always run.
 */
export function scanText(text: string, path?: string, opts: { entropy?: boolean } = {}): Finding[] {
  const out: Finding[] = [];
  const spans: [number, number][] = [];
  const overlaps = (s: number, e: number) => spans.some(([a, b]) => s < b && e > a);
  const add = (pattern: string, m: string, start: number) => {
    const end = start + m.length;
    if (overlaps(start, end)) return;
    spans.push([start, end]);
    out.push({ pattern, ...(path ? { path } : {}), excerpt: `${m.slice(0, 6)}…` });
  };
  for (const [name, re] of PATTERNS) {
    const m = re.exec(text);
    if (m) add(name, m[0], m.index);
  }
  if (opts.entropy === false) return out;
  let offset = 0;
  for (const line of text.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    if (PLACEHOLDER_LINE.test(line)) continue;
    const hit = [...line.matchAll(ENTROPY_CANDIDATE)]
      .flatMap((m) => candidateSpans(m[0], m.index ?? 0))
      .find((s) => keyedSecret(s.tok, line.slice(0, s.at)));
    if (hit) add("high_entropy", hit.tok, lineStart + hit.at);
  }
  return out;
}

/**
 * Every added line is scanned (§13.3 d): examples and docs skip only the entropy heuristic (they hold long keyed placeholders by
 * design), never a pattern — a connection string or provider token in a Markdown file is pushed like any other line.
 */
const DOC_OR_EXAMPLE = /\.env\.example$|\.md$/i;
export const scanAddedLines = (lines: { path: string; line: string }[]): Finding[] =>
  lines.flatMap((l) => scanText(l.line, l.path, { entropy: !DOC_OR_EXAMPLE.test(l.path) }));
