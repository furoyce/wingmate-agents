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
      const [k, v] = a.slice(2).split("=", 2);
      const next = args[i + 1];
      if (v !== undefined) flags[k as string] = v;
      else if (next !== undefined && !next.startsWith("--")) {
        flags[k as string] = next;
        i++;
      } else flags[k as string] = true;
    } else cmd.push(a);
  }
  return { cmd, flags };
}
type Handler = (argv: Argv) => Promise<number>;
const registry: Record<string, () => Promise<Handler>> = {
  config: async () => (await import("./commands/config")).configCommand,
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
