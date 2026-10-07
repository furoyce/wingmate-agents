// scripts/scrub-fixtures.ts — rewrites every fixture under tests/fixtures/ in place so that nothing sensitive or
// personal survives a commit. Idempotent: running it twice changes nothing (tests/contract/fixtures.test.ts asserts it).
//
// Rules (the contract; keep in sync with the test):
//   1. credential-shaped substrings → "[scrubbed]"; opaque cursors (`nextCursor`) → "[scrubbed]"
//   2. e-mail addresses (except *.invalid) → "user@example.invalid"
//   3. `prompt`, `lastAssistantMessage`, `preview`, `description`, `body` → first 80 characters + "…"
//   4. `/Users/<anyone>` → "/Users/owner"; the owner's username → "owner" wherever it appears (paths, hyphenated
//      scratchpad paths, `user@host` prompts); `user@host` values in `title`/`preview` → "owner@host"
//   5. `authProvenance` values that look like hex ids → "[scrubbed]"
//   6. rows of other repositories (anything but wingmate-agents) are anonymised: repository names → "project-N",
//      their worktree display names / path slugs → "project-N-wt", automation names → "automation-N" (stable numbering,
//      shared across files and applied to object keys too); this repository's rows stay intact
//   7. count fields (`totalCount`, `page.total`, `counts`, `meta.returned`, `meta.limit`) equal the rows kept
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]+/g,
  /gh[pousr]_[A-Za-z0-9]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /xox[abp]-[A-Za-z0-9-]+/g,
  /eyJ[A-Za-z0-9_-]{20,}/g,
];
export const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const USER_AT_HOST_RE = /\b[a-z0-9_.-]+@[A-Za-z0-9-]+\b(?![.\w-]*\.)/g;
const HOME_RE = /\/Users\/[A-Za-z0-9_.-]+/g;
/** The capturing owner's account name(s); every remaining occurrence (e.g. `-Users-<name>-…` scratchpad paths) becomes "owner". */
export const OWNER_USERNAMES: readonly string[] = ["jujufugh"];
export const TRUNCATE_KEYS: ReadonlySet<string> = new Set([
  "prompt",
  "lastAssistantMessage",
  "preview",
  "description",
  "body",
]);
const USER_AT_HOST_KEYS: ReadonlySet<string> = new Set(["title", "preview"]);
export const THIS_REPO = "wingmate-agents";
export const MAX_TEXT = 80;
const SCRUBBED = "[scrubbed]";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const isObject = (v: Json | undefined): v is { [k: string]: Json } =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Stable alias maps shared by every fixture in one run (repository names and automation names of other projects). */
export interface Aliases {
  repos: Map<string, string>;
  worktrees: Map<string, string>;
  automations: Map<string, string>;
}
export const newAliases = (): Aliases => ({ repos: new Map(), worktrees: new Map(), automations: new Map() });
const alias = (map: Map<string, string>, prefix: string, original: string): string => {
  const known = map.get(original);
  if (known) return known;
  const next = `${prefix}-${map.size + 1}`;
  map.set(original, next);
  return next;
};

export function truncateText(s: string): string {
  if (s.length <= MAX_TEXT) return s;
  if (s.length === MAX_TEXT + 1 && s.endsWith("…")) return s; // already truncated by an earlier run
  return `${s.slice(0, MAX_TEXT)}…`;
}

/** Identity-bearing substrings (paths, usernames, other projects' names) — applied to values AND object keys. */
export function scrubIdentity(s0: string, aliases: Aliases): string {
  let s = s0.replace(HOME_RE, "/Users/owner");
  for (const u of OWNER_USERNAMES) s = s.split(u).join("owner");
  for (const [original, name] of aliases.worktrees) s = s.split(original).join(name);
  for (const [original, name] of aliases.repos) s = s.split(original).join(name);
  return s;
}

export function scrubString(key: string, value: string, aliases: Aliases): string {
  let s = value;
  for (const re of SECRET_PATTERNS) s = s.replace(re, SCRUBBED);
  s = s.replace(EMAIL_RE, (m) => (m.endsWith(".invalid") ? m : "user@example.invalid"));
  s = scrubIdentity(s, aliases);
  if (USER_AT_HOST_KEYS.has(key)) s = s.replace(USER_AT_HOST_RE, () => "owner@host");
  if (key === "nextCursor" && s !== SCRUBBED) s = SCRUBBED;
  if (key === "authProvenance" && /^[0-9a-f]{12,}$/i.test(s)) s = SCRUBBED;
  if (TRUNCATE_KEYS.has(key)) s = truncateText(s);
  return s;
}

