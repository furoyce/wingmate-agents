// src/shared/version.ts — the running CLI's version; `bun build --compile` embeds package.json, so the binary knows its own.
import pkg from "../../package.json";

export const VERSION: string = pkg.version;
