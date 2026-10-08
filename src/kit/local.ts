// src/kit/local.ts — the agent-side mirror under <worktree>/.wingmate/: advisory for the dispatcher, authoritative for the
// verbs' local checks (§8.0). Every file is Zod-parsed; a parse failure names the file instead of defaulting.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { z } from "zod";
import { WingmateError } from "../shared/errors";
import { readText, writeAtomic } from "../state/fs";

export const LocalSchema = z.object({
  record: z.object({
    identifier: z.string(),
    cycle: z.number().int().positive().optional(),
    attempt: z.number().int().nonnegative().optional(),
    stage: z.string(),
    pipelineStage: z.string(),
    provider: z.string(),
    childRunId: z.string().nullable(),
  }),
  gates: z.record(
    z.object({
      verdict: z.enum(["PASS", "FAIL", "NA", "STALE"]).nullable(),
      failCount: z.number().int(),
      at: z.string().nullable(),
      evidencePath: z.string().nullable(),
      headSha: z.string().nullable(),
      note: z.string().nullable(),
      method: z.enum(["loop", "graph"]).nullable().default(null),
      dispatchId: z.string().nullable().default(null),
    }),
  ),
  questions: z.array(
    z.object({ id: z.string(), status: z.enum(["open", "answered", "stale"]), askedAt: z.string() }),
  ),
  run: z.object({ childRunId: z.string() }).nullable(),
});
export type Local = z.infer<typeof LocalSchema>;

/** R31: a null model is the Claude CLI's own default (the argv carries no `--model`). */
const Model = z.string().min(1).nullable();
const Tier = z.object({ model: Model, effort: z.string().min(1) });
const Path = z.string().min(1);
/** `.wingmate/launch.json`, written by `installKit` (integrity-protected) and read by `gate` and `spawn`; every field is required. */
export const LaunchSchema = z.object({
  spawnMode: z.literal("dispatcher").optional(),
  provider: z.enum(["claude", "codex"]),
  model: Model,
  effort: z.string().min(1),
  kitDir: Path,
  /** The Orca worktree id `spawn` creates role terminals in (`terminal create --worktree id:<worktreeId>`, §8.1). */
  worktreeId: z.string().min(1),
  /** Each spawned role's dispatcher-written Claude settings file in the kit dir (`claude-settings.<role>.json`, §8.1). */
  roleSettings: z.object({
    "plan-verifier": Path,
    "code-reviewer": Path,
    "security-reviewer": Path,
    "ui-reviewer": Path,
    worker: Path,
  }),
  baseSha: z.string().nullable(),
  commonDir: z.string().min(1),
  pinnedGates: z.array(z.array(z.string().min(1)).min(1)),
  ui: z.object({
    kind: z.string(),
    paths: z.array(z.string()),
    nativePolicyHash: z.string().nullable().optional(),
  }),
  allowDeps: z.boolean(),
  forbiddenPaths: z.array(z.string()),
  verifyCross: z.boolean(),
  workers: z.array(z.string()),
  /** Tier `best` per provider for review roles (§9.2); `spawn` treats a review provider without an entry as `model_unresolved`. */
  tiers: z.record(Tier),
  quota: z.object({ weeklyMax: z.number(), sessionMax: z.number(), maxSnapshotAgeMin: z.number() }),
});
export type Launch = z.infer<typeof LaunchSchema>;

const p = (wt: string, f: string) => join(wt, ".wingmate", f);
const FILE_OF: Record<string, string> = {
  record: "record.json",
  gates: "gates.json",
  questions: "questions.json",
  run: "run.json",
};

function parseJson(code: string, file: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new WingmateError(
      code,
      `.wingmate/${file}: ${(e as Error).message}`,
      "do not edit .wingmate state files by hand",
    );
  }
}
const firstIssue = (e: z.ZodError) => {
  const i = e.issues[0];
  return {
    head: String(i?.path[0] ?? ""),
    rest: `${i?.path.slice(1).join(".") ?? ""} ${i?.message ?? ""}`.trim(),
  };
};

