import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { homeDirs } from "./paths";
let cached: pino.Logger | null = null;
export function logger(logDir?: string, sync?: boolean): pino.Logger {
  if (cached && logDir === undefined) return cached;
  const dirs = homeDirs();
  const resolvedLogDir = logDir ?? dirs.logs;
  mkdirSync(resolvedLogDir, { recursive: true });
  const dest = pino.destination({
    dest: join(resolvedLogDir, "wingmate.log"),
    sync: sync ?? false,
    mkdir: true,
  });
  const log = pino(
    {
      level: process.env.WINGMATE_LOG_LEVEL ?? "info",
      base: { pid: process.pid },
      redact: {
        paths: [
          "token",
          "secret",
          "accessToken",
          "clientSecret",
          "password",
          "authorization",
          "*.token",
          "*.secret",
          "*.accessToken",
          "*.clientSecret",
          "*.password",
          "*.authorization",
          "*.*.token",
          "*.*.secret",
          "*.*.accessToken",
          "*.*.clientSecret",
          "*.*.password",
          "*.*.authorization",
        ],
        censor: "[redacted]",
      },
    },
    dest,
  );
  if (logDir === undefined) cached = log;
  return log;
}
