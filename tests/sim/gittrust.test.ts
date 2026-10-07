// tests/sim/gittrust.test.ts — Ruling R28 (Task 12 phase 0) through whole ticks: the worktree's git links at claim and in the
// per-tick integrity check (C22), the repo setup only in a worktree the claim created (C27), and the allow-deps grant in the kit's
// launch.json (C28); Ruling R29's claim base read from GitHub (C30); every runTick also asserts I1–I10.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyIntegrity } from "../../src/kit/install";
import { writeIntent } from "../../src/kit/intents";
import { LaunchSchema } from "../../src/kit/local";
import { type WRecord, readRecord } from "../../src/state/records";
import { OWNER, type World, advance, labeledByOwner, runTick, todo, world } from "./harness";

async function rec(w: World, identifier = "JRF-501"): Promise<WRecord> {
  const r = await readRecord(w.dirs, identifier);
  if (!r) throw new Error(`no record ${identifier}`);
  return r;
}
async function claimed(w: World): Promise<WRecord> {
  labeledByOwner(w, todo("i1", "JRF-501"));
  expect((await runTick(w)).claims).toEqual(["JRF-501"]);
  return rec(w);
}
const wtOf = (r: WRecord) => {
  if (!r.worktree) throw new Error(`${r.identifier} has no worktree`);
  return r.worktree;
};
const gitDirOf = (wt: NonNullable<WRecord["worktree"]>) => join(wt.gitCommonDir, "worktrees", wt.gitdirName);
const idleNow = (w: World, r: WRecord) =>
  w.orca.setAgentState(r.worktree?.id ?? "", r.coordinator.paneKey ?? "", "done", w.ctx.now());
/** The owner moves the issue back to Todo: the record is released and its worktree kept for the next cycle. */
async function released(w: World, r: WRecord): Promise<void> {
  idleNow(w, r);
  advance(w, 5);
  w.linear.setState("i1", "Todo", OWNER, w.ctx.now());
  advance(w, 5);
  expect((await runTick(w)).released).toEqual(["JRF-501"]);
}
/** A common dir an agent could make in $TMPDIR, laid out like a linked worktree's, with a config of its own. */
function forged(name: string): string {
  const fake = realpathSync(mkdtempSync(join(tmpdir(), "wm-forged-")));
  mkdirSync(join(fake, "worktrees", name), { recursive: true });
  writeFileSync(join(fake, "config"), '[core]\n\tsshCommand = "touch /tmp/wm-pwned"\n');
  writeFileSync(join(fake, "worktrees", name, "commondir"), "../..\n");
  writeFileSync(join(fake, "worktrees", name, "HEAD"), "ref: refs/heads/furoyce/wm-jrf-501\n");
  return fake;
}
const labels = (w: World) => w.linear.issues.get("i1")?.labels.map((l) => l.name) ?? [];
const terminalCreates = (w: World) => w.orca.calls.filter((c) => c.verb === "terminalCreate").length;
const ledgerOf = async (w: World, type: string) =>
  (await w.ctx.ledger.readIssue("JRF-501")).filter((e) => e.type === type);
const launchOf = (r: WRecord) =>
  LaunchSchema.parse(JSON.parse(readFileSync(join(wtOf(r).path, ".wingmate", "launch.json"), "utf8")));

