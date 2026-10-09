import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import pkg from "../../package.json";
import { WingmateError } from "../shared/errors";
import { OPENAI_METADATA, OPERATIONS, SKILL } from "./content";

/** This describes shipped implementation, never the readiness of the caller's installation. */
export const CAPABILITIES = {
  agentInterface: {
    format: "SKILL.md",
    transport: "wingmate CLI",
    discovery: "Import the skill folder with the host's supported skill mechanism, or read it explicitly.",
    automaticHostInstallation: false,
  },
  execution: {
    backend: "orca",
    coordinatorProviders: ["claude", "codex"],
    configuredWorkerProviders: ["claude", "codex", "cursor", "antigravity"],
    readiness: "Requires supported role, host and sandbox checks; configuration is not admission proof.",
  },
  scheduling: {
    implemented: ["orca"],
    defaultCadence: "*/5 * * * *",
    activation: "Installed disabled; enabling requires authorized activation and passing doctor checks.",
    notImplemented: ["claude-code-routines", "codex-scheduled-tasks", "cron", "launchd", "systemd"],
  },
  unmanagedFrontends: ["pi", "opencode", "grok", "gemini-cli"],
  unmanagedFrontendMeaning:
    "May read the skill and call available CLI commands; no managed execution, scheduler or isolation adapter is supplied for these frontends.",
  onboarding: "Offline plan for configured projects; no installation or activation by the planner.",
  maintenance: "Dispatcher reconciliation and lifecycle-checked cleanup; manual operator diagnostics.",
  dashboard: "Linear issues, recorded agent assignments, worktrees and reported routine state.",
} as const;

const CONTENT = {
  "skills/wingmate/SKILL.md": SKILL,
  "skills/wingmate/references/operations.md": OPERATIONS,
  "skills/wingmate/agents/openai.yaml": OPENAI_METADATA,
  "capabilities.json": `${JSON.stringify(CAPABILITIES, null, 2)}\n`,
};

export function packageInfo() {
  return {
    format: "wingmate-skill-bundle/v1",
    name: "wingmate",
    version: pkg.version,
    entrypoint: "skills/wingmate/SKILL.md",
    requires: { wingmate: pkg.version, executionBackend: "orca" },
    capabilities: CAPABILITIES,
    files: Object.entries(CONTENT).map(([path, text]) => ({
      path,
      bytes: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text).digest("hex"),
    })),
    distribution:
      "Portable skill bundle requiring an installed Wingmate CLI; not a vendor marketplace manifest or executable installer.",
  };
}

/** Only embedded public content is exported. No config, process environment, records or tokens are read. */
export async function exportPackage(destination: string) {
  if (!destination.trim() || [...destination].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
    throw new WingmateError(
      "package_path_invalid",
      "choose a nonempty output path without control characters",
    );
  const out = resolve(destination);
  try {
    // Exclusive directory creation refuses an existing directory, file or symlink. There is no --force.
    await mkdir(out, { mode: 0o755 });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new WingmateError(
      code === "EEXIST" ? "package_destination_exists" : "package_destination_unavailable",
      `cannot create new package directory: ${out}`,
      "choose a new directory beneath an existing writable parent",
    );
  }
  const manifest = packageInfo();
  try {
    for (const [relative, text] of Object.entries(CONTENT)) {
      const path = join(out, relative);
      await mkdir(dirname(path), { recursive: true, mode: 0o755 });
      await writeFile(path, text, { flag: "wx", mode: 0o644 });
    }
    await writeFile(join(out, "wingmate-package.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
      mode: 0o644,
    });
  } catch {
    // Preserve partial output for inspection instead of recursively deleting a caller-visible directory.
    throw new WingmateError(
      "package_export_incomplete",
      `package export is incomplete at ${out}; no installation or activation occurred`,
      "inspect the partial output and retry with a new destination",
    );
  }
  return { ...manifest, directory: out, installed: false, automationChanged: false };
}