export async function readLocal(wt: string): Promise<Local> {
  const [r, g, q, run] = await Promise.all([
    readText(p(wt, "record.json")),
    readText(p(wt, "gates.json")),
    readText(p(wt, "questions.json")),
    readText(p(wt, "run.json")),
  ]);
  if (r === null)
    throw new WingmateError(
      "not_a_wingmate_worktree",
      `no .wingmate/record.json under ${wt}`,
      "run this from the issue worktree",
    );
  const parsed = LocalSchema.safeParse({
    record: parseJson("local_state_invalid", "record.json", r),
    gates: g === null ? {} : parseJson("local_state_invalid", "gates.json", g),
    questions: q === null ? [] : parseJson("local_state_invalid", "questions.json", q),
    run: run === null ? null : parseJson("local_state_invalid", "run.json", run),
  });
  if (!parsed.success) {
    const { head, rest } = firstIssue(parsed.error);
    throw new WingmateError(
      "local_state_invalid",
      `.wingmate/${FILE_OF[head] ?? head}: ${rest}`,
      "do not edit .wingmate state files by hand",
    );
  }
  return parsed.data;
}

export async function writeLocal(wt: string, l: Local): Promise<void> {
  await Promise.all([
    writeAtomic(p(wt, "record.json"), JSON.stringify(l.record, null, 2)),
    writeAtomic(p(wt, "gates.json"), JSON.stringify(l.gates, null, 2)),
    writeAtomic(p(wt, "questions.json"), JSON.stringify(l.questions, null, 2)),
    l.run ? writeAtomic(p(wt, "run.json"), JSON.stringify(l.run)) : Promise.resolve(),
  ]);
}

const Questions = LocalSchema.shape.questions;

/** The local `questions.json` for the dispatcher's merge; a missing or unparseable file reads as empty (it is rewritten next). */
export async function readMirrorQuestions(wt: string): Promise<Local["questions"]> {
  const t = await readText(p(wt, "questions.json"));
  if (t === null) return [];
  try {
    const parsed = Questions.safeParse(JSON.parse(t));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/**
 * The dispatcher's half of the mirror (§8.0): `record.json` and `questions.json` only, each written when its content changed.
 * `gates.json` belongs to the `gate` verb and `run.json` to `spawn`/`run`: the mirror never rewrites either (the one exception is the
 * §7.3 review loop's reset, `resetMirrorGates`).
 */
export async function writeMirror(
  wt: string,
  m: { record: Local["record"]; questions: Local["questions"] },
): Promise<string[]> {
  const wrote: string[] = [];
  for (const [file, value] of [
    ["record.json", m.record],
    ["questions.json", m.questions],
  ] as const) {
    const text = JSON.stringify(value, null, 2);
    if ((await readText(p(wt, file))) === text) continue;
    await writeAtomic(p(wt, file), text);
    wrote.push(file);
  }
  return wrote;
}

const Gates = LocalSchema.shape.gates;
const GATES_MAX_BYTES = 1024 * 1024;

/**
 * INT-1 (§7.3): the review loop resets gates on the record, and the agent's own `gates.json` — what its `gate` and `finish` order checks
 * read — gets the same reset (verdicts nulled; fail counts, evidence names and the other stages kept), so both sides re-gate from
 * `implement`. Read and written only through `.wingmate` as a plain directory of the worktree, never through a symlink. `unreadable`:
 * missing, a symlink, or not the verbs' shape — left as it is (the verbs refuse `local_state_invalid` on their own).
 */
export async function resetMirrorGates(
  wt: string,
  stages: readonly string[],
): Promise<"reset" | "unchanged" | "unreadable"> {
  let dir: string;
  let parsed: ReturnType<typeof Gates.safeParse>;
  try {
    dir = await worktreeDir(wt, ".wingmate");
    const text = (await readNoFollow(join(dir, "gates.json"), GATES_MAX_BYTES)).toString("utf8");
    parsed = Gates.safeParse(JSON.parse(text));
  } catch {
    return "unreadable"; // gone, a symlink (ELOOP), unsafe or not JSON
  }
  if (!parsed.success) return "unreadable";
  let changed = false;
  for (const s of stages) {
    const g = parsed.data[s];
    if (g && g.verdict !== null) {
      g.verdict = null;
      changed = true;
    }
  }
  if (!changed) return "unchanged";
  await writeInWorktree(dir, "gates.json", JSON.stringify(parsed.data, null, 2));
  return "reset";
}

export async function readLaunch(wt: string): Promise<Launch> {
  const t = await readText(p(wt, "launch.json"));
  if (t === null)
    throw new WingmateError(
      "launch_missing",
      ".wingmate/launch.json is missing",
      "the dispatcher installs it at claim; ask the owner to re-queue the issue",
    );
  const parsed = LaunchSchema.safeParse(parseJson("launch_invalid", "launch.json", t));
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    throw new WingmateError(
      "launch_invalid",
      `.wingmate/launch.json: ${i?.path.join(".") ?? ""} ${i?.message ?? ""}`.trim(),
      "do not edit the kit; the dispatcher will block a tampered kit",
    );
  }
  return parsed.data;
}

/** `.wingmate/stage.json`: where a relaunched or resumed coordinator continues from (§5.4 step 5, §7.1 step 1). */
export const writeStage = (
  wt: string,
  s: { pipelineStage: string; via: "gate" | "ask" | "native-ui"; questionId?: string; requestId?: string },
): Promise<void> =>
  writeAtomic(p(wt, "stage.json"), JSON.stringify({ ...s, at: new Date().toISOString() }, null, 2));

/** A path an agent names for a verb: relative to the worktree, no `..` escape, no NUL, `~` or backslash. Normalized, or null. */
export function safeRel(path: string): string | null {
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("~") || isAbsolute(path))
    return null;
  const n = normalize(path);
  if (n === "." || n === ".." || n.startsWith(`..${sep}`)) return null;
  return n;
}

