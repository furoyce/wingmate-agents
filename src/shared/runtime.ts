import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { readText, writeAtomic } from "../state/fs";
import { WingmateError } from "./errors";
import { IDENTIFIER_RE } from "./ids";

const hasControl = (value: string) =>
  [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
// PATH separators, control characters and sandbox glob syntax cannot be part of a scoped grant.
export const RuntimeBinPath = z
  .string()
  .min(1)
  .refine(
    (p) => isAbsolute(p) && !hasControl(p) && !/[:*?\[\]{}\\]/.test(p),
    "runtime bin paths must be absolute literal paths without PATH separators, controls or glob syntax",
  );
export const RuntimeSchema = z
  .object({
    binPaths: z.array(RuntimeBinPath).min(1),
    readPaths: z.array(RuntimeBinPath).min(1),
    path: z
      .string()
      .min(1)
      .refine((p) => !hasControl(p) && !p.split(":").includes("")),
  })
  .refine((r) => r.path === r.binPaths.join(":") || r.path.startsWith(`${r.binPaths.join(":")}:`), {
    message: "runtime PATH must start with the resolved bin paths",
  })
  .refine((r) => r.binPaths.every((p) => r.readPaths.includes(p)), {
    message: "runtime read grants must include every bin path",
  });
export type Runtime = z.infer<typeof RuntimeSchema>;
export interface RuntimeScope {
  home: string;
  stateRoot?: string | undefined;
  repositoryRoots?: readonly string[] | undefined;
  /** State/config, worktree and shared Git roots; no runtime grant may overlap them. */
  protectedRoots: readonly string[];
}
const inside = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};
const invalid = (message: string) =>
  new WingmateError(
    "runtime_invalid",
    message,
    "fix the trusted repository runtimeBinPaths and re-queue the issue",
  );
const canonical = async (p: string) => realpath(p).catch(() => resolve(p));

/** Config is trusted, but a broad read grant must still never expose the owner's credentials or other repositories/state. */
async function protectedPaths(
  scope: RuntimeScope,
): Promise<{ home: string; roots: string[]; states: string[] }> {
  const states = await Promise.all(
    [join(scope.home, ".local/share/wingmate"), ...(scope.stateRoot ? [scope.stateRoot] : [])].map(canonical),
  );
  return {
    home: await canonical(scope.home),
    states,
    roots: await Promise.all(
      [
        ...scope.protectedRoots,
        ...states,
        ...[
          ".ssh",
          ".aws",
          ".gnupg",
          ".kube",
          ".config",
          ".claude",
          ".codex",
          ".gitconfig",
          ".npmrc",
          ".netrc",
          "Library/Keychains",
          ".local/share/wingmate",
        ].map((p) => join(scope.home, p)),
      ].map(canonical),
    ),
  };
}

