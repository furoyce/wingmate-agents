// Protected artifact admission. There is deliberately no agent-facing or manual 'attest' shortcut.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { join } from "node:path";
import { readNoFollow } from "../kit/local";
import { WingmateError } from "../shared/errors";
import type { Dirs } from "../shared/paths";
import { ArtifactReceiptSchema, type NativePolicy, policyHash } from "./protocol";

export const artifactDir = (dirs: Dirs, repoId: string, head: string, policy: NativePolicy) =>
  join(dirs.state, "native-artifacts", repoId, head, policyHash(policy));
const invalid = () =>
  new WingmateError(
    "native_artifact_unverified",
    "no verified isolated-build artifact for this source HEAD and native policy; a trusted build producer must supply it before native UI can run",
  );

/** Content, names and executable bits; no links/special files. At most 20k total entries, 32 levels and 1 GiB. */
export async function appDigest(app: string, checkpoint: () => void = () => undefined): Promise<string> {
  const h = createHash("sha256");
  let entries = 1;
  let files = 0;
  let total = 0;
  const walk = async (path: string, rel: string, depth: number): Promise<void> => {
    checkpoint();
    if (depth > 32) throw invalid();
    const s = await lstat(path);
    checkpoint();
    if (s.isSymbolicLink()) throw invalid();
    if (s.isDirectory()) {
      h.update(`directory\0${rel}\0`);
      const names: string[] = [];
      const dir = await opendir(path);
      // Streaming enumeration stops at the entry limit, including empty directories; readdir could allocate an unbounded list.
      for await (const entry of dir) {
        checkpoint();
        if (++entries > 20_000) throw invalid();
        names.push(entry.name);
      }
      checkpoint();
      for (const name of names.sort()) await walk(join(path, name), `${rel}/${name}`, depth + 1);
      return;
    }
    total += s.size;
    if (!s.isFile() || total > 1024 * 1024 * 1024) throw invalid();
    files++;
    h.update(`file\0${rel}\0${s.mode & 0o111}\0${s.size}\0`);
    checkpoint();
    const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      checkpoint();
      const current = await f.stat();
      checkpoint();
      if (!current.isFile() || current.size !== s.size) throw invalid();
      const buf = Buffer.alloc(64 * 1024);
      let bytes = 0;
      while (true) {
        checkpoint();
        const n = (await f.read(buf)).bytesRead;
        checkpoint();
        if (!n) break;
        bytes += n;
        if (bytes > s.size) throw invalid();
        h.update(buf.subarray(0, n));
      }
      if (bytes !== s.size) throw invalid();
    } finally {
      await f.close();
    }
  };
  checkpoint();
  if (!(await lstat(app)).isDirectory()) throw invalid();
  await walk(app, "app", 0);
  if (!files) throw invalid();
  checkpoint();
  return h.digest("hex");
}

export async function verifiedArtifact(
  dirs: Dirs,
  repoId: string,
  head: string,
  policy: NativePolicy,
  now: string,
  checkpoint: () => void = () => undefined,
) {
  const dir = artifactDir(dirs, repoId, head, policy);
  let checkpointFailed = false;
  const check = () => {
    try {
      checkpoint();
    } catch (e) {
      checkpointFailed = true;
      throw e;
    }
  };
  try {
    // Neither app nor receipt paths are supplied by the requester. Reject links at every protected descendant too.
    let at = dirs.state;
    for (const segment of ["native-artifacts", repoId, head, policyHash(policy)]) {
      check();
      at = join(at, segment);
      if (!(await lstat(at)).isDirectory()) throw invalid();
    }
    check();
    const bytes = await readNoFollow(join(dir, "receipt.json"), 16_385);
    check();
    if (bytes.length > 16_384) throw invalid();
    const receipt = ArtifactReceiptSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (
      receipt.producer !== policy.producer ||
      receipt.isolationHash !== policy.isolationHash ||
      receipt.sourceHead !== head ||
      receipt.policyHash !== policyHash(policy) ||
      receipt.bundleId !== policy.bundleId ||
      Date.parse(receipt.builtAt) > Date.parse(now)
    )
      throw invalid();
    const app = join(dir, "app.app");
    if ((await appDigest(app, check)) !== receipt.appHash) throw invalid();
    check();
    return { app, appHash: receipt.appHash };
  } catch (e) {
    if (checkpointFailed) throw e;
    throw invalid();
  }
}