describe("C22: the worktree's git links (§13.3 d)", () => {
  test("a re-claim of a worktree whose commondir an earlier agent redirected blocks kit_tampered: nothing is recorded from it and no coordinator starts", async () => {
    const w = await world();
    const r = await claimed(w);
    const wt = wtOf(r);
    await released(w, r);
    writeFileSync(join(gitDirOf(wt), "commondir"), `${forged(wt.gitdirName)}\n`);
    advance(w, 5);
    expect((await runTick(w)).claims).toEqual(["JRF-501"]);
    const again = await rec(w);
    expect(again).toMatchObject({ cycle: 2, stage: "blocked", worktree: null });
    expect(again.history.at(-1)?.cause).toBe("kit_tampered");
    expect(terminalCreates(w)).toBe(1); // cycle 1's only
    expect(labels(w)).toContain("Blocked");
  });

  test("a re-claim of a worktree whose gitfile names a forged git dir laid out like a linked worktree blocks too: the archived record is the anchor", async () => {
    const w = await world();
    const r = await claimed(w);
    const wt = wtOf(r);
    await released(w, r);
    writeFileSync(
      join(wt.path, ".git"),
      `gitdir: ${join(forged(wt.gitdirName), "worktrees", wt.gitdirName)}\n`,
    );
    advance(w, 5);
    expect((await runTick(w)).claims).toEqual(["JRF-501"]);
    const again = await rec(w);
    expect(again).toMatchObject({ cycle: 2, stage: "blocked", worktree: null });
    expect(again.history.at(-1)?.cause).toBe("kit_tampered");
    expect(terminalCreates(w)).toBe(1);
  });

  test("the per-tick integrity check reports a redirected commondir as a kit change (.git): blocked kit_tampered", async () => {
    const w = await world();
    const wt = wtOf(await claimed(w));
    writeFileSync(join(gitDirOf(wt), "commondir"), `${forged(wt.gitdirName)}\n`);
    advance(w, 5);
    expect((await runTick(w)).blocked).toEqual(["JRF-501"]);
    expect((await rec(w)).history.at(-1)).toMatchObject({
      to: "blocked",
      cause: "kit_tampered",
      evidence: ".git",
    });
  });
});

/** The api repo's setup leaves a trace on disk when it runs (it runs outside the sandbox). */
function tracedSetup(w: World): string {
  const runs = join(w.root, "setup-runs.txt");
  const api = w.cfg.projects.bouncr?.repos.api;
  if (!api) throw new Error("api repo missing");
  api.setup = ["sh", "-c", `echo ran >> ${runs}`];
  return runs;
}
const blockedComment = (w: World) =>
  w.linear.comments.find((c) => c.body.startsWith("<!-- wingmate:blocked -->"))?.body ?? "";

describe("F7: the claim's base is the fully qualified ref, and a worktree this claim created must start at it", () => {
  async function blockedAtClaim(w: World, cause = "kit_tampered"): Promise<WRecord> {
    labeledByOwner(w, todo("i1", "JRF-501"));
    expect((await runTick(w)).claims).toEqual(["JRF-501"]);
    const r = await rec(w);
    expect(r.stage).toBe("blocked");
    expect(r.history.at(-1)?.cause).toBe(cause);
    return r;
  }

  test("the base is resolved as refs/remotes/origin/main, never by the short name git disambiguates across ref namespaces", async () => {
    const w = await world();
    const asked: string[] = [];
    const revParse = w.git.revParse.bind(w.git);
    w.git.revParse = async (at, ref) => {
      asked.push(ref);
      return revParse(at, ref);
    };
    const r = await claimed(w);
    expect(asked).toContain("refs/remotes/origin/main");
    expect(asked).not.toContain("origin/main");
    expect(wtOf(r).baseSha).toBe("basesha");
  });

  test("a new worktree that does not start at the base commit is blocked kit_tampered before the kit, the setup or a terminal", async () => {
    const w = await world();
    const runs = tracedSetup(w);
    w.orca.startCommit = "0123456789abcdef0123456789abcdef01234567"; // Orca started it elsewhere (a shadowing ref, a stale branch)
    const r = await blockedAtClaim(w);
    expect(r.history.at(-1)?.evidence).toContain("refs/remotes/origin/main");
    expect(r.worktree?.id).toBeTruthy(); // recorded, so the blocked comment names it and stop/release cover it
    expect(await ledgerOf(w, "kit_installed")).toEqual([]);
    expect(() => readFileSync(runs, "utf8")).toThrow();
    expect(terminalCreates(w)).toBe(0);
    expect(labels(w)).toContain("Blocked");
    const comment = w.linear.comments.find((c) => c.body.startsWith("<!-- wingmate:blocked -->"))?.body ?? "";
    expect(comment).toContain("refs/remotes/origin/main");
    expect(comment).not.toContain("0123456789abcdef0123456789abcdef01234567"); // short commit names only
  });

  test("a base that does not resolve on a new worktree blocks the same way: its start cannot be verified (C30: base_mismatch, the local ref names no commit GitHub has)", async () => {
    const w = await world();
    const runs = tracedSetup(w);
    const revParse = w.git.revParse.bind(w.git);
    w.git.revParse = async (at, ref) => {
      if (ref !== "HEAD") throw new Error("git rev-parse failed (128): fatal: Needed a single revision");
      return revParse(at, ref);
    };
    await blockedAtClaim(w, "base_mismatch");
    expect(await ledgerOf(w, "kit_installed")).toEqual([]);
    expect(() => readFileSync(runs, "utf8")).toThrow();
    expect(terminalCreates(w)).toBe(0);
  });

  test("a reused worktree is never compared with its start commit: its head carries the earlier cycle's commits", async () => {
    const w = await world();
    const r = await claimed(w);
    await released(w, r);
    w.orca.startCommit = "moved-by-the-first-cycle";
    advance(w, 5);
    expect((await runTick(w)).claims).toEqual(["JRF-501"]);
    expect(await rec(w)).toMatchObject({ cycle: 2, stage: "working" });
  });
});

