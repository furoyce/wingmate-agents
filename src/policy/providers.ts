import { join } from "node:path";
import { readText } from "../state/fs";

export type Coordinator = "claude" | "codex";
export interface TierOverride {
  best?: { claude?: { model: string; effort: string }; codex?: { model: string; effort: string } };
}

// §9.2 tier `best`: the provider CLI's configured flagship, never a hardcoded model id.
export async function resolveTier(
  provider: Coordinator,
  opts: { home?: string; override?: TierOverride } = {},
): Promise<{ model: string; effort: string } | null> {
  const o = opts.override?.best?.[provider];
  if (o) return o;
  const home = opts.home ?? process.env.HOME ?? "/";
  if (provider === "claude") {
    const t = await readText(join(home, ".claude", "settings.json"));
    if (!t) return null;
    let model: unknown;
    try {
      model = (JSON.parse(t) as { model?: unknown }).model;
    } catch {
      return null;
    }
    return typeof model === "string" && model ? { model, effort: "max" } : null;
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
