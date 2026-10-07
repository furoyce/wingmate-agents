export class WingmateError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly nextStep?: string,
  ) {
    super(message);
    this.name = "WingmateError";
  }
  toJSON() {
    return { code: this.code, message: this.message, nextStep: this.nextStep ?? null };
  }
}
export const isWingmateError = (e: unknown): e is WingmateError => e instanceof WingmateError;

const CODE = /^[a-z][a-z0-9_]*$/;
/** An enumerable code for summaries and the ledger: a WingmateError's or OrcaError's own code, else `internal_error`. */
export function errorCode(e: unknown): string {
  const code = e && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
  return typeof code === "string" && CODE.test(code) ? code : "internal_error";
}
/** `name: message`, bounded, for logs and the local ledger (never for tick stdout). */
export const errorText = (e: unknown): string =>
  (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 500);
