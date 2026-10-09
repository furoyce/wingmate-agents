import { exportPackage, packageInfo } from "../../package/bundle";
import type { Argv } from "../index";
import { UsageError, readFlags } from "../ops";
import { stderr, stdout } from "./tick";

const USAGE =
  "usage: wingmate package info [--json] | wingmate package export --out <new-directory> [--json]";

export interface PackageCommandDeps {
  out?: (s: string) => void;
  err?: (s: string) => void;
  export?: typeof exportPackage;
}

export async function packageCommand(argv: Argv, deps: PackageCommandDeps = {}): Promise<number> {
  const out = deps.out ?? stdout;
  const err = deps.err ?? stderr;
  let flags: ReturnType<typeof readFlags>;
  const action = argv.cmd[1];
  try {
    if (argv.cmd.length !== 2 || (action !== "info" && action !== "export")) throw new UsageError(USAGE);
    flags = readFlags(argv, { bool: ["json"], value: ["out"] }, USAGE);
    if ((action === "export") !== flags.value.has("out")) throw new UsageError(USAGE);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(e.usage);
    return 2;
  }
  if (action === "export") {
    const result = await (deps.export ?? exportPackage)(flags.value.get("out") as string);
    out(
      flags.bool.has("json")
        ? JSON.stringify(result, null, 2)
        : `Exported Wingmate ${result.version}: ${result.directory}\nSkill: ${result.entrypoint}\nNo host installation or automation change.`,
    );
  } else {
    const info = packageInfo();
    out(
      flags.bool.has("json")
        ? JSON.stringify(info, null, 2)
        : `Wingmate ${info.version}\nPortable skill and CLI interface; managed execution and scheduling require Orca.\nUse package export --out <new-directory> to create the bundle.`,
    );
  }
  return 0;
}
