import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import pkg from "../../package.json";
import { WingmateError } from "../shared/errors";
import { CODEX_MANIFEST, CODEX_MARKETPLACE } from "./codex";
import { INSTALLATION, OPENAI_METADATA, OPERATIONS, SKILL } from "./content";
import { renderOnboardingGuide } from "./onboarding";
import { PROJECT_CONFIG_TEMPLATE } from "./projectTemplate";

/** This describes shipped implementation, never the readiness of the caller's installation. */
export const CAPABILITIES = {
  agentInterface: {
    format: "SKILL.md",
    transport: "wingmate CLI",
    discovery: "Import the skill folder with the host's supported skill mechanism, or read it explicitly.",
    automaticHostInstallation: false,
    installer: ["wingmate", "package", "install", "--host", "<host>"],
    interactiveInstallation:
      "Starts the selected Codex or Claude Code agent for guided setup; other hosts receive the shared setup flow.",
    agentInstallation:
      "JSON receipt directs the calling agent to continue setup in the current conversation.",
    codexPluginSetup:
      "Exportable local plugin with a host Run setup entrypoint; not an automatic agent launch on import.",
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
  onboarding:
    "Interactive harness/connector/project/scheduler setup plan, configuration-free guide and offline project plan; no installation or activation by these planners.",
  firstRun: {
    command: ["wingmate", "setup"],
    questions: ["wingmate", "setup", "--questions", "--json"],
    createsConnectionsOrSchedules: false,
    nextNativeScheduler: "claude-code-routines",
  },
  maintenance: "Dispatcher reconciliation and lifecycle-checked cleanup; manual operator diagnostics.",
  dashboard: "Linear issues, recorded agent assignments, worktrees and reported routine state.",
} as const;

const CONTENT = {
  "skills/wingmate/SKILL.md": SKILL,
  "skills/wingmate/references/operations.md": OPERATIONS,
  "skills/wingmate/references/installation.md": INSTALLATION,
  "skills/wingmate/references/onboarding.md": renderOnboardingGuide(),
  "skills/wingmate/agents/openai.yaml": OPENAI_METADATA,
  "skills/wingmate/assets/projects.example.yaml": PROJECT_CONFIG_TEMPLATE,
  "capabilities.json": `${JSON.stringify(CAPABILITIES, null, 2)}\n`,
};

/** Public embedded files relative to a host's wingmate skill directory. */
export function skillFiles(): readonly { path: string; content: string }[] {
  const prefix = "skills/wingmate/";
  return Object.entries(CONTENT)
    .filter(([path]) => path.startsWith(prefix))
    .map(([path, content]) => ({ path: path.slice(prefix.length), content }));
}

export type PackageFormat = "skill" | "codex";

function packageContent(format: PackageFormat): Record<string, string> {
  if (format === "skill") return CONTENT;
  if (format !== "codex")
    throw new WingmateError("package_format_invalid", "Choose skill or codex as the package format.");
  return {
    ...Object.fromEntries(Object.entries(CONTENT).map(([path, text]) => [`plugins/wingmate/${path}`, text])),
    "plugins/wingmate/.codex-plugin/plugin.json": `${JSON.stringify(CODEX_MANIFEST, null, 2)}\n`,
    ".agents/plugins/marketplace.json": `${JSON.stringify(CODEX_MARKETPLACE, null, 2)}\n`,
  };
}

export function packageInfo(format: PackageFormat = "skill") {
  const content = packageContent(format);
  return {
    format: format === "codex" ? "wingmate-codex-plugin-bundle/v1" : "wingmate-skill-bundle/v1",
    name: "wingmate",
    version: pkg.version,
    entrypoint:
      format === "codex" ? "plugins/wingmate/.codex-plugin/plugin.json" : "skills/wingmate/SKILL.md",
    requires: { wingmate: pkg.version, executionBackend: "orca" },
    capabilities: CAPABILITIES,
    files: Object.entries(content).map(([path, text]) => ({
      path,
      bytes: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text).digest("hex"),
    })),
    distribution:
      format === "codex"
        ? "Local Codex marketplace with an onboarding skill; requires the Wingmate CLI and host setup invocation. Export does not install a host plugin."
        : "Portable skill bundle requiring an installed Wingmate CLI; use package install for installation with guided setup.",
  };
}

/** Only embedded public content is exported. No config, process environment, records or tokens are read. */
export async function exportPackage(destination: string, format: PackageFormat = "skill") {
  const manifest = packageInfo(format);
  const content = packageContent(format);
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
  try {
    for (const [relative, text] of Object.entries(content)) {
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
