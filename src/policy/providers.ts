import { join } from "node:path";
import { readText } from "../state/fs";

export type Coordinator = "claude" | "codex";
export interface TierOverride {
  best?: { claude?: { model: string; effort: string }; codex?: { model: string; effort: string } };
}
/** §9.2 tier `best`: a model id and effort. R31: `model` null is the Claude CLI's own default (the argv carries no `--model`). */
export interface Tier {
  model: string | null;
  effort: string;
}
/** R31: how a launch on the CLI's own default model is shown (status comment, brief, `wingmate status`, doctor). */
export const CLI_DEFAULT = "CLI default";
/** R31: the model a launch is shown with — its id, `CLI default` once resolved without one, null before it is resolved (no effort). */
export const modelLabel = (l: { model: string | null; effort: string | null }): string | null =>
  l.model ?? (l.effort ? CLI_DEFAULT : null);

// §9.2 tier `best`: the provider CLI's configured flagship, never a hardcoded model id.
export async function resolveTier(
  provider: Coordinator,
  opts: { home?: string; override?: TierOverride } = {},
): Promise<Tier | null> {
  const o = opts.override?.best?.[provider];
  if (o) return o;
  const home = opts.home ?? process.env.HOME ?? "/";
  if (provider === "claude") {
    // R31: Claude Code keeps per-model settings under `modelSettings`, so settings.json may carry no top-level `model` (or not exist):
    // then the CLI runs its own default model — still at max effort, never a hardcoded id. A file that does not parse as an object
    // says nothing about the model the owner set: model_unresolved.
    const t = await readText(join(home, ".claude", "settings.json"));
    if (t === null) return { model: null, effort: "max" };
    let raw: unknown;
    try {
      raw = JSON.parse(t);
    } catch {
      return null;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const model = (raw as { model?: unknown }).model;
    return { model: typeof model === "string" && model ? model : null, effort: "max" };
  }
  const t = await readText(join(home, ".codex", "config.toml"));
  if (!t) return null;
  const model = /^\s*model\s*=\s*"([^"]+)"/m.exec(t)?.[1];
  const effort = /^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(t)?.[1] ?? "xhigh";
  return model ? { model, effort } : null;
}

export const nextInCascade = (
  cascade: Coordinator[],
  tried: Coordinator[],
  isAvailable: (p: Coordinator) => boolean,
): Coordinator | null => cascade.find((p) => !tried.includes(p) && isAvailable(p)) ?? null;
