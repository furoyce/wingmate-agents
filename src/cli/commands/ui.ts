// src/cli/commands/ui.ts — `wingmate ui [--port <port>] [--open [orca|browser]] [--serve]`
import { type Launcher, type WingmateServer, defaultLauncher, startServer } from "../../server";
import { homeDirs } from "../../shared/paths";
import { SystemClock } from "../../shared/time";
import type { Argv } from "../index";
import { stderr, stdout } from "./tick";

const USAGE = "usage: wingmate ui [--port <number>] [--open [orca|browser]] [--serve]";

export interface UiDeps {
  out?: (s: string) => void;
  err?: (s: string) => void;
  start?: typeof startServer;
  openTarget?: (target: "orca" | "browser", url: string) => void | Promise<void>;
  launcher?: Launcher;
}

/**
 * Opens the bare Console URL (no token: the page bootstraps its own session on navigation) and reports only an opener that
 * exited 0; on failure the URL stays usable and the user is told to open it.
 */
export async function openConsole(
  target: "orca" | "browser",
  url: string,
  launch: Launcher,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<boolean> {
  if (target === "orca") {
    const orca = await launch("orca", ["tab", "create", "--url", url]);
    if (orca.code === 0) {
      out(`Opened ${url} in an Orca browser tab`);
      return true;
    }
    // Only fall back when Orca is absent; a failed or timed-out Orca launch may already have opened a tab.
    if (!orca.missing) {
      err(`Orca could not open a tab (${orca.error ?? `exit ${orca.code}`}); open ${url} manually`);
      return false;
    }
    err("Orca CLI not found; trying the system browser");
  }
  const sys = await launch("open", [url]);
  if (sys.code === 0) {
    out(`Opened ${url} in the system browser`);
    return true;
  }
  err(`Could not open the Console (${sys.error ?? `exit ${sys.code}`}); open ${url} manually`);
  return false;
}

export async function uiCommand(argv: Argv, deps: UiDeps = {}): Promise<number> {
  const out = deps.out ?? stdout;
  const err = deps.err ?? stderr;

  if (argv.cmd.length > 1) {
    err(USAGE);
    return 2;
  }

  let port = 4848;
  const portRaw = argv.flags.port;
  if (portRaw !== undefined) {
    if (typeof portRaw !== "string" || !/^\d+$/.test(portRaw)) {
      err(`${USAGE}\n--port must be an integer`);
      return 2;
    }
    port = Number.parseInt(portRaw, 10);
    if (port < 1024 || port > 65535) {
      err(`${USAGE}\n--port must be between 1024 and 65535`);
      return 2;
    }
  }

  let openTarget: "orca" | "browser" | null = null;
  const openRaw = argv.flags.open;
  if (openRaw !== undefined) {
    if (openRaw === true || openRaw === "browser") {
      openTarget = "browser";
    } else if (openRaw === "orca") {
      openTarget = "orca";
    } else {
      err(`${USAGE}\n--open must be "orca" or "browser"`);
      return 2;
    }
  }

  // Check for unknown flags
  const allowed = new Set(["port", "open", "serve"]);
  for (const k of Object.keys(argv.flags)) {
    if (!allowed.has(k)) {
      err(USAGE);
      return 2;
    }
  }

  const start = deps.start ?? startServer;
  let server: WingmateServer;
  try {
    server = await start({
      port,
      dirs: homeDirs(),
      clock: new SystemClock(),
    });
  } catch (e) {
    err(`failed to start Wingmate UI: ${(e as Error).message}`);
    return 1;
  }

  out(`Wingmate Console listening at ${server.url}`);

  if (openTarget) {
    const launch = deps.launcher ?? defaultLauncher;
    const opener =
      deps.openTarget ??
      (async (target, url) => {
        await openConsole(target, url, launch, out, err);
      });
    await opener(openTarget, server.url);
  }

  // If in an automated test environment, exit early if requested
  if (process.env.WINGMATE_TEST_EXIT) {
    server.stop();
    return 0;
  }

  // Keep alive until process termination
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      server.stop();
      resolve();
    });
    process.on("SIGTERM", () => {
      server.stop();
      resolve();
    });
  });

  return 0;
}