/** Resolve once in the dispatcher, never from an agent's PATH. No inferred parent-directory read grants. */
export async function resolveRuntime(
  binPaths: readonly string[],
  scope: RuntimeScope,
  inherited = process.env.PATH,
): Promise<Runtime | undefined> {
  if (!binPaths.length) return undefined;
  const protectedSet = await protectedPaths(scope);
  const check = (p: string) => {
    if (
      !RuntimeBinPath.safeParse(p).success ||
      dirname(p) === parse(p).root ||
      inside(p, protectedSet.home) ||
      protectedSet.roots.some((root) => {
        if (inside(p, root)) return true;
        if (!inside(root, p)) return false;
        // The dedicated owner-controlled installation namespace is usable without exposing its state siblings.
        const toolchains = join(root, "toolchains");
        return !protectedSet.states.includes(root) || p === toolchains || !inside(toolchains, p);
      })
    )
      throw invalid(`runtime path ${p} overlaps a protected or broad root`);
  };
  const bins: string[] = [];
  for (const p of binPaths) {
    if (!RuntimeBinPath.safeParse(p).success) throw invalid(`invalid runtime bin path ${JSON.stringify(p)}`);
    let resolved: string;
    try {
      resolved = await realpath(p);
      if (!(await stat(resolved)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw invalid(`runtime bin directory is missing or unavailable: ${p}`);
    }
    check(resolved);
    if (!bins.includes(resolved)) bins.push(resolved);
  }
  const reads = new Set(bins);
  for (const bin of bins) {
    for (const name of await readdir(bin)) {
      const entry = join(bin, name);
      if (!(await lstat(entry)).isSymbolicLink()) continue;
      let target: string;
      try {
        target = await realpath(entry);
      } catch {
        throw invalid(`runtime executable symlink is unavailable: ${entry}`);
      }
      check(target);
      if (bins.some((p) => inside(p, target))) continue;
      if (!(await stat(target)).isFile()) throw invalid(`runtime symlink does not target a file: ${entry}`);
      // Official Node npm/npx/corepack shims need their own package, not the entire distribution/home directory.
      const parts = target.split(sep);
      const index = parts.lastIndexOf("node_modules");
      const end = index < 0 ? 0 : index + (parts[index + 1]?.startsWith("@") ? 3 : 2);
      const dependency = end ? parts.slice(0, end).join(sep) : target;
      const resolvedDependency = await realpath(dependency);
      check(resolvedDependency);
      reads.add(resolvedDependency);
    }
  }
  const tail = (inherited ?? "").split(":").filter(Boolean);
  if (!tail.length || hasControl(inherited ?? ""))
    throw invalid("the trusted dispatcher PATH is missing or invalid");
  if (tail.some((p) => !isAbsolute(p)))
    throw invalid("the trusted dispatcher PATH must contain only absolute directory entries");
  const repositoryRoots = await Promise.all((scope.repositoryRoots ?? []).map(canonical));
  for (const entry of tail) {
    const resolvedEntry = await canonical(entry);
    if (repositoryRoots.some((root) => inside(root, resolvedEntry)))
      throw invalid(`the trusted dispatcher PATH contains a repository/worktree directory: ${entry}`);
  }
  return RuntimeSchema.parse({ binPaths: bins, readPaths: [...reads], path: [...bins, ...tail].join(":") });
}

/** Recheck availability, including replaced directory symlinks, before any subsequent launch or computed gate. */
export async function assertRuntime(runtime: Runtime): Promise<void> {
  for (const p of runtime.readPaths) {
    try {
      if ((await realpath(p)) !== p) throw new Error("path changed");
      const s = await stat(p);
      if (!s.isDirectory() && !s.isFile()) throw new Error("not a file or directory");
      if (runtime.binPaths.includes(p) && !s.isDirectory()) throw new Error("not a directory");
    } catch {
      throw invalid(`pinned runtime path is missing or changed: ${p}`);
    }
  }
}

/** A second copy outside the agent-writable worktree prevents launch.json edits from selecting a different gate runtime. */
export async function writeRuntime(kitDir: string, runtime: Runtime | undefined): Promise<void> {
  await writeAtomic(join(kitDir, "runtime.json"), JSON.stringify(runtime ?? null, null, 2));
}
export async function pinnedRuntime(
  kitDir: string,
  launch: { runtime?: Runtime | undefined },
): Promise<Runtime | undefined> {
  let text: string | null;
  try {
    text = await readText(join(kitDir, "runtime.json"));
  } catch {
    throw invalid(
      "cannot read the protected runtime anchor; older custom-state kits need re-queueing with current sandbox settings",
    );
  }
  if (text === null && launch.runtime === undefined) return undefined; // legacy kits
  let raw: unknown;
  try {
    raw = JSON.parse(text ?? "");
  } catch {
    throw invalid("dispatcher runtime metadata is missing or invalid");
  }
  const parsed = raw === null ? undefined : RuntimeSchema.safeParse(raw);
  if (parsed && !parsed.success) throw invalid("dispatcher runtime metadata is invalid");
  const trusted = parsed?.success ? parsed.data : undefined;
  if (JSON.stringify(trusted) !== JSON.stringify(launch.runtime))
    throw new WingmateError(
      "kit_tampered",
      "launch runtime differs from the dispatcher-owned runtime metadata",
    );
  if (trusted) await assertRuntime(trusted);
  return trusted;
}

/** The OS account home ignores HOME/WINGMATE_HOME. Only internal test dependencies may replace this root. */
export function runtimeKitDir(identifier: string, trustedKitRoot?: string): string {
  if (!IDENTIFIER_RE.test(identifier))
    throw new WingmateError("kit_path_invalid", "runtime lookup requires a valid issue identifier");
  return resolve(trustedKitRoot ?? join(userInfo().homedir, ".local/share/wingmate/kit"), identifier);
}

export async function issueRuntime(
  identifier: string,
  launch: { runtime?: Runtime | undefined; kitDir: string },
  trustedKitRoot?: string,
): Promise<Runtime | undefined> {
  const kitDir = runtimeKitDir(identifier, trustedKitRoot);
  const runtime = await pinnedRuntime(kitDir, launch);
  if (runtime && resolve(launch.kitDir) !== kitDir)
    throw new WingmateError(
      "kit_path_invalid",
      "launch runtime does not name this issue's OS-account dispatcher kit",
    );
  return runtime;
}
