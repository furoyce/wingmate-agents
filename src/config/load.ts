// src/config/load.ts — reads config/projects.yaml, validates with Zod, applies defaults.
import { parse } from "yaml";
import { WingmateError } from "../shared/errors";
import { type Config, ConfigSchema, withDefaults } from "./schema";
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
