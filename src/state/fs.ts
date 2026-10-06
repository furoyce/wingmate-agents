import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

/** Write `text` to `path` atomically: temp file in the same directory, fsync, rename. Honors `mode` for new files. */
export async function writeAtomic(path: string, text: string, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fh = await open(tmp, "w", mode);
  await fh.writeFile(text);
  await fh.sync();
  await fh.close();
  await rename(tmp, path);
}

/** Create `path` with O_EXCL semantics. Returns false when the file already exists. */
export async function createExclusive(path: string, text: string, mode = 0o644): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  try {
    const fh = await open(path, "wx", mode);
    await fh.writeFile(text);
    await fh.close();
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

/** Read a UTF-8 file, or null when it does not exist. Other errors propagate. */
export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
