// src/cli/ops.ts — what the operator commands (install, doctor, stop, pause, status) share: the context they build, the live doctor
// options, and strict flag parsing (a flag given twice, or a valued flag given without a value, is a usage error, never a guess).
import type { Ctx } from "../machine/context";
import type { DoctorOptions } from "../ops/doctor";
import type { GraphQLLike } from "../ops/views";
import { VERSION } from "../shared/version";
import type { Argv } from "./index";
import { type RealCtxOptions, buildRealCtx } from "./wire";

/** A Ctx plus the live extras: the app token store (doctor's `linear_auth`, `--rotate`) and the app's GraphQL client (views). */
export type OpsCtx = Ctx & {
  tokens?: { getToken(): Promise<string>; expiresAt(): Promise<string | null>; invalidate(): Promise<void> };
  graphql?: GraphQLLike;
  linearDown?: string | null;
};
export interface OpsDeps {
  build?: (o: RealCtxOptions) => Promise<OpsCtx>;
  out?: (line: string) => void;
  err?: (line: string) => void;
}
export const buildOps = (deps: OpsDeps, o: RealCtxOptions): Promise<OpsCtx> =>
  (deps.build ?? buildRealCtx)(o);

export class UsageError extends Error {
  constructor(readonly usage: string) {
    super(usage);
    this.name = "UsageError";
  }
}

/** Only these flags; each at most once; a boolean flag never carries a value and a valued flag always does. */
export function readFlags(
  argv: Argv,
  spec: { bool?: readonly string[]; value?: readonly string[] },
  usage: string,
): { bool: Set<string>; value: Map<string, string> } {
  const bool = new Set<string>();
  const value = new Map<string, string>();
  for (const [k, v] of Object.entries(argv.flags)) {
    if (spec.bool?.includes(k)) {
      if (v !== true) throw new UsageError(usage);
      bool.add(k);
    } else if (spec.value?.includes(k)) {
      if (typeof v !== "string" || v === "") throw new UsageError(usage);
      value.set(k, v);
    } else throw new UsageError(usage);
  }
  return { bool, value };
}

/** The doctor a live command runs: probes on, this CLI's version, the app token minted when fewer than 24 h remain (§11.1). */
export function liveDoctorOptions(ctx: OpsCtx, over: Partial<DoctorOptions> = {}): DoctorOptions {
  const tokens = ctx.tokens;
  return {
    probes: true,
    version: VERSION,
    cwd: process.cwd(),
    ...(tokens
      ? {
          tokenExpiresAt: async () => {
            await tokens.getToken();
            return tokens.expiresAt();
          },
        }
      : {}),
    ...over,
  };
}
