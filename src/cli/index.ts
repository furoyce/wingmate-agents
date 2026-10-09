// src/cli/index.ts — hand-rolled argv parsing and command dispatch (Appendix A of the spec).
import { WingmateError, errorCode, errorText } from "../shared/errors";
/** A flag given once is its value (or `true` without one); given again, its values accumulate in order (`--repo a --repo b`). */
export type FlagValue = string | boolean | string[];
export interface Argv {
  cmd: string[];
  flags: Record<string, FlagValue>;
}
/** Repeated values accumulate. Mixing valued and valueless forms is a sticky `false` sentinel, refused before dispatch. */
function addFlag(flags: Record<string, FlagValue>, k: string, v: string | true): void {
  const cur = flags[k];
  if (cur === undefined) flags[k] = v;
  else if (cur === false) return;
  else if (typeof cur === "boolean" || v === true) flags[k] = cur === true && v === true;
  else flags[k] = [...(Array.isArray(cur) ? cur : [cur]), v];
}
export function parseArgv(args: string[]): Argv {
  const cmd: string[] = [];
  // C7: no prototype, so `--constructor`, `--__proto__` or `--hasOwnProperty` are ordinary flags, never inherited members
  const flags: Record<string, FlagValue> = Object.create(null);
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a.startsWith("--")) {
      const body = a.slice(2);
      const eq = body.indexOf("=");
      const k = eq >= 0 ? body.slice(0, eq) : body;
      const v = eq >= 0 ? body.slice(eq + 1) : undefined; // everything after the first '=' (values may contain '=')
      const next = args[i + 1];
      if (v !== undefined) addFlag(flags, k, v);
      else if (next !== undefined && !next.startsWith("--")) {
        addFlag(flags, k, next);
        i++;
      } else addFlag(flags, k, true);
    } else cmd.push(a);
  }
  return { cmd, flags };
}
type Handler = (argv: Argv) => Promise<number>;
const registry: Record<string, () => Promise<Handler>> = {
  config: async () => (await import("./commands/config")).configCommand,
  issue: async () => (await import("./commands/issue")).issueCommand,
  tick: async () => (await import("./commands/tick")).tickCommand,
  scan: async () => (await import("./commands/scan")).scanCommand,
  install: async () => (await import("./commands/install")).installCommand,
  doctor: async () => (await import("./commands/doctor")).doctorCommand,
  stop: async () => (await import("./commands/stop")).stopCommand,
  pause: async () => (await import("./commands/pause")).pauseCommand,
  // `resume` is `pause --off` (Appendix A): the same command, which reads its own name
  resume: async () => (await import("./commands/pause")).pauseCommand,
  status: async () => (await import("./commands/status")).statusCommand,
  ui: async () => (await import("./commands/ui")).uiCommand,
};
export interface MainDeps {
  handlers?: Record<string, () => Promise<Handler>>;
  out?: (text: string) => void;
  err?: (text: string) => void;
}
const USAGE = `usage: wingmate <${Object.keys(registry).join("|")}> …\n`;
const HELP = `${USAGE}\nwingmate tick [--precheck] [--dry-run] [--json]\nwingmate scan [--dry-run] [--json]\nwingmate issue <identifier> <verb> …\n`;

/** Every error a command lets escape: `code: message` on stderr (never a stack trace, never stdout), exit 2. */
export function reportError(
  e: unknown,
  write: (s: string) => void = (s) => {
    process.stderr.write(s);
  },
): number {
  if (e instanceof WingmateError)
    write(`${e.code}: ${e.message}${e.nextStep ? `\n  next: ${e.nextStep}` : ""}\n`);
  else {
    const code = errorCode(e);
    write(
      `${code}: ${code === "internal_error" ? errorText(e) : e instanceof Error ? e.message : String(e)}\n`,
    );
  }
  return 2;
}

export async function main(args: string[], deps: MainDeps = {}): Promise<number> {
  const out = deps.out ?? ((text: string) => process.stdout.write(text));
  const err = deps.err ?? ((text: string) => process.stderr.write(text));
  // Inspect raw tokens before parsing: help must never import a command or construct a credentialed context.
  // End-of-options syntax is unsupported; refuse it instead of guessing whether a later token is actionable.
  if (args.includes("--") || args.some((arg) => arg.startsWith("--help="))) {
    err(USAGE);
    return 2;
  }
  if (args.includes("--help")) {
    out(HELP);
    return 0;
  }
  const argv = parseArgv(args);
  if (Object.values(argv.flags).includes(false)) {
    err(USAGE);
    return 2;
  }
  const top = argv.cmd[0];
  const handlers = deps.handlers ?? registry;
  const load = top && Object.hasOwn(handlers, top) ? handlers[top] : undefined;
  if (!load) {
    err(USAGE);
    return 2;
  }
  try {
    return await (await load())(argv);
  } catch (e) {
    return reportError(e, err);
  }
}
