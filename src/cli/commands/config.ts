// src/cli/commands/config.ts — `wingmate config validate|show [--file <path>]`.
import { loadConfig } from "../../config/load";
import type { Argv } from "../index";
export async function configCommand(argv: Argv): Promise<number> {
  const sub = argv.cmd[1];
  if (Array.isArray(argv.flags.file)) {
    process.stderr.write("usage: --file may be given only once\n");
    return 2;
  }
  const cfg = await loadConfig(typeof argv.flags.file === "string" ? argv.flags.file : undefined);
  if (sub === "show") {
    process.stdout.write(`${JSON.stringify(cfg, null, 2)}\n`);
    return 0;
  }
  if (sub === "validate") {
    const lines = Object.values(cfg.projects).flatMap((p) =>
      Object.entries(p.repos).map(
        ([name, r]) => `${p.key}/${name}: ${r.gates.map((g) => g.join(" ")).join(" | ")}`,
      ),
    );
    process.stdout.write(
      `${JSON.stringify({ ok: true, projects: Object.keys(cfg.projects), pinnedGates: lines }, null, 2)}\n`,
    );
    return 0;
  }
  process.stderr.write("usage: wingmate config validate|show [--file <path>]\n");
  return 2;
}
