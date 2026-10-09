// src/config/load.ts — reads config/projects.yaml, validates with Zod, applies defaults.
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { WingmateError } from "../shared/errors";
import { type Config, ConfigSchema, withDefaults } from "./schema";

/** Persisted shell arguments must be absolute literal paths without control characters. Shell metacharacters are quoted. */
export const ConfigPathSchema = z
  .string()
  .min(1)
  .refine(
    (p) =>
      isAbsolute(p) &&
      resolve(p) === p &&
      ![...p].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
    "config path must be an absolute normalized path without control characters",
  );

/** Capture the selected file once in the trusted dispatcher, before cwd or environment can change. */
export async function selectedConfigPath(
  path = process.env.WINGMATE_CONFIG ?? "config/projects.yaml",
  cwd = process.cwd(),
): Promise<string> {
  if (!path || [...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
    throw new WingmateError("config_path_invalid", "config path is empty or contains control characters");
  const absolute = resolve(cwd, path);
  let canonical: string;
  try {
    canonical = await realpath(absolute);
    if (!(await stat(canonical)).isFile()) throw new Error("not a file");
  } catch {
    throw new WingmateError("config_missing", `config file not found: ${absolute}`);
  }
  if (!ConfigPathSchema.safeParse(canonical).success)
    throw new WingmateError("config_path_invalid", "config path contains unsupported characters");
  return canonical;
}
export async function loadConfig(
  path = process.env.WINGMATE_CONFIG ?? "config/projects.yaml",
): Promise<Config> {
  const text = await Bun.file(path)
    .text()
    .catch(() => {
      throw new WingmateError(
        "config_missing",
        `config file not found: ${path}`,
        "create config/projects.yaml (see spec §10)",
      );
    });
  const parsed = ConfigSchema.safeParse(parse(text));
  if (!parsed.success) {
    throw new WingmateError(
      "config_invalid",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      "fix config/projects.yaml",
    );
  }
  return withDefaults(parsed.data);
}