/**
 * An agent-named file the dispatcher will read outside the sandbox (question, summary, follow-up body, evidence): it must be
 * a non-empty regular file whose real path stays inside the worktree, and its last component must not be a symlink.
 */
export async function worktreeFile(
  wt: string,
  path: string,
  under?: string,
): Promise<{ ok: true; rel: string; abs: string } | { ok: false; error: string }> {
  const rel = safeRel(path);
  if (rel === null) return { ok: false, error: `${path} must be a relative path inside the worktree` };
  if (under && rel !== under && !rel.startsWith(`${under}${sep}`))
    return { ok: false, error: `${path} must be under ${under}/` };
  const abs = join(wt, rel);
  const st = await lstat(abs).catch(() => null);
  if (!st) return { ok: false, error: `${rel} does not exist` };
  if (st.isSymbolicLink()) return { ok: false, error: `${rel} is a symlink` };
  if (!st.isFile() || st.size === 0) return { ok: false, error: `${rel} must be a non-empty regular file` };
  const resolved = await Promise.all([realpath(wt), realpath(abs)]).catch(() => null);
  if (!resolved || !resolved[1].startsWith(`${resolved[0]}${sep}`))
    return { ok: false, error: `${rel} resolves outside the worktree` };
  // the real path: an `O_NOFOLLOW_ANY` read of it then refuses any symlink swapped into the path after this check (F7)
  return { ok: true, rel, abs: resolved[1] };
}

/** macOS sys/fcntl.h: open(2) refuses a symlink anywhere in the path (ELOOP); must not be combined with `O_NOFOLLOW` (EINVAL). */
const O_NOFOLLOW_ANY = 0x20000000;
/**
 * open(2) flags for reading an agent-named file without following a symlink. On macOS `O_NOFOLLOW_ANY` refuses a symlink anywhere
 * in the path, so a directory swapped for a symlink after a check cannot redirect the read; it covers the last component too.
 * Elsewhere `O_NOFOLLOW` guards the file only.
 */
export const O_READ_NOFOLLOW =
  process.platform === "darwin"
    ? constants.O_RDONLY | O_NOFOLLOW_ANY
    : constants.O_RDONLY | constants.O_NOFOLLOW;
/**
 * Reads up to `max` bytes of an agent-named file that `worktreeFile` accepted, refusing a symlink swapped in since — as the file
 * (`O_NOFOLLOW`) or, on macOS, as any directory of its path (`O_NOFOLLOW_ANY`, F7).
 */
