import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, posix, resolve } from "node:path";
import { HOSTS, type SetupHost } from "../setup/plan";
import { WingmateError } from "../shared/errors";
import { packageInfo, skillFiles } from "./bundle";

const CONTROLS = /\p{Cc}/u;

function validatePath(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || CONTROLS.test(value))
    throw new WingmateError(
      "skill_path_invalid",
      "Choose a nonempty skill directory path without control characters.",
      "Supply --skills-dir with the parent directory in which a new wingmate folder should be created.",
    );
}

function embeddedFiles() {
  const files = skillFiles().map((file) => ({ path: file.path, content: file.content }));
  const paths = new Set<string>();
  for (const file of files) {
    if (
      typeof file.path !== "string" ||
      !file.path ||
      CONTROLS.test(file.path) ||
      isAbsolute(file.path) ||
      file.path.includes("\\") ||
      file.path.split("/").some((part) => !part || part === "." || part === "..") ||
      posix.normalize(file.path) !== file.path ||
      typeof file.content !== "string" ||
      paths.has(file.path)
    )
      throw new WingmateError("skill_bundle_invalid", "Embedded skill paths or content are invalid.");
    paths.add(file.path);
  }
  if (
    !paths.has("SKILL.md") ||
    [...paths].some((path) => [...paths].some((other) => other.startsWith(`${path}/`)))
  )
    throw new WingmateError(
      "skill_bundle_invalid",
      "Embedded skill files do not form a complete skill tree.",
    );
  return files;
}

/** Install embedded public skill content only; never connects, runs host hooks or changes automation. */
export async function installSkill(
  input: { host: SetupHost; skillsDir?: string },
  deps: { home?: string } = {},
): Promise<{
  installed: true;
  host: SetupHost;
  directory: string;
  version: string;
  automationChanged: false;
}> {
  if (!input || !HOSTS.includes(input.host))
    throw new WingmateError(
      "skill_host_invalid",
      "Choose Orca, Codex, Claude Code, Pi or OpenCode for the skill host.",
      "Use a listed --host value; this selects skill placement, not an execution or scheduler adapter.",
    );
  if (deps.home !== undefined) validatePath(deps.home);
  let parent: string;
  if (input.skillsDir !== undefined) {
    validatePath(input.skillsDir);
    parent = resolve(input.skillsDir);
  } else {
    if (input.host !== "codex" && input.host !== "claude-code")
      throw new WingmateError(
        "skill_directory_required",
        "This host requires an explicit skill parent directory.",
        "Supply --skills-dir for the actual launched agent's skill location. Orca is an ADE and does not identify that location by itself.",
      );
    const home = deps.home ?? homedir();
    validatePath(home);
    parent = resolve(home, input.host === "codex" ? ".agents/skills" : ".claude/skills");
  }
  validatePath(parent);
  const files = embeddedFiles();
  const version = packageInfo().version;
  const directory = join(parent, "wingmate");
  try {
    await mkdir(parent, { recursive: true, mode: 0o755 });
    // No force/replacement: exclusive creation also refuses existing files and dangling symlinks.
    await mkdir(directory, { mode: 0o755 });
  } catch (error) {
    throw new WingmateError(
      (error as NodeJS.ErrnoException).code === "EEXIST"
        ? "skill_destination_exists"
        : "skill_destination_unavailable",
      `Cannot create a new skill directory at ${directory}; no existing skill is replaced.`,
      "If Wingmate is already installed, have your agent read that directory's SKILL.md and resume onboarding using the CLI you invoked; do not reinstall to resume. Otherwise inspect existing paths and choose a writable parent directory. Automatic replacement is not supported.",
    );
  }
  try {
    const directories = new Set<string>();
    for (const file of files) {
      let relative = posix.dirname(file.path);
      while (relative !== ".") {
        directories.add(relative);
        relative = posix.dirname(relative);
      }
    }
    for (const relative of [...directories].sort((a, b) => a.split("/").length - b.split("/").length))
      await mkdir(join(directory, relative), { mode: 0o755 });
    for (const file of files)
      await writeFile(join(directory, file.path), file.content, { flag: "wx", mode: 0o644 });
  } catch {
    throw new WingmateError(
      "skill_install_incomplete",
      `Skill installation is incomplete at ${directory}; partial output is preserved and automation is unchanged.`,
      "Inspect the partial skill tree, then retry with a new skill parent directory. Do not treat partial output as an installed skill.",
    );
  }
  return { installed: true, host: input.host, directory, version, automationChanged: false };
}
