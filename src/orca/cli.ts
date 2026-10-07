// src/orca/cli.ts — run one `orca … --json` command and unwrap its envelope `{ id, ok, result | error, _meta }`.
import { z } from "zod";
import { run } from "../shared/exec";

export class OrcaError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly envelope: unknown = null,
  ) {
    super(message);
    this.name = "OrcaError";
  }
}

export interface OrcaOptions {
  bin?: string;
  timeoutMs?: number;
  cwd?: string;
}

const DEFAULT_BIN = process.env.WINGMATE_ORCA_BIN ?? "/usr/local/bin/orca";
const DEFAULT_TIMEOUT_MS = 60_000;

const EnvelopeZ = z
  .object({
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.object({ code: z.string().optional(), message: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

const label = (args: string[]) => `orca ${args.slice(0, 2).join(" ")}`;

/** Returns `result` of an ok envelope; throws `OrcaError` with the envelope's error code, `orca_timeout`, or `orca_unreachable` (no envelope at all). */
export async function orca(args: string[], opts: OrcaOptions = {}): Promise<unknown> {
  const r = await run([opts.bin ?? DEFAULT_BIN, ...args, "--json"], {
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });
  if (r.timedOut)
    throw new OrcaError(
      "orca_timeout",
      `${label(args)} timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`,
    );
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    parsed = null;
  }
  const env = EnvelopeZ.safeParse(parsed);
  if (!env.success) {
    throw new OrcaError(
      "orca_unreachable",
      `${label(args)} returned no envelope (exit ${r.code}): ${r.stderr.trim().slice(0, 200)}`,
    );
  }
  if (!env.data.ok)
    throw new OrcaError(
      env.data.error?.code ?? "orca_error",
      env.data.error?.message ?? "orca error",
      env.data,
    );
  return env.data.result;
}