export async function readNoFollow(abs: string, max: number): Promise<Buffer> {
  const fh = await open(abs, O_READ_NOFOLLOW);
  try {
    const buf = Buffer.alloc(max);
    const { bytesRead } = await fh.read(buf, 0, max, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}
/**
 * C11: open(2) flags for creating a new file the same way — `O_CREAT | O_EXCL` never opens an existing path (a symlink planted at
 * the name is EEXIST) and, on macOS, `O_NOFOLLOW_ANY` refuses a directory of the path swapped for a symlink after its check.
 */
const O_CREATE_NOFOLLOW =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  (process.platform === "darwin" ? O_NOFOLLOW_ANY : constants.O_NOFOLLOW);
const RENAME_NOFOLLOW_ANY = 0x10; // macOS sys/stdio.h, for renamex_np

const unsafe = (msg: string) =>
  new WingmateError(
    "outbox_unsafe",
    msg,
    ".wingmate, its outbox and inbox and their subdirectories must be plain directories",
  );

/**
 * F7: a directory under the worktree that the dispatcher reads, writes or moves files into (`.wingmate`, `.wingmate/inbox` (C11),
 * `.wingmate/outbox` and its `invalid/`, `failed/`, `done/`, `stale/` (C14)). Every component below the worktree must be a real
 * directory, never a symlink, and the result must resolve inside the worktree (realpath containment, as `worktreeFile` does for
 * files). Missing components are created when `create` (never the worktree itself). Returns the real absolute path; anything else
 * is `outbox_unsafe`.
 */
export async function worktreeDir(wt: string, rel: string, create = false): Promise<string> {
  const root = await realpath(wt);
  let cur = root;
  for (const part of rel.split("/")) {
    cur = join(cur, part);
    let st = await lstat(cur).catch(() => null);
    if (!st && create) {
      await mkdir(cur).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "EEXIST") throw e;
      });
      st = await lstat(cur).catch(() => null);
    }
    const what = !st
      ? "missing"
      : st.isSymbolicLink()
        ? "a symlink"
        : st.isDirectory()
          ? null
          : "not a directory";
    if (what) throw unsafe(`${rel}: ${relative(root, cur)} is ${what}`);
  }
  if ((await realpath(cur)) !== cur) throw unsafe(`${rel} resolves outside the worktree`);
  return cur;
}

type RenameNoFollow = (from: string, to: string) => number;
let renamer: Promise<RenameNoFollow | null> | null = null;

/** macOS renamex_np(RENAME_NOFOLLOW_ANY) through Bun's built-in FFI, loaded on first use; null on other platforms. */
function noFollowRenamer(): Promise<RenameNoFollow | null> {
  renamer ??= (async () => {
    if (process.platform !== "darwin") return null;
    const { dlopen, FFIType } = await import("bun:ffi");
    const lib = dlopen("/usr/lib/libSystem.B.dylib", {
      renamex_np: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    });
    const c = (s: string) => Buffer.from(`${s}\0`, "utf8");
    return (from: string, to: string) => lib.symbols.renamex_np(c(from), c(to), RENAME_NOFOLLOW_ANY);
  })();
  return renamer;
}

/** A rename that, on macOS, refuses a symlink in any directory of either path (RENAME_NOFOLLOW_ANY); elsewhere a plain rename. */
async function moveNoFollow(from: string, to: string, name: string): Promise<void> {
  const rx = await noFollowRenamer();
  if (!rx) return rename(from, to);
  if (rx(from, to) !== 0) throw unsafe(`${name} was not moved: a symlink in its path, or the file is gone`);
}

/**
 * F7: moves `name` between two directories `worktreeDir` checked. On macOS the rename itself refuses a symlink anywhere in
 * either path (RENAME_NOFOLLOW_ANY), so a directory the agent swaps for a symlink between the check and the move still cannot
 * send an agent-written file outside the worktree; a symlink named `name` is moved as the link, never followed.
 */
export async function renameInWorktree(fromDir: string, toDir: string, name: string): Promise<void> {
  const from = join(fromDir, name);
  await lstat(from); // a file already gone keeps its ENOENT
  await moveNoFollow(from, join(toDir, name), name);
}

/**
 * C11: writes the dispatcher's own file `name` into a directory `worktreeDir` checked, never through a symlink. The temp file is
 * created exclusively (`O_CREATE_NOFOLLOW`) and moved into place with the no-follow rename, which replaces a symlink planted at
 * `name` instead of following it; a directory swapped for a symlink after the check fails the write (`outbox_unsafe`).
 */
export async function writeInWorktree(dir: string, name: string, text: string | Buffer): Promise<void> {
  const tmp = join(dir, `.${name}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const fh = await open(tmp, O_CREATE_NOFOLLOW, 0o644).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ELOOP" || e.code === "EEXIST")
      throw unsafe(`${name}: a symlink in its path (never followed)`);
    throw e;
  });
  try {
    await fh.writeFile(text);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await moveNoFollow(tmp, join(dir, name), name).catch(async (e: unknown) => {
    await unlink(tmp).catch(() => undefined); // the temp file was ours; the failure is what the caller sees
    throw e;
  });
}
