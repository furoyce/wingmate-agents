import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../../src/config/load";
import type { Config, ProjectConfig } from "../../../src/config/schema";
import { canonicalGitConfig, installKit, verifyIntegrity } from "../../../src/kit/install";
import { writeIntent } from "../../../src/kit/intents";
import { LaunchSchema, readLocal, writeLocal } from "../../../src/kit/local";
import { agentEnv } from "../../../src/kit/settings";
import { run } from "../../../src/shared/exec";
import { newRecord } from "../../../src/state/records";

const GIT_ID = ["-c", "user.name=t", "-c", "user.email=t@example.invalid"];
async function gitRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "wm-repo-"));
  await run(["git", "init", "-q", repo]);
  await run(["git", "-C", repo, ...GIT_ID, "commit", "-q", "--allow-empty", "-m", "init"]);
  return repo;
}
async function bouncr(): Promise<{ cfg: Config; project: ProjectConfig }> {
  const cfg = await loadConfig("config/projects.yaml");
  const project = cfg.projects.bouncr;
  if (!project) throw new Error("bouncr project missing from config");
  return { cfg, project };
}
async function install(repo: string, identifier = "JRF-404") {
  const kitDir = mkdtempSync(join(tmpdir(), "wm-kit-"));
  const { cfg, project } = await bouncr();
  const record = newRecord({
    identifier,
    linearId: "l",
    project: "bouncr",
    repo: "api",
    provider: "claude",
    autonomy: "ask-first",
    now: "2026-10-06T10:00:00.000Z",
  });
  record.worktree = {
    id: `r::${repo}`,
    path: repo,
    branch: `furoyce/wm-${identifier.toLowerCase()}`,
    baseSha: "abc",
    gitCommonDir: join(repo, ".git"),
    gitdirName: "wm",
  };
  const issue = {
    identifier,
    title: "t",
    description: null,
    url: "u",
    comments: [],
    parent: null,
    children: [],
  };
  const res = await installKit({
    worktreePath: repo,
    kitDir,
    record,
    cfg,
    project,
    issue,
    nonce: "n",
    launch: { model: "m", effort: "max" },
    toolchainPaths: [],
  });
  return { kitDir, hashes: res.hashes, project };
}

