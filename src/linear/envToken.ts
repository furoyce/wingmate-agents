// src/linear/envToken.ts — the owner's personal Linear API key, for read-only contexts only (Task 13; §11.1, §15.1): `scan` and
// `tick --dry-run` can read the live queues as the owner before the Wingmate OAuth app exists. `wire.ts` hands it only to a context
// whose every write refuses (`read_only`), and only while the app's credentials.json is absent. The key is $WINGMATE_LINEAR_TOKEN, else
// <secrets root>/linear-token — accepted only as a regular file of the current user with mode 0600, checked on the open descriptor. It is
// never logged, printed or stored here, and no error names it.
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { WingmateError } from "../shared/errors";
import type { Tokens } from "./auth";

export const TOKEN_ENV = "WINGMATE_LINEAR_TOKEN";
export const TOKEN_FILE = "linear-token";
const SETUP_GUIDE = "docs/linear-app-setup.md";
const MAX_BYTES = 4096;
/** A bearer token stands in an HTTP header: printable ASCII without whitespace, bounded. */
const TokenText = z
  .string()
  .max(MAX_BYTES)
  .regex(/^[\x21-\x7e]+$/);
/** O_NOFOLLOW: a symlink is refused (ELOOP), never followed. O_NONBLOCK: a FIFO planted at the path cannot hang the open. */
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export interface EnvTokenOptions {
  /** Where the variable is read (default: this process's environment). */
  env?: Record<string, string | undefined>;
  /** The user who must own the file (default: `process.getuid()`). */
  uid?: number;
}

const fileMode = (file: string, why: string) =>
  new WingmateError(
    "linear_token_file_mode",
    `${file} ${why}; it must be a regular file owned by you with mode 0600`,
    `chmod 600 ${file} (a regular file you own), or remove it; see ${SETUP_GUIDE}`,
  );

/** `linear_token_invalid`, naming where the value came from — never the value. */
const invalid = (where: string) =>
  new WingmateError(
    "linear_token_invalid",
    `${where} does not hold exactly one token (printable ASCII without spaces, at most ${MAX_BYTES} characters)`,
    `put one Linear API key in ${where}; see ${SETUP_GUIDE}`,
  );

function checked(value: string, where: string): string {
  if (TokenText.safeParse(value).success) return value;
  throw invalid(where);
}

/** The file's text, or null when it does not exist; refused unless it is a regular file of `uid` with mode 0600. */
async function readOwnFile(file: string, uid: number): Promise<string | null> {
  let fh: FileHandle;
  try {
    fh = await open(file, OPEN_FLAGS);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw fileMode(file, code === "ELOOP" ? "is a symlink" : `cannot be opened (${code ?? "unknown error"})`);
  }
  try {
    const st = await fh.stat(); // the descriptor's own metadata: nothing can swap the file between this check and the read
    if (!st.isFile()) throw fileMode(file, "is not a regular file");
    if (st.uid !== uid)
      throw fileMode(file, `is owned by uid ${st.uid}, not by the current user (uid ${uid})`);
    const mode = st.mode & 0o777;
    if (mode !== 0o600) throw fileMode(file, `has mode ${mode.toString(8).padStart(4, "0")}`);
    if (st.size > MAX_BYTES) throw invalid(file);
    return await fh.readFile("utf8");
  } finally {
    await fh.close();
  }
}

export class EnvToken implements Tokens {
  constructor(
    private readonly configDir: string,
    private readonly o: EnvTokenOptions = {},
  ) {}

  async getToken(): Promise<string> {
    const fromEnv = (this.o.env ?? process.env)[TOKEN_ENV]?.trim();
    if (fromEnv) return checked(fromEnv, `$${TOKEN_ENV}`);
    const file = join(this.configDir, TOKEN_FILE);
    const text = await readOwnFile(file, this.o.uid ?? process.getuid?.() ?? -1);
    if (text === null)
      throw new WingmateError(
        "linear_credentials_missing",
        `no Linear token for a read-only command: $${TOKEN_ENV} is not set and ${file} does not exist (writes need the Wingmate OAuth app)`,
        `${SETUP_GUIDE}: install the OAuth app, or for read-only dry runs put a personal API key in ${file} (mode 0600)`,
      );
    return checked(text.trim(), file);
  }

  /** Nothing is cached and a personal key is never re-minted: GraphQL's one retry after a 401 sends the same key, then reports it. */
  async invalidate(): Promise<void> {}

  /** A personal key has no expiry Wingmate can read: null, which `doctor`'s `linear_auth` reports as "no app token". */
  async expiresAt(): Promise<string | null> {
    return null;
  }
}