describe("C30: the claim's base is GitHub's — the local origin/main must name the commit ls-remote reads (Ruling R29)", () => {
  /** The configured URL of the bouncr api repo (`https://github.com/<repos.api.github>.git`). */
  const URL = "https://github.com/furoyce/bouncr.lol.git";
  /** GitHub's main in the mismatch tests; the local origin/main resolves to `basesha` (an agent may rewrite packed-refs). */
  const GITHUB_MAIN = "0123456789abcdef0123456789abcdef01234567";

  test("the base is read from GitHub — ls-remote of the configured URL for main — and becomes the worktree's baseSha", async () => {
    const w = await world();
    const r = await claimed(w);
    expect(w.git.remoteReads[0]).toEqual({ url: URL, branch: "main" });
    expect(wtOf(r).baseSha).toBe("basesha");
    expect(r.attention).not.toContain("base_mismatch");
    expect(w.git.fetched).toEqual([]); // the commit is here: nothing to fetch
  });

  test("F1/F2: a local origin/main naming another commit than GitHub's main blocks base_mismatch before Orca creates any worktree: attention, ledger, journal abandoned, short commit names only", async () => {
    const w = await world();
    const runs = tracedSetup(w);
    w.git.remoteSha.set("main", GITHUB_MAIN);
    labeledByOwner(w, todo("i1", "JRF-501"));
    expect((await runTick(w)).claims).toEqual(["JRF-501"]);
    const r = await rec(w);
    expect(r.stage).toBe("blocked");
    expect(r.history.at(-1)?.cause).toBe("base_mismatch");
    // nothing was checked out from the local base: Orca was never asked to create the worktree
    expect(w.orca.calls.filter((c) => c.verb === "worktreeCreate")).toEqual([]);
    expect(r.worktree).toBeNull();
    expect(w.git.remoteReads[0]).toEqual({ url: URL, branch: "main" }); // read in the main checkout, before any create
    expect((await ledgerOf(w, "base_mismatch")).map((e) => e.data)).toEqual([
      {
        base: "refs/remotes/origin/main",
        branch: "main",
        remote: GITHUB_MAIN,
        local: "basesha",
        verdict: "diverged",
        reused: false,
      },
    ]);
    expect(await ledgerOf(w, "kit_installed")).toEqual([]);
    expect(() => readFileSync(runs, "utf8")).toThrow();
    expect(terminalCreates(w)).toBe(0);
    expect(labels(w)).toContain("Blocked");
    expect(blockedComment(w)).toContain("refs/remotes/origin/main");
    expect(blockedComment(w)).toContain(GITHUB_MAIN.slice(0, 12));
    expect(blockedComment(w)).not.toContain(GITHUB_MAIN);
    expect((await w.ctx.journal.all()).find((e) => e.kind === "claim")?.state).toBe("abandoned");
  });

  test("F1/F2: a verified base is read in the main checkout first, then Orca creates the worktree from GitHub's commit itself — never from the configured ref name", async () => {
    const w = await world();
    const order: string[] = [];
    const lsRemote = w.git.lsRemoteSha.bind(w.git);
    w.git.lsRemoteSha = async (at, url, branch) => {
      order.push(`ls-remote ${at.path}`);
      return lsRemote(at, url, branch);
    };
    w.orca.onCall = (verb) => {
      if (verb === "worktreeCreate") order.push("worktreeCreate");
    };
    const r = await claimed(w);
    const api = w.cfg.projects.bouncr?.repos.api?.orcaRepo ?? "";
    expect(order).toEqual([`ls-remote ${join(w.root, "orca", "repos", api)}`, "worktreeCreate"]);
    const create = w.orca.calls.find((c) => c.verb === "worktreeCreate")?.args as { baseBranch: string };
    expect(create.baseBranch).toBe("basesha"); // GitHub's main (FakeGit's remote), not origin/main
    expect(wtOf(r).baseSha).toBe("basesha");
    expect(r.stage).toBe("working");
  });

  test("F1/F2: a ref named refs/heads/<GitHub's commit> — which Orca would take for the base — blocks diverged before any create", async () => {
    const w = await world();
    w.git.planted.set("refs/heads/basesha", "agentsha");
    labeledByOwner(w, todo("i1", "JRF-501"));
    expect((await runTick(w)).claims).toEqual(["JRF-501"]);
    const r = await rec(w);
    expect(r.history.at(-1)?.cause).toBe("base_mismatch");
    expect(r.attention).toContain("base_diverged");
    expect(w.orca.calls.filter((c) => c.verb === "worktreeCreate")).toEqual([]);
    expect((await ledgerOf(w, "base_mismatch")).map((e) => e.data.verdict)).toEqual(["diverged"]);
    expect(blockedComment(w)).toContain("refs/heads/basesha");
    expect(terminalCreates(w)).toBe(0);
  });

  /** An object an agent asks git to read another one in place of (`refs/replace/<object>`, F7); its name is agent-made. */
  const REPLACED = "89abcdef0123456789abcdef0123456789abcdef";

  test("F7: a replace ref in the repository — git would read another object in place of GitHub's commit, its tree or a file, HEAD unchanged — blocks diverged before any create", async () => {
    const w = await world();
    const runs = tracedSetup(w);
    w.git.planted.set(`refs/replace/${REPLACED}`, "agentsha");
    labeledByOwner(w, todo("i1", "JRF-501"));
    expect((await runTick(w)).claims).toEqual(["JRF-501"]);
    const r = await rec(w);
    expect(r.history.at(-1)?.cause).toBe("base_mismatch");
    expect(r.attention).toContain("base_diverged");
    expect(r.worktree).toBeNull();
    expect(w.orca.calls.filter((c) => c.verb === "worktreeCreate")).toEqual([]);
    // the base itself verified (GitHub's main, here); what would stand in for it is the replace ref
    expect((await ledgerOf(w, "base_mismatch")).map((e) => e.data)).toEqual([
      {
        base: "refs/remotes/origin/main",
        branch: "main",
        remote: "basesha",
        local: "basesha",
        verdict: "diverged",
        reused: false,
      },
    ]);
    expect(blockedComment(w)).toContain("refs/replace/");
    expect(blockedComment(w)).not.toContain(REPLACED.slice(0, 12)); // agent-made names never reach the comment
    expect(await ledgerOf(w, "kit_installed")).toEqual([]);
    expect(() => readFileSync(runs, "utf8")).toThrow();
    expect(terminalCreates(w)).toBe(0);
  });

  test("F7: a replace ref that appears while Orca creates the worktree (after the check) blocks kit_tampered before the kit, the setup or a terminal", async () => {
    const w = await world();
    const runs = tracedSetup(w);
    w.orca.onCall = (verb) => {
      if (verb === "worktreeCreate") w.git.planted.set(`refs/replace/${REPLACED}`, "agentsha");
    };
    labeledByOwner(w, todo("i1", "JRF-501"));
    expect((await runTick(w)).claims).toEqual(["JRF-501"]);
    const r = await rec(w);
    expect(r.stage).toBe("blocked");
    expect(r.history.at(-1)?.cause).toBe("kit_tampered");
    expect(r.worktree?.id).toBeTruthy(); // recorded, so the blocked comment names it and stop/release cover it
    expect(w.orca.calls.filter((c) => c.verb === "worktreeCreate")).toHaveLength(1);
    expect(await ledgerOf(w, "kit_installed")).toEqual([]);
    expect(() => readFileSync(runs, "utf8")).toThrow();
    expect(terminalCreates(w)).toBe(0);
    expect(blockedComment(w)).toContain("refs/replace/");
    expect(blockedComment(w)).not.toContain(REPLACED.slice(0, 12));
    expect(blockedComment(w)).toContain("wingmate stop --all"); // a hook may have run during the create: a possible escape
  });

  test("F1/F2: without the repository's main checkout in Orca's fleet the base cannot be verified first: blocked, nothing created", async () => {
    const w = await world();
    w.orca.mains.clear();
    labeledByOwner(w, todo("i1", "JRF-501"));
    expect((await runTick(w)).claims).toEqual(["JRF-501"]);
    const r = await rec(w);
    expect(r.history.at(-1)?.cause).toBe("base_mismatch");
    expect(r.attention).toContain("base_mismatch");
    expect(w.orca.calls.filter((c) => c.verb === "worktreeCreate")).toEqual([]);
    expect(w.git.remoteReads).toEqual([]);
    expect((await ledgerOf(w, "base_mismatch")).map((e) => e.data.verdict)).toEqual(["unverifiable"]);
    expect(blockedComment(w)).toContain("main checkout");
  });

  test("F1/F2: a main checkout whose .git holds a commondir file (git would read its refs elsewhere) blocks diverged before any git runs or anything is created", async () => {
    const w = await world();
    const api = w.cfg.projects.bouncr?.repos.api?.orcaRepo ?? "";
    const gitDir = join(w.root, "orca", "repos", api, ".git");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "commondir"), `${forged("x")}\n`);
    labeledByOwner(w, todo("i1", "JRF-501"));
    expect((await runTick(w)).claims).toEqual(["JRF-501"]);
    const r = await rec(w);
    expect(r.history.at(-1)?.cause).toBe("base_mismatch");
    expect(r.attention).toContain("base_diverged");
    expect(w.git.remoteReads).toEqual([]);
    expect(w.orca.calls.filter((c) => c.verb === "worktreeCreate")).toEqual([]);
    expect(blockedComment(w)).toContain("commondir");
  });

  test("F3: a clone behind GitHub (its origin/main an ancestor of GitHub's main) is stale — attention base_mismatch, fetch and re-queue; a diverged ref is kept as evidence and handled as tampering", async () => {
    const stale = await world();
    stale.git.remoteSha.set("main", GITHUB_MAIN);
    stale.git.ancestors.add(`basesha..${GITHUB_MAIN}`);
    labeledByOwner(stale, todo("i1", "JRF-501"));
    await runTick(stale);
    const s = await rec(stale);
    expect(s.attention).toContain("base_mismatch");
    expect(s.attention).not.toContain("base_diverged");
    expect((await ledgerOf(stale, "base_mismatch")).map((e) => e.data.verdict)).toEqual(["stale"]);
    expect(blockedComment(stale)).toContain("behind GitHub");
    expect(blockedComment(stale)).toContain("git fetch origin");
    expect(blockedComment(stale)).not.toContain("stop --all");

    const diverged = await world();
    diverged.git.remoteSha.set("main", GITHUB_MAIN); // basesha is not an ancestor: a rewritten ref
    labeledByOwner(diverged, todo("i1", "JRF-501"));
    await runTick(diverged);
    const d = await rec(diverged);
    expect(d.attention).toContain("base_diverged");
    expect(d.attention).not.toContain("base_mismatch");
    const comment = blockedComment(diverged);
    expect(comment).toContain("not in the history of GitHub's main");
    const api = diverged.cfg.projects.bouncr?.repos.api?.orcaRepo ?? "";
    // the evidence first: packed-refs copied aside before the stop, the rotation and only then a fetch
    const copy = comment.indexOf(
      `copy ${join(diverged.root, "orca", "repos", api, ".git")}/packed-refs aside`,
    );
    expect(copy).toBeGreaterThan(-1);
    expect(comment.indexOf("wingmate stop --all")).toBeGreaterThan(copy);
    expect(comment.indexOf("git fetch origin")).toBeGreaterThan(comment.indexOf("wingmate stop --all"));
  });

  test("a commit this repository lacks is fetched from the configured URL before the comparison; the claim then goes on", async () => {
    const w = await world();
    w.git.missing.add("basesha"); // the ref names GitHub's commit, whose object is not here yet
    const r = await claimed(w);
    expect(w.git.fetched).toEqual([{ url: URL, sha: "basesha" }]);
    expect(r.stage).toBe("working");
    expect(wtOf(r).baseSha).toBe("basesha");
  });

  test("a re-claim that reuses the worktree checks the base too: an origin/main that no longer names GitHub's main blocks base_mismatch", async () => {
    const w = await world();
    const r = await claimed(w);
    await released(w, r);
    w.git.remoteSha.set("main", GITHUB_MAIN);
    w.git.ancestors.add(`basesha..${GITHUB_MAIN}`); // GitHub moved on: a stale clone
    advance(w, 5);
    expect((await runTick(w)).claims).toEqual(["JRF-501"]);
    const again = await rec(w);
    expect(again).toMatchObject({ cycle: 2, stage: "blocked" });
    expect(again.history.at(-1)?.cause).toBe("base_mismatch");
    expect(again.worktree?.id).toBe(wtOf(r).id);
    expect(terminalCreates(w)).toBe(1); // cycle 1's only
    expect(w.orca.calls.filter((c) => c.verb === "worktreeCreate")).toHaveLength(1); // cycle 1's only
    expect((await ledgerOf(w, "base_mismatch")).at(-1)?.data).toMatchObject({
      verdict: "stale",
      reused: true,
    });
  });

  test("a base branch GitHub does not have blocks base_mismatch: the base cannot be verified", async () => {
    const w = await world();
    w.git.remoteSha.delete("main");
    labeledByOwner(w, todo("i1", "JRF-501"));
    expect((await runTick(w)).claims).toEqual(["JRF-501"]);
    const r = await rec(w);
    expect(r.history.at(-1)?.cause).toBe("base_mismatch");
    expect(blockedComment(w)).toContain("furoyce/bouncr.lol");
    expect(terminalCreates(w)).toBe(0);
  });
});

