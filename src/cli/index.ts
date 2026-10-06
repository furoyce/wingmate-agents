// src/cli/index.ts — hand-rolled argv parsing and command dispatch (Appendix A of the spec).
import { WingmateError } from "../shared/errors";
export interface Argv {
  cmd: string[];
  flags: Record<string, string | boolean>;
}
export function parseArgv(args: string[]): Argv {
  const cmd: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a.startsWith("--")) {
      const body = a.slice(2);
      const eq = body.indexOf("=");
      const k = eq >= 0 ? body.slice(0, eq) : body;
      const v = eq >= 0 ? body.slice(eq + 1) : undefined; // everything after the first '=' (values may contain '=')
      const next = args[i + 1];
      if (v !== undefined) flags[k] = v;
      else if (next !== undefined && !next.startsWith("--")) {
        flags[k] = next;
        i++;
      } else flags[k] = true;
    } else cmd.push(a);
  }
  return { cmd, flags };
}
type Handler = (argv: Argv) => Promise<number>;
const registry: Record<string, () => Promise<Handler>> = {
  config: async () => (await import("./commands/config")).configCommand,
  issue: async () => (await import("./commands/issue")).issueCommand,
};
export async function main(args: string[]): Promise<number> {
  const argv = parseArgv(args);
  const top = argv.cmd[0];
  const load = top ? registry[top] : undefined;
  if (!load) {
    process.stderr.write(`usage: wingmate <${Object.keys(registry).join("|")}> …\n`);
    return 2;
  }
  try {
    return await (await load())(argv);
  } catch (e) {
    if (e instanceof WingmateError) {
      process.stderr.write(`${e.code}: ${e.message}${e.nextStep ? `\n  next: ${e.nextStep}` : ""}\n`);
      return 2;
    }
    throw e;
  }
}
