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