describe("C27: the repo setup runs only in a worktree this claim created (§5.4 step 4, amended)", () => {
  test("a fresh claim runs it once; a re-claim that reuses the worktree never runs it again (the setup runs outside the sandbox)", async () => {
    const w = await world();
    const runs = join(w.root, "setup-runs.txt");
    const api = w.cfg.projects.bouncr?.repos.api;
    if (!api) throw new Error("api repo missing");
    api.setup = ["sh", "-c", `echo ran >> ${runs}`];
    const r = await claimed(w);
    expect(readFileSync(runs, "utf8")).toBe("ran\n");
    await released(w, r);
    advance(w, 5);
    expect((await runTick(w)).claims).toEqual(["JRF-501"]);
    const again = await rec(w);
    expect(again).toMatchObject({ cycle: 2, stage: "working" });
    expect(again.worktree?.id).toBe(wtOf(r).id);
    expect(readFileSync(runs, "utf8")).toBe("ran\n");
    expect(await ledgerOf(w, "setup")).toHaveLength(1);
    expect((await ledgerOf(w, "setup_skipped")).map((e) => e.data.reason)).toEqual(["reused"]);
  });

  test("a reroute never runs the other repo's setup", async () => {
    const w = await world();
    const runs = join(w.root, "setup-runs.txt");
    const web = w.cfg.projects.bouncr?.repos.web;
    if (!web) throw new Error("web repo missing");
    web.setup = ["sh", "-c", `echo ran >> ${runs}`];
    const r = await claimed(w);
    await writeIntent(wtOf(r).path, {
      issue: "JRF-501",
      kind: "handoff",
      payload: { reason: "wrong repo", repo: "web" },
    });
    advance(w, 5);
    expect((await runTick(w)).resumes).toEqual(["JRF-501"]);
    expect(await rec(w)).toMatchObject({ repo: "web", stage: "working" });
    expect(() => readFileSync(runs, "utf8")).toThrow();
    expect((await ledgerOf(w, "setup_skipped")).map((e) => e.data.reason)).toEqual(["reroute"]);
  });
});