/** First pass: learn which repository and automation names belong to other projects (stable, sorted by first sight). */
export function learnAliases(root: Json, aliases: Aliases): void {
  const visit = (v: Json): void => {
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    if (!isObject(v)) return;
    const repo = v.repo;
    if (typeof repo === "string" && repo !== THIS_REPO && typeof v.worktreeId === "string") {
      const name = alias(aliases.repos, "project", repo);
      const slug = typeof v.path === "string" ? v.path.split("/").pop() : undefined;
      if (typeof v.displayName === "string" && v.displayName)
        aliases.worktrees.set(v.displayName, `${name}-wt`);
      if (slug) aliases.worktrees.set(slug, `${name}-wt`);
    }
    const name = v.name;
    if (typeof name === "string" && typeof v.rrule === "string" && !name.toLowerCase().includes("wingmate"))
      alias(aliases.automations, "automation", name);
    for (const x of Object.values(v)) visit(x);
  };
  visit(root);
}

function scrubValue(key: string, v: Json, aliases: Aliases): Json {
  if (typeof v === "string") return scrubString(key, v, aliases);
  if (Array.isArray(v)) return v.map((x) => scrubValue(key, x, aliases));
  if (!isObject(v)) return v;
  const out: { [k: string]: Json } = {};
  for (const [k, x] of Object.entries(v)) out[scrubIdentity(k, aliases)] = scrubValue(k, x, aliases);
  if (typeof out.rrule === "string" && typeof out.name === "string") {
    const mapped = aliases.automations.get(v.name as string);
    if (mapped) out.name = mapped;
  }
  return out;
}

/** Count fields must describe the rows actually kept (fixtures are sampled). */
export function fixCounts(root: Json): Json {
  if (!isObject(root)) return root;
  const r = root.result;
  if (!isObject(r)) return root;
  if (Array.isArray(r.worktrees)) r.totalCount = r.worktrees.length;
  if (Array.isArray(r.terminals)) r.totalCount = r.terminals.length;
  if (Array.isArray(r.workers)) {
    if (isObject(r.page)) r.page.total = r.workers.length;
    const retained = r.workers.filter((w) => isObject(w) && w.terminalState === "retained").length;
    r.counts = { retained, released: r.workers.length - retained };
  }
  if (Array.isArray(r.automations) && Array.isArray(r.items))
    r.items = r.items.slice(0, r.automations.length);
  if (Array.isArray(r.issues) && isObject(r.meta)) {
    r.meta.returned = r.issues.length;
    r.meta.limit = r.issues.length;
  }
  return root;
}

export function scrubFixture(text: string, aliases: Aliases): string {
  const parsed = JSON.parse(text) as Json;
  const scrubbed = fixCounts(scrubValue("", parsed, aliases));
  return `${JSON.stringify(scrubbed, null, 2)}\n`;
}

/** Scrubs every *.json under the given directories in place; returns the files whose content changed. */
export function scrubDirs(dirs: readonly string[]): string[] {
  const files = dirs.flatMap((d) =>
    readdirSync(d)
      .filter((n) => n.endsWith(".json"))
      .sort()
      .map((n) => join(d, n)),
  );
  const aliases = newAliases();
  for (const f of files) learnAliases(JSON.parse(readFileSync(f, "utf8")) as Json, aliases);
  const changed: string[] = [];
  for (const f of files) {
    const before = readFileSync(f, "utf8");
    const after = scrubFixture(before, aliases);
    if (after !== before) {
      writeFileSync(f, after);
      changed.push(f);
    }
  }
  return changed;
}

if (import.meta.main) {
  const changed = scrubDirs(["tests/fixtures/orca", "tests/fixtures/linear"]);
  process.stdout.write(
    changed.length
      ? `scrubbed ${changed.length} file(s):\n${changed.map((f) => `  ${f}\n`).join("")}`
      : "fixtures already clean\n",
  );
}