describe("installKit", () => {
  test("writes kit files, excludes them from git, writes install policy, hashes the integrity set", async () => {
    const repo = await gitRepo();
    const kitDir = mkdtempSync(join(tmpdir(), "wm-kit-"));
    const cfg = await loadConfig("config/projects.yaml");
    const record = newRecord({
      identifier: "JRF-404",
      linearId: "l",
      project: "bouncr",
      repo: "api",
      provider: "claude",
      autonomy: "ask-first",
      now: "2026-10-06T10:00:00.000Z",
    });
    record.worktree = {
      id: `r::${repo}`,
      path: repo,
      branch: "furoyce/wm-jrf-404",
      baseSha: "abc",
      gitCommonDir: join(repo, ".git"),
      gitdirName: "wm",
    };
    const project = cfg.projects.bouncr;
    if (!project) throw new Error("bouncr project missing from config");
    const res = await installKit({
      worktreePath: repo,
      kitDir,
      record,
      cfg,
      project,
      issue: {
        identifier: "JRF-404",
        title: "Add leaderboard",
        description: "desc",
        url: "u",
        comments: [],
        parent: null,
        children: [],
      },
      nonce: "n0nce",
      launch: { model: "m", effort: "max" },
      toolchainPaths: [],
    });
    for (const f of [
      ".wingmate/BRIEF.md",
      ".wingmate/PROTOCOL.md",
      ".wingmate/gates.json",
      ".wingmate/launch.json",
      ".wingmate/ticket/description.md",
      ".claude/settings.local.json",
      "api/.npmrc",
      "mobile/.npmrc",
    ])
      expect(existsSync(join(repo, f))).toBe(true);
    expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).toContain(".wingmate/");
    expect(existsSync(join(kitDir, "claude-settings.json"))).toBe(true);
    expect(existsSync(join(kitDir, "gitconfig"))).toBe(true);
    expect(Object.keys(res.hashes)).toContain(".wingmate/PROTOCOL.md");
    expect(await verifyIntegrity(repo, join(repo, ".git"), res.hashes)).toEqual([]);
    writeFileSync(join(repo, "CLAUDE.md"), "injected");
    expect(await verifyIntegrity(repo, join(repo, ".git"), res.hashes)).toEqual(["CLAUDE.md"]);
  });

  test("launch.json, integrity.json, kit dir and install policy carry what spawn, gate and the sandbox need", async () => {
    const repo = await gitRepo();
    const { kitDir, hashes, project } = await install(repo);
    const launch = LaunchSchema.parse(
      JSON.parse(readFileSync(join(repo, ".wingmate", "launch.json"), "utf8")),
    );
    expect(launch).toMatchObject({
      provider: "claude",
      baseSha: "abc",
      commonDir: join(repo, ".git"),
      allowDeps: false,
      verifyCross: true,
      tiers: { claude: { model: "m", effort: "max" } },
    });
    expect(launch.pinnedGates).toEqual(project.repos.api?.gates ?? []);
    expect(launch.forbiddenPaths).toContain(".github/**");
    expect(JSON.parse(readFileSync(join(repo, ".wingmate", "integrity.json"), "utf8"))).toEqual({
      commonDir: join(repo, ".git"),
      hashes,
    });
    expect(Object.keys(hashes)).not.toContain(".wingmate/gates.json");
    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8").split("\n");
    for (const l of [".wingmate/", ".claude/settings.local.json", "/api/.npmrc", "/mobile/.npmrc"])
      expect(exclude).toContain(l);
    expect(readFileSync(join(repo, "api", ".npmrc"), "utf8")).toBe("ignore-scripts=true\n");
    expect(readFileSync(join(kitDir, "gitconfig"), "utf8")).toContain(
      `hooksPath = ${join(kitDir, "no-hooks")}`,
    );
    expect(readFileSync(join(kitDir, "gitconfig"), "utf8")).toContain("[credential]\n\thelper =\n");
    expect(JSON.parse(readFileSync(join(kitDir, "env.json"), "utf8"))).toEqual(agentEnv(kitDir));
    const settings = JSON.parse(readFileSync(join(kitDir, "claude-settings.json"), "utf8")) as {
      sandbox: { network: { strictAllowlist: boolean } };
    };
    expect(settings.sandbox.network.strictAllowlist).toBe(true);
    const local = JSON.parse(readFileSync(join(repo, ".claude", "settings.local.json"), "utf8")) as {
      permissions: { deny: string[] };
    };
    expect(local.permissions.deny).toContain("Bash(git push *)");
    expect((await readLocal(repo)).record).toMatchObject({ identifier: "JRF-404", pipelineStage: "intake" });
    expect(existsSync(join(repo, ".git", "hooks", "pre-commit"))).toBe(false);
  });

  test("the verbs' own writes (gates, questions, stage, outbox) never trip the integrity check", async () => {
    const repo = await gitRepo();
    const { hashes } = await install(repo);
    const local = await readLocal(repo);
    local.gates.intake = {
      verdict: "PASS",
      failCount: 0,
      at: "2026-10-06T10:00:00.000Z",
      evidencePath: ".wingmate/evidence/a.md",
      headSha: null,
      note: null,
      method: "loop",
      dispatchId: null,
    };
    local.questions.push({
      id: "01J0000000000000000000QQQ1",
      status: "open",
      askedAt: "2026-10-06T10:00:00.000Z",
    });
    await writeLocal(repo, local);
    writeFileSync(join(repo, ".wingmate", "stage.json"), "{}");
    await writeIntent(repo, { issue: "JRF-404", kind: "note", payload: { text: "x" } });
    expect(await verifyIntegrity(repo, join(repo, ".git"), hashes)).toEqual([]);
  });

  test("integrity detects a tampered protocol, a new hook, and a planted symlink without following it", async () => {
    const repo = await gitRepo();
    const { hashes } = await install(repo, "JRF-405");
    writeFileSync(join(repo, ".wingmate", "PROTOCOL.md"), "tampered");
    writeFileSync(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n");
    symlinkSync("/", join(repo, ".claude", "root"));
    const changed = await verifyIntegrity(repo, join(repo, ".git"), hashes);
    expect(changed).toContain(".wingmate/PROTOCOL.md");
    expect(changed).toContain(".git/hooks/pre-commit");
    expect(changed).toContain(".claude/root");
    expect(changed.some((c) => c.startsWith(".claude/root/"))).toBe(false);
  });

  test("git's own upstream entries in the shared config are ignored; any other config change is reported", async () => {
    const repo = await gitRepo();
    const { hashes } = await install(repo);
    appendFileSync(
      join(repo, ".git", "config"),
      '[branch "wm-jrf-999"]\n\tremote = origin\n\tmerge = refs/heads/main\n',
    );
    expect(await verifyIntegrity(repo, join(repo, ".git"), hashes)).toEqual([]);
    appendFileSync(join(repo, ".git", "config"), "[core]\n\tfsmonitor = /tmp/evil\n");
    expect(await verifyIntegrity(repo, join(repo, ".git"), hashes)).toEqual([".git/config"]);
    expect(
      canonicalGitConfig('[core]\n\tbare = false\n[branch "a"]\n\tremote = o\n[alias]\n\tx = !sh\n'),
    ).toBe("[core]\n\tbare = false\n[alias]\n\tx = !sh");
  });

  test("existing files are merged: settings.local.json keeps its keys, ignore-scripts=false becomes true", async () => {
    const repo = await gitRepo();
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(
      join(repo, ".claude", "settings.local.json"),
      JSON.stringify({ model: "x", permissions: { allow: ["Bash(ls)"], deny: ["Bash(rm -rf *)"] } }),
    );
    mkdirSync(join(repo, "api"), { recursive: true });
    writeFileSync(
      join(repo, "api", ".npmrc"),
      "registry=https://registry.npmjs.org/\nignore-scripts=false\n",
    );
    await install(repo);
    const local = JSON.parse(readFileSync(join(repo, ".claude", "settings.local.json"), "utf8")) as {
      model: string;
      permissions: { allow: string[]; deny: string[] };
    };
    expect(local.model).toBe("x");
    expect(local.permissions.allow).toEqual(["Bash(ls)"]);
    expect(local.permissions.deny).toContain("Bash(rm -rf *)");
    expect(local.permissions.deny).toContain("Bash(git push *)");
    expect(readFileSync(join(repo, "api", ".npmrc"), "utf8")).toBe(
      "registry=https://registry.npmjs.org/\nignore-scripts=true\n",
    );
    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8").split("\n");
    expect(exclude).not.toContain("/api/.npmrc"); // it existed before the kit
    expect(exclude).toContain("/mobile/.npmrc");
  });

  test("an unreadable courtesy settings file fails the install with context; integrity outside git is unverifiable", async () => {
    const repo = await gitRepo();
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude", "settings.local.json"), "{nope");
    await expect(install(repo)).rejects.toThrow(/settings\.local\.json is not valid JSON/);
    const plain = mkdtempSync(join(tmpdir(), "wm-plain-"));
    await expect(verifyIntegrity(plain, join(plain, ".git"), {})).rejects.toThrow(/git status .* failed/);
  });
});