describe("C28: launch.json allowDeps follows the allow-deps grant (§13.3 e)", () => {
  const ALLOW_DEPS = { id: "lb-allow-deps", name: "allow-deps", parentId: null, parentName: null };
  const AGENT_READY = {
    id: "lb-agent-ready",
    name: "agent-ready",
    parentId: "grp-agent",
    parentName: "Agent",
  };

  test("an approver's grant before the claim is in launch.json from the start", async () => {
    const w = await world();
    labeledByOwner(w, todo("i1", "JRF-501", { labels: [AGENT_READY, ALLOW_DEPS] }));
    expect((await runTick(w)).claims).toEqual(["JRF-501"]);
    expect(launchOf(await rec(w)).allowDeps).toBe(true);
  });

  test("a grant made while parked reaches launch.json before the answer resumes the agent, with the pinned hashes following (no kit_tampered); withdrawn, it turns off", async () => {
    const w = await world();
    const r = await claimed(w);
    expect(launchOf(r).allowDeps).toBe(false);
    idleNow(w, r);
    const wt = wtOf(r);
    writeFileSync(join(wt.path, ".wingmate", "q.md"), "May I add the zod dependency?");
    await writeIntent(wt.path, {
      issue: "JRF-501",
      kind: "ask",
      payload: {
        questionFile: ".wingmate/q.md",
        options: ["yes", "no"],
        recommend: 1,
        append: null,
        reask: null,
      },
    });
    advance(w, 5);
    expect((await runTick(w)).parked).toEqual(["JRF-501"]);
    const parked = await rec(w);
    advance(w, 5);
    w.linear.setLabels("i1", [...labels(w), "allow-deps"], OWNER, w.ctx.now());
    w.linear.humanComment("i1", "1", OWNER, w.ctx.now(), parked.questions[0]?.commentId ?? null);
    advance(w, 5);
    expect((await runTick(w)).resumes).toEqual(["JRF-501"]);
    expect(launchOf(await rec(w)).allowDeps).toBe(true);
    const rehashed = await ledgerOf(w, "kit_rehashed");
    expect(rehashed.map((e) => e.data.allowDeps)).toEqual([true]);
    // spawn's own copy of the hashes follows too, so it does not refuse kit_tampered
    const local = JSON.parse(readFileSync(join(wt.path, ".wingmate", "integrity.json"), "utf8"));
    expect(await verifyIntegrity(wt.path, local.commonDir, local.hashes)).toEqual([]);
    advance(w, 5);
    await runTick(w);
    expect((await rec(w)).stage).toBe("working");
    w.linear.setLabels(
      "i1",
      labels(w).filter((l) => l !== "allow-deps"),
      OWNER,
      w.ctx.now(),
    );
    advance(w, 5);
    await runTick(w);
    expect(launchOf(await rec(w)).allowDeps).toBe(false);
    advance(w, 5);
    await runTick(w);
    expect((await rec(w)).stage).toBe("working");
    expect((await ledgerOf(w, "kit_rehashed")).map((e) => e.data.allowDeps)).toEqual([true, false]);
  });

  test("an agent that sets allowDeps itself is blocked kit_tampered: the tick never rewrites a kit that no longer hashes as pinned", async () => {
    const w = await world();
    const r = await claimed(w);
    const file = join(wtOf(r).path, ".wingmate", "launch.json");
    writeFileSync(file, readFileSync(file, "utf8").replace('"allowDeps": false', '"allowDeps": true'));
    advance(w, 5);
    expect((await runTick(w)).blocked).toEqual(["JRF-501"]);
    expect((await rec(w)).history.at(-1)?.cause).toBe("kit_tampered");
    expect(await ledgerOf(w, "kit_rehashed")).toEqual([]);
  });

  /** The record parked on a question (the window in which an approver's allow-deps grant counts); returns the parked record. */
  async function parkedOnQuestion(w: World): Promise<WRecord> {
    const r = await claimed(w);
    idleNow(w, r);
    const wt = wtOf(r);
    writeFileSync(join(wt.path, ".wingmate", "q.md"), "May I add the zod dependency?");
    await writeIntent(wt.path, {
      issue: "JRF-501",
      kind: "ask",
      payload: {
        questionFile: ".wingmate/q.md",
        options: ["yes", "no"],
        recommend: 1,
        append: null,
        reask: null,
      },
    });
    advance(w, 5);
    expect((await runTick(w)).parked).toEqual(["JRF-501"]);
    advance(w, 5);
    return rec(w);
  }
  /** The approver grants allow-deps and answers the question (the next tick delivers both). */
  function grantAndAnswer(w: World, parked: WRecord): void {
    w.linear.setLabels("i1", [...labels(w), "allow-deps"], OWNER, w.ctx.now());
    w.linear.humanComment("i1", "1", OWNER, w.ctx.now(), parked.questions[0]?.commentId ?? null);
    advance(w, 5);
  }
  const launchFile = (r: WRecord) => join(wtOf(r).path, ".wingmate", "launch.json");
  /** launch.json rewritten as the tick writes it (two-space JSON, keys in place) with `edit` applied. */
  function rewriteLaunch(r: WRecord, edit: (raw: Record<string, unknown>) => Record<string, unknown>): void {
    const raw = JSON.parse(readFileSync(launchFile(r), "utf8")) as Record<string, unknown>;
    writeFileSync(launchFile(r), JSON.stringify(edit(raw), null, 2));
  }

  test("F6: an agent's edit of another launch.json field, written exactly as the tick writes it with allowDeps unchanged, is never re-pinned: blocked kit_tampered, no kit_rehashed", async () => {
    const w = await world();
    const r = await claimed(w);
    rewriteLaunch(r, (raw) => ({
      ...raw,
      quota: { ...(raw.quota as object), weeklyMax: 100, sessionMax: 100 },
      verifyCross: false,
    }));
    advance(w, 5);
    expect((await runTick(w)).blocked).toEqual(["JRF-501"]);
    expect((await rec(w)).history.at(-1)).toMatchObject({
      cause: "kit_tampered",
      evidence: ".wingmate/launch.json",
    });
    expect(await ledgerOf(w, "kit_rehashed")).toEqual([]);
  });

  test("F6: an agent that edits another field and pre-sets allowDeps to a grant made meanwhile is blocked too: the grant never launders the edit", async () => {
    const w = await world();
    const parked = await parkedOnQuestion(w);
    rewriteLaunch(parked, (raw) => ({ ...raw, allowDeps: true, forbiddenPaths: [] }));
    grantAndAnswer(w, parked);
    expect((await runTick(w)).blocked).toEqual(["JRF-501"]);
    expect((await rec(w)).history.at(-1)?.cause).toBe("kit_tampered");
    expect(await ledgerOf(w, "kit_rehashed")).toEqual([]);
  });

  test("F6: crash repair still works — launch.json written for a new grant but never pinned (the tick died) is pinned by the next tick, as the pinned content with only allowDeps changed", async () => {
    const w = await world();
    const parked = await parkedOnQuestion(w);
    rewriteLaunch(parked, (raw) => ({ ...raw, allowDeps: true })); // what the crashed tick wrote
    grantAndAnswer(w, parked);
    expect((await runTick(w)).resumes).toEqual(["JRF-501"]);
    expect((await ledgerOf(w, "kit_rehashed")).map((e) => e.data.allowDeps)).toEqual([true]);
    advance(w, 5);
    await runTick(w);
    expect((await rec(w)).stage).toBe("working");
    expect(launchOf(await rec(w)).allowDeps).toBe(true);
  });
});
