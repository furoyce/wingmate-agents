// tests/unit/linear/envToken.test.ts — the owner's personal Linear key for read-only contexts (Task 13): $WINGMATE_LINEAR_TOKEN, else
// <config dir>/linear-token, accepted only as a regular file of the current user with mode 0600. Temp config dirs only; nothing is
// ever written there by EnvToken, and no error names the key.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvToken } from "../../../src/linear/envToken";
import { WingmateError } from "../../../src/shared/errors";

const KEY = "lin_api_SECRETVALUE0123456789";
let dir: string;
let file: string;
const uid = process.getuid?.() ?? 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wm-envtoken-"));
  file = join(dir, "linear-token");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeKey(text: string, mode = 0o600): void {
  rmSync(file, { force: true }); // a 0400 file from an earlier case cannot be rewritten in place
  writeFileSync(file, text, { mode });
  chmodSync(file, mode);
}

/** The refusal `p` rejects with; the key never appears in its message or next step. */
async function refusal(p: Promise<unknown>): Promise<WingmateError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  if (!(e instanceof WingmateError)) throw new Error(`expected a WingmateError, got ${String(e)}`);
  expect(e.message).not.toContain(KEY);
  expect(e.nextStep ?? "").not.toContain(KEY);
  return e;
}

describe("EnvToken", () => {
  test("returns $WINGMATE_LINEAR_TOKEN (trimmed); invalidate() is a no-op and nothing is written to the config dir", async () => {
    const t = new EnvToken(dir, { env: { WINGMATE_LINEAR_TOKEN: ` ${KEY}\n` }, uid });
    expect(await t.getToken()).toBe(KEY);
    await t.invalidate();
    expect(await t.getToken()).toBe(KEY);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("the variable wins over the file; an empty or blank variable counts as unset", async () => {
    writeKey("lin_api_from_file\n");
    expect(await new EnvToken(dir, { env: { WINGMATE_LINEAR_TOKEN: KEY }, uid }).getToken()).toBe(KEY);
    for (const blank of ["", "   ", "\n"])
      expect(await new EnvToken(dir, { env: { WINGMATE_LINEAR_TOKEN: blank }, uid }).getToken()).toBe(
        "lin_api_from_file",
      );
  });

  test("without the variable: <config dir>/linear-token, a 0600 regular file of the current user (one trailing newline is fine)", async () => {
    writeKey(`${KEY}\n`);
    const t = new EnvToken(dir, { env: {}, uid });
    expect(await t.getToken()).toBe(KEY);
    await t.invalidate();
    expect(await t.getToken()).toBe(KEY);
    expect(readdirSync(dir)).toEqual(["linear-token"]);
  });

  test("refuses linear_token_file_mode unless the mode is exactly 0600", async () => {
    for (const mode of [0o644, 0o640, 0o604, 0o660, 0o700, 0o400, 0o666]) {
      writeKey(KEY, mode);
      const e = await refusal(new EnvToken(dir, { env: {}, uid }).getToken());
      expect(e.code).toBe("linear_token_file_mode");
      expect(e.message).toContain(file);
      expect(e.message).toContain(`0${mode.toString(8)}`);
      expect(e.nextStep).toContain("chmod 600");
    }
  });

  test("refuses linear_token_file_mode when the file belongs to another user", async () => {
    writeKey(KEY);
    const e = await refusal(new EnvToken(dir, { env: {}, uid: uid + 1 }).getToken());
    expect(e.code).toBe("linear_token_file_mode");
    expect(e.message).toContain("owned by");
  });

  test("refuses linear_token_file_mode for a symlink (even to a 0600 file of the current user), a directory or a FIFO — never hangs", async () => {
    const real = join(dir, "real-token");
    writeFileSync(real, KEY, { mode: 0o600 });
    chmodSync(real, 0o600);
    symlinkSync(real, file);
    const viaLink = await refusal(new EnvToken(dir, { env: {}, uid }).getToken());
    expect(viaLink.code).toBe("linear_token_file_mode");
    expect(viaLink.message).toContain("symlink");
    rmSync(file);
    mkdirSync(file, { mode: 0o700 });
    expect((await refusal(new EnvToken(dir, { env: {}, uid }).getToken())).code).toBe(
      "linear_token_file_mode",
    );
    rmSync(file, { recursive: true });
    expect(Bun.spawnSync(["mkfifo", "-m", "600", file]).exitCode).toBe(0);
    const fifo = await refusal(new EnvToken(dir, { env: {}, uid }).getToken());
    expect(fifo.code).toBe("linear_token_file_mode");
    expect(fifo.message).toContain("not a regular file");
  });

  test("neither the variable nor the file: linear_credentials_missing naming both, with docs/linear-app-setup.md as the next step", async () => {
    const e = await refusal(new EnvToken(join(dir, "absent-config"), { env: {}, uid }).getToken());
    expect(e.code).toBe("linear_credentials_missing");
    expect(e.message).toContain("WINGMATE_LINEAR_TOKEN");
    expect(e.message).toContain(join(dir, "absent-config", "linear-token"));
    expect(e.nextStep).toContain("docs/linear-app-setup.md");
  });

  test("a value that is not one header-safe token is linear_token_invalid, and the value is never echoed", async () => {
    for (const bad of [`${KEY} extra`, `${KEY}\nX-Injected: 1`, `${KEY}\u0000`, "lin_api_é"]) {
      const e = await refusal(new EnvToken(dir, { env: { WINGMATE_LINEAR_TOKEN: bad }, uid }).getToken());
      expect(e.code).toBe("linear_token_invalid");
      expect(e.message).toContain("WINGMATE_LINEAR_TOKEN");
    }
    for (const text of ["", "\n", `${KEY}\n${KEY}\n`, "x".repeat(5000)]) {
      writeKey(text);
      const e = await refusal(new EnvToken(dir, { env: {}, uid }).getToken());
      expect(e.code).toBe("linear_token_invalid");
      expect(e.message).toContain(file);
    }
  });

  test("a personal key has no expiry Wingmate can read: expiresAt() is null", async () => {
    expect(await new EnvToken(dir, { env: { WINGMATE_LINEAR_TOKEN: KEY }, uid }).expiresAt()).toBeNull();
  });
});
