import { join } from "node:path";
export interface Dirs {
  state: string;
  config: string;
  kit: string;
  bin: string;
  records: string;
  archive: string;
  journal: string;
  ledger: string;
  evidence: string;
  logs: string;
}
export function homeDirs(env: Record<string, string | undefined> = process.env): Dirs {
  const home = env.HOME ?? "/";
  const state = env.WINGMATE_HOME ?? join(home, ".local", "share", "wingmate");
  const config = env.WINGMATE_CONFIG_HOME ?? join(home, ".config", "wingmate");
  return {
    state,
    config,
    kit: join(state, "kit"),
    bin: join(state, "bin"),
    records: join(state, "records"),
    archive: join(state, "records", "archive"),
    journal: join(state, "journal"),
    ledger: join(state, "ledger"),
    evidence: join(state, "evidence"),
    logs: join(state, "logs"),
  };
}
