// src/config/schema.ts — Zod schema for config/projects.yaml (spec §10.1) and the defaults merge.
import { z } from "zod";
import {
  NATIVE_ADMISSION_HEADROOM_MS,
  NATIVE_CLEANUP_RESERVE_MS,
  NATIVE_DELIVERY_RESERVE_MS,
  NativePolicySchema,
} from "../native/protocol";
import { WingmateError } from "../shared/errors";
const Argv = z.array(z.string().min(1)).min(1);
// Legacy single argv stays accepted; execution always receives an explicit sequence, never shell text.
const Setup = z
  .union([z.literal("none"), Argv, z.array(Argv).min(1)])
  .default("none")
  .transform((setup): "none" | string[][] => {
    if (setup === "none") return setup;
    return typeof setup[0] === "string" ? [setup as string[]] : (setup as string[][]);
  });
const Provider = z.enum(["claude", "codex", "cursor", "antigravity"]);
export const RepoSchema = z.object({
  orcaRepo: z.string().uuid(),
  github: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  base: z.string().default("origin/main"),
  setup: Setup,
  gates: z.array(Argv).min(1, "gates must be a non-empty list of argv arrays"),
  requiredCheck: z.string().default("none"),
  ui: z
    .object({
      kind: z.enum(["web", "ios", "none"]),
      paths: z.array(z.string()).default([]),
      dev: Argv.optional(),
      url: z.string().default(""),
      smokeRoutes: z.array(z.string()).default([]),
      native: NativePolicySchema.optional(),
    })
    .default({ kind: "none" }),
  packageRoots: z.array(z.string()).default(["."]),
  allowedBuildScripts: z.array(z.string()).default([]),
  forbiddenPaths: z.array(z.string()).default([]),
  sandbox: z.object({ allowedDomains: z.array(z.string()).default([]) }).default({}),
});
const MaxWorking = z.object({
  global: z.number().int().default(3),
  perProject: z.number().int().default(1),
  perProvider: z.number().int().default(2),
});
const Concurrency = z.object({
  maxWorking: MaxWorking.default({}),
  maxInFlight: z.number().int().default(6),
  maxLiveWorktrees: z.number().int().default(8),
});
const Timers = z.object({
  intakeMin: z.number().default(20),
  planMin: z.number().default(45),
  planVerifyMin: z.number().default(30),
  implementMin: z.number().default(180),
  validateMin: z.number().default(60),
  uiMin: z.number().default(90),
  securityMin: z.number().default(30),
  prMin: z.number().default(20),
  graceMin: z.number().default(30),
  idleNudgeMin: z.number().default(10),
});
const Budgets = z.object({
  softTokens: z.number().nullable().default(null),
  hardTokens: z.number().nullable().default(null),
});
export const DefaultsSchema = z.object({
  timezone: z.string().min(1),
  sandbox: z.object({ allowedDomains: z.array(z.string()).default([]) }).default({}),
  providers: z
    .object({
      default: Provider.default("claude"),
      // D14 extension (spike 2026-10-06 §3.5): Codex sandboxes do not block reads outside the worktree, so the
      // safe default is a Claude-only coordinator cascade; a config may widen it once the owner accepts the extension.
      coordinatorCascade: z.array(z.enum(["claude", "codex"])).default(["claude"]),
      workers: z.array(Provider).default(["claude", "codex", "cursor", "antigravity"]),
      verifyCross: z.boolean().default(true),
    })
    .default({}),
  autonomy: z.enum(["ask-first", "balanced", "autonomous"]).default("ask-first"),
  done: z.enum(["review", "merge", "deploy"]).default("review"),
  concurrency: Concurrency.default({}),
  quota: z
    .object({
      weeklyMax: z.number().default(80),
      sessionMax: z.number().default(90),
      maxSnapshotAgeMin: z.number().default(360),
    })
    .default({}),
  timers: Timers.default({}),
  budgets: Budgets.default({}),
  cleanup: z.object({ worktreeGraceHours: z.number().default(24) }).default({}),
  dispatcher: z
    .object({
      provider: z.enum(["claude", "codex"]).default("codex"),
      precheckTimeoutSec: z.number().default(240),
      missedRunGraceMinutes: z.number().default(10),
      claimsPerTick: z.number().default(2),
      resumesPerTick: z.number().default(3),
    })
    .default({}),
  forbiddenPaths: z
    .array(z.string())
    .default([
      ".github/**",
      ".claude/**",
      ".wingmate/**",
      ".mcp.json",
      ".codex/**",
      ".cursor/**",
      ".gemini/**",
      ".vscode/**",
      ".idea/**",
      ".husky/**",
      "lefthook.yml",
      "CLAUDE.md",
      "AGENTS.md",
      "GEMINI.md",
      "**/.env*",
      ".npmrc",
      "pnpm-workspace.yaml",
      ".pnpmfile.cjs",
      "bunfig.toml",
      "turbo.json",
      "vercel.json",
      "Dockerfile*",
      "infra/**",
      "terraform/**",
      "supabase/migrations/**",
      "db/migrations/**",
      "CODEOWNERS",
      "scripts/agent-*/**",
    ]),
});
export const ProjectSchema = z.object({
  linearProject: z.string().uuid(),
  repos: z.record(RepoSchema).refine((r) => Object.keys(r).length > 0, "at least one repo"),
  routing: z.object({
    default: z.string(),
    rules: z.array(z.object({ match: z.array(z.string()).min(1), repo: z.string() })).default([]),
  }),
  conventions: z.array(z.string()).default([]),
  coexist: z
    .object({
      prReview: z.enum(["existing-orca-automation", "none"]).default("none"),
      githubIssues: z.enum(["leave-to-agent-fix", "none"]).default("none"),
    })
    .default({}),
  autonomy: z.enum(["ask-first", "balanced", "autonomous"]).optional(),
  done: z.enum(["review", "merge", "deploy"]).optional(),
  budgets: Budgets.partial().optional(),
  concurrency: z
    .object({
      maxWorking: MaxWorking.partial().optional(),
      maxInFlight: z.number().int().optional(),
      maxLiveWorktrees: z.number().int().optional(),
    })
    .optional(),
  timers: Timers.partial().optional(),
  tiers: z
    .object({
      standard: z
        .object({
          claude: z.object({ model: z.string() }).optional(),
          codex: z.object({ model: z.string() }).optional(),
        })
        .optional(),
    })
    .optional(),
});
export const ConfigSchema = z.object({
  workspace: z.object({
    linearWorkspace: z.string().uuid(),
    team: z.string().min(1),
    owner: z.string().uuid(),
    approvers: z.array(z.string().uuid()).min(1),
  }),
  labels: z.object({
    agentGroup: z.string(),
    lifecycleGroup: z.string(),
    agent: z.object({
      supported: z.array(z.string()).min(1),
      human: z.string(),
      unsupported: z.array(z.string()).default([]),
    }),
    lifecycle: z.array(z.string()).min(1),
    allowDeps: z.string().default("allow-deps"),
  }),
  defaults: DefaultsSchema,
  projects: z.record(ProjectSchema).refine((p) => Object.keys(p).length > 0, "at least one project"),
});
export type RawConfig = z.infer<typeof ConfigSchema>;
export type RepoConfig = z.infer<typeof RepoSchema>;
export interface ProjectConfig
  extends Omit<z.infer<typeof ProjectSchema>, "autonomy" | "done" | "budgets" | "concurrency" | "timers"> {
  key: string;
  autonomy: "ask-first" | "balanced" | "autonomous";
  done: "review" | "merge" | "deploy";
  budgets: z.infer<typeof Budgets>;
  concurrency: z.infer<typeof Concurrency>;
  timers: z.infer<typeof Timers>;
  forbiddenPaths: string[];
}
export interface Config extends Omit<RawConfig, "projects"> {
  projects: Record<string, ProjectConfig>;
}
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
/** Recursively overlays `over` on `base`; `undefined` values in `over` never erase a default. */
const deepMerge = <T extends object>(base: T, over: object | undefined): T => {
  if (!over) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    const b = out[k];
    out[k] = isPlainObject(v) && isPlainObject(b) ? deepMerge(b, v) : v;
  }
  return out as T;
};
/** Resolves every project against `defaults` and checks routing targets exist (spec §10.1, §10.3). */
export function withDefaults(raw: RawConfig): Config {
  const projects: Record<string, ProjectConfig> = {};
  for (const [key, p] of Object.entries(raw.projects)) {
    // Match tickBudgetMs's 60-second precheck margin; reject configurations that could defer native requests forever.
    const tickBudget = Math.max(30, raw.defaults.dispatcher.precheckTimeoutSec - 60) * 1000;
    for (const [name, repo] of Object.entries(p.repos)) {
      if (
        repo.ui.native &&
        repo.ui.native.timeoutMs +
          NATIVE_CLEANUP_RESERVE_MS +
          NATIVE_DELIVERY_RESERVE_MS +
          NATIVE_ADMISSION_HEADROOM_MS >
          tickBudget
      )
        throw new WingmateError(
          "config_invalid",
          `projects.${key}.repos.${name}.ui.native.timeoutMs cannot fit this dispatcher's tick budget with admission, cleanup and delivery reserves`,
          "reduce native timeoutMs or increase defaults.dispatcher.precheckTimeoutSec",
        );
    }
    if (!p.repos[p.routing.default]) {
      throw new WingmateError(
        "config_invalid",
        `projects.${key}.routing.default "${p.routing.default}" is not a repo of that project`,
        "fix config/projects.yaml",
      );
    }
    for (const rule of p.routing.rules) {
      if (!p.repos[rule.repo])
        throw new WingmateError(
          "config_invalid",
          `projects.${key}.routing.rules → "${rule.repo}" is not a repo of that project`,
          "fix config/projects.yaml",
        );
    }
    const { autonomy, done, budgets, concurrency, timers, ...rest } = p;
    projects[key] = {
      ...rest,
      key,
      autonomy: autonomy ?? raw.defaults.autonomy,
      done: done ?? raw.defaults.done,
      budgets: deepMerge(raw.defaults.budgets, budgets),
      concurrency: deepMerge(raw.defaults.concurrency, concurrency),
      timers: deepMerge(raw.defaults.timers, timers),
      forbiddenPaths: [...raw.defaults.forbiddenPaths],
    };
  }
  return { ...raw, projects };
}
export const projectFor = (cfg: Config, linearProjectId: string): ProjectConfig | undefined =>
  Object.values(cfg.projects).find((p) => p.linearProject === linearProjectId);
export const repoFor = (project: ProjectConfig, name: string): RepoConfig => {
  const r = project.repos[name];
  if (!r) throw new Error(`repo ${name} not in project ${project.key}`);
  return r;
};
