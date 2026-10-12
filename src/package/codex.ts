import pkg from "../../package.json";

// Documented local plugin/marketplace contracts; no lifecycle hook or host-state edits.
export const CODEX_MANIFEST = {
  name: "wingmate",
  version: pkg.version,
  description: "Guided installation and management of project agents and automations.",
  skills: "./skills/",
  extensions: {
    "com.openai": { onboardingSkill: "./skills/wingmate/SKILL.md" },
  },
} as const;

export const CODEX_MARKETPLACE = {
  name: "wingmate-local",
  plugins: [
    {
      name: "wingmate",
      source: { source: "local", path: "./plugins/wingmate" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    },
  ],
} as const;
