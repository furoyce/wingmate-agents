// src/gh/cli.ts — GhPort over the gh binary with the owner's session; never `--web`, never merges. C29: every call names the configured
// repository (`--repo <repos.<name>.github>`) and runs from `/`, outside every worktree: gh resolves no repository from a worktree's
// remotes, and the git it runs for itself (remotes, status) finds no repository there — nothing it does reads an agent-writable link.
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
/** C29: `owner/name` as the config validates it, and never starting with `-`, so it can never read as an option. */
const GH_REPO = /^[\w.][\w.-]*\/[\w.][\w.-]*$/;
/** C29: where gh runs — no repository for its own git calls to find, and none an agent could create (it cannot write `/`). */
const GH_CWD = "/";

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

/** C29: `--repo <owner/name>`, refused before gh starts when the configured repository is anything else. */
function repoFlag(repo: string): string[] {
  if (!GH_REPO.test(repo))
    throw new WingmateError(
      "gh_repo_invalid",
      "the configured GitHub repository is not owner/name; gh was not run",
      "fix repos.<name>.github in config/projects.yaml",
    );
  return ["--repo", repo];
}

export class GhCli implements GhPort {
  constructor(private readonly exec: Runner = run) {}

  async hasOpenPr(repo: string, branch: string): Promise<boolean> {
    const r = await this.exec(
      [
        "gh",
        "pr",
        "list",
        ...repoFlag(repo),
        "--head",
        branch,
        "--state",
        "open",
        "--json",
        "number,url",
        "--limit",
        "1",
      ],
      { cwd: GH_CWD, timeoutMs: 60_000, env: { ...DISPATCHER_GIT_ENV } },
    );
    if (r.code !== 0 || r.timedOut || r.truncated)
      throw new WingmateError("gh_failed", "open PR inventory incomplete");
    return parsed("pr list", z.array(PrRow), r.stdout).length > 0;
  }

  /** Reuses the open PR of `head` when there is one (replay-safe, Appendix D), else creates it from a 0600 body file. */
  async prCreate(
    repo: string,
    a: { head: string; base: string; title: string; body: string; draft: boolean },
  ): Promise<{ number: number; url: string }> {
    const R = repoFlag(repo);
    const existing = await this.exec(
      ["gh", "pr", "list", ...R, "--head", a.head, "--state", "open", "--json", "number,url", "--limit", "1"],
      { cwd: GH_CWD, timeoutMs: 60_000, env: { ...DISPATCHER_GIT_ENV } },
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
          ...R,
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
        { cwd: GH_CWD, timeoutMs: 120_000, env: { ...DISPATCHER_GIT_ENV } },
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

  async prView(repo: string, number: number): Promise<{ state: string; headRefName: string; url: string }> {
    const r = await this.exec(
      ["gh", "pr", "view", String(number), ...repoFlag(repo), "--json", "state,headRefName,url"],
      { cwd: GH_CWD, timeoutMs: 60_000, env: { ...DISPATCHER_GIT_ENV } },
    );
    if (r.code !== 0 || r.timedOut || r.truncated)
      throw new WingmateError("gh_failed", `gh pr view failed (${r.code}): ${r.stderr.trim().slice(0, 200)}`);
    return parsed("pr view", PrView, r.stdout);
  }
}
