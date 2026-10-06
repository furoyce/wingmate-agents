import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { homeDirs } from "./paths";
let cached: pino.Logger | null = null;
export function logger(): pino.Logger {
  if (cached) return cached;
  const dirs = homeDirs();
  mkdirSync(dirs.logs, { recursive: true });
  const dest = pino.destination({ dest: join(dirs.logs, "wingmate.log"), sync: false, mkdir: true });
  cached = pino(
    {
      level: process.env.WINGMATE_LOG_LEVEL ?? "info",
      base: { pid: process.pid },
      redact: { paths: ["*.token", "*.secret", "*.clientSecret", "*.accessToken"], censor: "[redacted]" },
    },
    dest,
  );
  return cached;
}
