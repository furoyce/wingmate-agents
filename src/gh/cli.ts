// src/gh/cli.ts — GhPort over the gh binary with the owner's session; never `--web`, never merges.
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DISPATCHER_GIT_ENV, type Runner } from "../git/cli";
import type { GhPort } from "../ports";
import { WingmateError } from "../shared/errors";
import { run } from "../shared/exec";
import { newUlid } from "../shared/ids";
import { writeAtomic } from "../state/fs";

const PrRow = z.object({ number: z.number().int().positive(), url: z.string().url() });
const PrView = z.object({ state: z.string(), headRefName: z.string(), url: z.string() });
const PR_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;

/** Parses gh's JSON stdout with a schema; a malformed answer is an error naming the verb, never a default. */
function parsed<T>(verb: string, schema: z.ZodType<T>, stdout: string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout || "null");
  } catch (e) {
    throw new WingmateError("gh_shape", `gh ${verb}: output is not JSON (${(e as Error).message})`);
  }
  const p = schema.safeParse(raw);
  if (!p.success)
    throw new WingmateError(
      "gh_shape",
      `gh ${verb}: ${p.error.issues[0]?.path.join(".") ?? ""} ${p.error.issues[0]?.message ?? ""}`,
    );
  return p.data;
}

export class GhCli implements GhPort {
  constructor(private readonly exec: Runner = run) {}

  /** Reuses the open PR of `head` when there is one (replay-safe, Appendix D), else creates it from a 0600 body file. */
  async prCreate(
    cwd: string,
    a: { head: string; base: string; title: string; body: string; draft: boolean },
  ): Promise<{ number: number; url: string }> {
    const existing = await this.exec(
      ["gh", "pr", "list", "--head", a.head, "--state", "open", "--json", "number,url", "--limit", "1"],
      { cwd, timeoutMs: 60_000, env: { ...DISPATCHER_GIT_ENV } },
    );
    if (existing.code === 0) {
      const rows = parsed("pr list", z.array(PrRow), existing.stdout || "[]");
      if (rows[0]) return rows[0];
    }
    const bodyFile = join(tmpdir(), `wm-pr-${newUlid()}.md`);
    await writeAtomic(bodyFile, a.body, 0o600);
    try {
      const r = await this.exec(
        [
          "gh",
          "pr",
          "create",
          "--head",
          a.head,
          "--base",
          a.base,
          "--title",
          a.title,
          "--body-file",
          bodyFile,
          ...(a.draft ? ["--draft"] : []),
        ],
        { cwd, timeoutMs: 120_000, env: { ...DISPATCHER_GIT_ENV } },
      );
      if (r.code !== 0)
        throw new WingmateError(
          "gh_failed",
          `gh pr create failed (${r.code}): ${r.stderr.trim().slice(0, 300)}`,
        );
      const url = r.stdout
        .split("\n")
        .map((l) => l.trim())
        .find((l) => PR_URL.test(l));
      const number = Number(/\/pull\/(\d+)$/.exec(url ?? "")?.[1] ?? 0);
      if (!url || !number) throw new WingmateError("gh_shape", "gh pr create: no PR url in output");
      return { number, url };
    } finally {
      await unlink(bodyFile).catch(() => undefined);
    }
  }

  async prView(cwd: string, number: number): Promise<{ state: string; headRefName: string; url: string }> {
    const r = await this.exec(["gh", "pr", "view", String(number), "--json", "state,headRefName,url"], {
      cwd,
      timeoutMs: 60_000,
      env: { ...DISPATCHER_GIT_ENV },
    });
    if (r.code !== 0)
      throw new WingmateError("gh_failed", `gh pr view failed (${r.code}): ${r.stderr.trim().slice(0, 200)}`);
    return parsed("pr view", PrView, r.stdout);
  }
}
