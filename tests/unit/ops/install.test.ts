// tests/unit/ops/install.test.ts — §4.3 install: the exact automation argv, idempotent create-then-edit, never enabled without a
// passing doctor, views only as the OAuth app (§11.5), credentials 0600; build, hash, link, views and doctor are injected.
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOnlyCtx } from "../../../src/cli/wire";
import { mainCheckoutTarget } from "../../../src/git/trust";
import { readCredentials, writeCredentials } from "../../../src/linear/auth";
import { doctor } from "../../../src/ops/doctor";
import {
  type InstallOptions,
  automationArgs,
  defaultBuild,
  defaultSymlink,
  install,
  precheckCommand,
  readInstallState,
  supportedBuildBun,
} from "../../../src/ops/install";
import { upsertViews, viewDefinitions } from "../../../src/ops/views";
import { WingmateError } from "../../../src/shared/errors";
import { run } from "../../../src/shared/exec";
import { fakeExec } from "../../fakes/fakeExec";
import { world } from "../../sim/harness";

describe("compiled runtime compatibility", () => {
  test("rejects runtimes affected by lost sandbox environment and unknown version output", () => {
    for (const v of ["1.3.9", "1.3.10", "1.4.1", "", "garbage", "1.4.2-canary", "1.4.2\nextra"])
      expect(supportedBuildBun(v)).toBe(false);
    for (const v of ["1.4.2", "1.4.20", "1.5.0", "2.0.0", "1.4.2\n"]) expect(supportedBuildBun(v)).toBe(true);
  });

  test("unsupported compiler changes neither dependencies nor the installed executable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wm-old-compiler-"));
    const output = join(dir, "wingmate");
    writeFileSync(output, "previous executable");
    const calls: string[][] = [];
    await expect(
      defaultBuild(dir, output, async (argv) => {
        calls.push(argv);
        return { code: 0, stdout: "1.3.9\n", stderr: "", timedOut: false, truncated: false };
      }),
    ).rejects.toMatchObject({ code: "bun_unsupported" });
    expect(calls).toEqual([["bun", "--version"]]);
    expect(readFileSync(output, "utf8")).toBe("previous executable");
  });

  test("supported compiler installs atomically with runtime project autoload disabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wm-new-compiler-"));
    const output = join(dir, "wingmate");
    writeFileSync(output, "previous executable");
    const calls: string[][] = [];
    await defaultBuild(dir, output, async (argv) => {
      calls.push(argv);
      if (argv[1] === "build") {
        expect(readFileSync(output, "utf8")).toBe("previous executable");
        const temporary = argv[argv.indexOf("--outfile") + 1];
        if (!temporary) throw new Error("no compiler output argument");
        writeFileSync(temporary, "new executable");
      }
      return {
        code: 0,
        stdout: argv[1] === "--version" ? "1.4.2\n" : "",
        stderr: "",
        timedOut: false,
        truncated: false,
      };
    });
    expect(calls.map((a) => a[1])).toEqual(["--version", "install", "build"]);
    for (const kind of ["dotenv", "bunfig", "tsconfig", "package-json"])
      expect(calls[2]).toContain(`--no-compile-autoload-${kind}`);
    expect(readFileSync(output, "utf8")).toBe("new executable");
    expect(statSync(output).mode & 0o777).toBe(0o755);
  });
});

describe("install", () => {
  test("automation args match §4.3 exactly and stay disabled unless --enable passed doctor", async () => {
    const w = await world();
    const args = automationArgs(
      w.cfg,
      "/Users/me/.local/share/wingmate/bin/wingmate-0.1.0",
      "id:repo-self::/wt/dispatcher",
      false,
    );
    expect(args).toEqual([
      "automations",
      "create",
      "--name",
      "wingmate-dispatcher",
      "--trigger",
      "*/5 * * * *",
      "--workspace",
      "id:repo-self::/wt/dispatcher",
      "--workspace-mode",
      "existing",
      "--fresh-session",
      "--precheck",
      "/Users/me/.local/share/wingmate/bin/wingmate-0.1.0 tick --precheck",
      "--precheck-timeout",
      "240",
      "--missed-run-grace-minutes",
      "10",
      "--timezone",
      w.cfg.defaults.timezone,
      "--provider",
      "codex",
      "--prompt",
      "This automation never runs an agent. If you are reading this, print UNEXPECTED_AGENT_RUN and stop.",
      "--disabled",
    ]);
  });
  test("install is idempotent: create once, edit afterwards; never enables without a passing doctor", async () => {
    const w = await world();
    const o = {
      enable: false,
      repoRoot: process.cwd(),
      version: "0.1.0",
      build: async () => "/tmp/wingmate-0.1.0",
      sha256: async () => "abc",
      symlink: async () => undefined,
      views: async () => [] as string[],
    };
    const a = await install(w.ctx, o);
    expect(w.orca.calls.filter((c) => c.verb === "automationsCreate").length).toBe(1);
    expect(a.automationId).toBe("auto-1");
    w.orca.automations = [
      { id: "auto-1", name: "wingmate-dispatcher", enabled: false, nextRunAt: null, lastRunAt: null },
    ];
    await install(w.ctx, o);
    expect(w.orca.calls.filter((c) => c.verb === "automationsCreate").length).toBe(1);
    expect(w.orca.calls.filter((c) => c.verb === "automationsEdit").length).toBe(1);
    await expect(
      install(w.ctx, {
        ...o,
        enable: true,
        doctor: async () => ({
          ok: false,
          checks: [{ name: "sandbox_probe", ok: false, detail: "x", blocking: true }],
          at: w.ctx.now(),
        }),
      }),
    ).rejects.toThrow(/doctor_failed/);
  });
  test("view definitions carry the pilot project ids, the lifecycle group and the Needs-you label set", async () => {
    const w = await world();
    const [all, needsYou] = viewDefinitions(w.cfg);
    expect(all?.name).toBe("Wingmate");
    expect(needsYou?.name).toBe("Wingmate · Needs you");
    expect(JSON.stringify(all?.filterData)).toContain("0ca67822-6416-447b-b7b2-08ab2a7346dd");
    expect(JSON.stringify(needsYou?.filterData)).toContain("Needs-Human");
    expect(needsYou?.filterData).toMatchObject({ and: expect.any(Array) });
  });
});

const DOCTOR_OK = (at: string) => ({
  ok: true,
  at,
  checks: [{ name: "sandbox_probe", ok: true, detail: "fine", blocking: true }],
});
const base = (over: Partial<InstallOptions> = {}): InstallOptions => ({
  enable: false,
  repoRoot: process.cwd(),
  version: "0.1.0",
  build: async (_wt, out) => out,
  sha256: async () => "abc",
  symlink: async () => undefined,
  ...over,
});
const verbs = (w: { orca: { calls: { verb: string; args: unknown }[] } }, verb: string) =>
  w.orca.calls.filter((c) => c.verb === verb);

describe("install — Task 12 coverage", () => {
  test("the installed precheck pins the loaded file across cwd/env changes and quotes shell metacharacters literally", async () => {
    const w = await world();
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "wm-pinned-config-")));
    const configPath = join(directory, "pilot ' $(touch injected-dollar) `touch injected-backtick` ;.yaml");
    writeFileSync(configPath, "selected trusted config");
    w.ctx.configPath = configPath;
    const otherCwd = join(directory, "another cwd");
    mkdirSync(otherCwd);
    const conflicting = join(otherCwd, "wrong.yaml");
    writeFileSync(conflicting, "wrong inherited config");
    const r = await install(
      w.ctx,
      base({
        build: async (_wt, out) => {
          writeFileSync(
            out,
            '#!/bin/sh\nprintf "%s\\n" "$WINGMATE_CONFIG" "$@"\n/bin/cat "$WINGMATE_CONFIG"\n',
            { mode: 0o755 },
          );
          return out;
        },
      }),
    );
    expect(r.configPath).toBe(configPath);
    expect((await readInstallState(w.dirs))?.configPath).toBe(configPath);
    const command = w.orca.automations[0]?.precheckCommand;
    if (!command) throw new Error("missing generated precheck");
    const executed = await run(["/bin/sh", "-c", command], {
      cwd: otherCwd,
      env: { WINGMATE_CONFIG: conflicting, PATH: "/unrelated-path" },
    });
    expect(executed.code).toBe(0);
    expect(executed.stdout).toBe(`${configPath}\ntick\n--precheck\nselected trusted config`);
    expect(existsSync(join(otherCwd, "injected-dollar"))).toBe(false);
    expect(existsSync(join(otherCwd, "injected-backtick"))).toBe(false);
  });

  test("invalid selected paths refuse before credential, build or automation mutations; legacy receipts retain their precheck", async () => {
    for (const path of [
      "relative.yaml",
      "/tmp/config\n.yaml",
      "/tmp/config\0.yaml",
      "/missing/config.yaml",
    ]) {
      const w = await world();
      w.ctx.configPath = path;
      await expect(
        install(w.ctx, base({ clientId: "synthetic", clientSecret: "synthetic" })),
      ).rejects.toBeInstanceOf(WingmateError);
      expect(w.orca.calls).toEqual([]);
      expect(existsSync(join(w.dirs.config, "credentials.json"))).toBe(false);
      expect(existsSync(join(w.dirs.state, "install.json"))).toBe(false);
    }
    const w = await world();
    w.ctx.configPath = w.root;
    await expect(install(w.ctx, base())).rejects.toMatchObject({ code: "config_missing" });
    expect(w.orca.calls).toEqual([]);
    const legacy = await world();
    const r = await install(legacy.ctx, base());
    expect(r.configPath).toBeUndefined();
    expect((await readInstallState(legacy.dirs))?.configPath).toBeUndefined();
    expect(legacy.orca.automations[0]?.precheckCommand).toBe(`${r.binPath} tick --precheck`);
    for (const path of ["relative.yaml", "/tmp/control\n.yaml", "/tmp/control\0.yaml", "/tmp/../config.yaml"])
      expect(() => precheckCommand(r.binPath, path)).toThrow();
  });
  test("the edit sends the same flags as the create (no verb prefix twice); the binary path is <state>/bin/wingmate-<version>", async () => {
    const w = await world();
    const built: [string, string][] = [];
    const a = await install(
      w.ctx,
      base({
        build: async (wt, out) => {
          built.push([wt, out]);
          return out;
        },
      }),
    );
    expect(a.binPath).toBe(join(w.dirs.bin, "wingmate-0.1.0"));
    expect(built[0]?.[1]).toBe(a.binPath);
    const create = verbs(w, "automationsCreate")[0]?.args as string[];
    expect(create.slice(0, 2)).toEqual(["--name", "wingmate-dispatcher"]);
    expect(create).toContain("--disabled");
    await install(w.ctx, base());
    const edit = verbs(w, "automationsEdit")[0]?.args as { id: string; args: string[] };
    expect(edit.id).toBe("auto-1");
    expect(edit.args).toEqual(create);
    const row = w.orca.automations[0];
    expect(row).toMatchObject({
      name: "wingmate-dispatcher",
      enabled: false,
      workspaceMode: "existing",
      precheckCommand: `${a.binPath} tick --precheck`,
    });
    expect(w.orca.automations.length).toBe(1);
  });

  test("the dispatcher worktree wingmate-dispatcher is created once from origin/main with no issue, then reused", async () => {
    const w = await world();
    await install(w.ctx, base());
    await install(w.ctx, base());
    const creates = verbs(w, "worktreeCreate");
    expect(creates.length).toBe(1);
    expect(creates[0]?.args).toEqual({
      repoId: "repo-self",
      name: "wingmate-dispatcher",
      baseBranch: "origin/main",
      linearIssue: "",
      comment: "wingmate dispatcher (long-lived)",
    });
    const state = await readInstallState(w.dirs);
    const row = [...w.orca.rows.values()].find((r) => r.displayName === "wingmate-dispatcher");
    expect(state?.worktreeId).toBe(row?.worktreeId);
    const ws = (verbs(w, "automationsCreate")[0]?.args as string[]).indexOf("--workspace");
    expect((verbs(w, "automationsCreate")[0]?.args as string[])[ws + 1]).toBe(`id:repo-self::${row?.path}`);
  });

  test("a partial fleet read without the dispatcher worktree creates nothing", async () => {
    const w = await world();
    w.orca.partial = true;
    await expect(install(w.ctx, base())).rejects.toThrow(/partial/);
    expect(verbs(w, "worktreeCreate")).toEqual([]);
    expect(verbs(w, "automationsCreate")).toEqual([]);
  });

  test("--enable with a passing doctor enables the automation only after install.json names the new binary", async () => {
    const w = await world();
    const seen: {
      sha: string | undefined;
      automation: string | null | undefined;
      enabled: boolean | undefined;
    }[] = [];
    const a = await install(
      w.ctx,
      base({
        enable: true,
        sha256: async () => "sha-new",
        doctor: async (ctx) => {
          const st = await readInstallState(ctx.dirs);
          seen.push({
            sha: st?.sha256,
            automation: st?.automationId,
            enabled: w.orca.automations[0]?.enabled,
          });
          return DOCTOR_OK(ctx.now());
        },
      }),
    );
    expect(seen).toEqual([{ sha: "sha-new", automation: "auto-1", enabled: false }]);
    expect(a.enabled).toBe(true);
    expect(w.orca.automations[0]?.enabled).toBe(true);
    expect((verbs(w, "automationsEdit").at(-1)?.args as { args: string[] }).args).toEqual(["--enabled"]);
    expect((await readInstallState(w.dirs))?.enabled).toBe(true);
  });

  test("never enabled without a passing doctor: a failing blocking check leaves it disabled, also when it was enabled before", async () => {
    const w = await world();
    await install(w.ctx, base({ enable: true, doctor: async (ctx) => DOCTOR_OK(ctx.now()) }));
    expect(w.orca.automations[0]?.enabled).toBe(true);
    const failing = async (ctx: { now(): string }) => ({
      ok: false,
      at: ctx.now(),
      checks: [{ name: "notify_test", ok: false, detail: "not run", blocking: true }],
    });
    await expect(install(w.ctx, base({ enable: true, doctor: failing }))).rejects.toThrow(/notify_test/);
    expect(w.orca.automations[0]?.enabled).toBe(false);
    expect((await readInstallState(w.dirs))?.enabled).toBe(false);
    // a plain re-install never leaves it enabled either
    await install(w.ctx, base({ enable: true, doctor: async (ctx) => DOCTOR_OK(ctx.now()) }));
    await install(w.ctx, base());
    expect(w.orca.automations[0]?.enabled).toBe(false);
    // a report whose ok is true but that still lists a failing blocking check is no pass
    const inconsistent = async (ctx: { now(): string }) => ({
      ok: true,
      at: ctx.now(),
      checks: [{ name: "sandbox_probe", ok: false, detail: "x", blocking: true }],
    });
    await expect(install(w.ctx, base({ enable: true, doctor: inconsistent }))).rejects.toThrow(
      /doctor_failed/,
    );
    expect(w.orca.automations[0]?.enabled).toBe(false);
  });

  test("a doctor with no token source fails linear_auth, so --enable is refused even when every probe passes", async () => {
    const w = await world();
    let probed = false;
    await expect(
      install(w.ctx, {
        ...base({ enable: true }),
        doctor: (ctx) =>
          doctor(ctx, {
            probes: true,
            exec: fakeExec().exec,
            probe: async () => {
              probed = true;
              return { claude: { ok: true, detail: "x", orcaReachable: true }, codex: null };
            },
          }),
      }),
    ).rejects.toThrow(/linear_auth/);
    expect(probed).toBe(true);
    expect(w.orca.automations[0]?.enabled).toBe(false);
  });

  test("--client-id/--client-secret write credentials.json 0600 in a 0700 directory; a cached token survives only unchanged credentials", async () => {
    const w = await world();
    await install(w.ctx, base({ clientId: "cid", clientSecret: "secret-1" }));
    const file = join(w.dirs.config, "credentials.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(w.dirs.config).mode & 0o777).toBe(0o700);
    await writeCredentials(w.dirs, {
      clientId: "cid",
      clientSecret: "secret-1",
      token: { accessToken: "tok", expiresAt: "2026-11-01T00:00:00.000Z" },
    });
    await install(w.ctx, base({ clientId: "cid", clientSecret: "secret-1" }));
    expect((await readCredentials(w.dirs)).token?.accessToken).toBe("tok");
    await install(w.ctx, base({ clientId: "cid", clientSecret: "secret-2" }));
    expect(await readCredentials(w.dirs)).toMatchObject({ clientSecret: "secret-2", token: null });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await expect(install(w.ctx, base({ clientId: "only-the-id" }))).rejects.toThrow(/go together/);
  });

  test("saved views are written only with the OAuth app's credentials; a views failure leaves the install standing", async () => {
    const w = await world();
    let calls = 0;
    const views = async () => {
      calls += 1;
      return ["https://linear.app/jrf/view/a", "https://linear.app/jrf/view/b"];
    };
    const without = await install(w.ctx, base({ views }));
    expect(calls).toBe(0);
    expect(without.viewUrls).toEqual([]);
    await writeCredentials(w.dirs, { clientId: "cid", clientSecret: "s" });
    const withApp = await install(w.ctx, base({ views }));
    expect(calls).toBe(1);
    expect(withApp.viewUrls).toEqual(["https://linear.app/jrf/view/a", "https://linear.app/jrf/view/b"]);
    expect((await readInstallState(w.dirs))?.viewUrls).toEqual(withApp.viewUrls);
    const failed = await install(
      w.ctx,
      base({
        views: async () => {
          throw new WingmateError("linear_graphql", "no such field");
        },
      }),
    );
    expect(failed).toMatchObject({ viewsError: "linear_graphql", viewUrls: [] });
    expect(await readInstallState(w.dirs)).not.toBeNull();
  });

  test("install.json holds what §4.3 lists, and a version that is not plain semver is refused before anything is built", async () => {
    const w = await world();
    const a = await install(w.ctx, base());
    const state = await readInstallState(w.dirs);
    expect(Object.keys(state ?? {}).sort()).toEqual(
      [
        "automationId",
        "binPath",
        "enabled",
        "installedAt",
        "sha256",
        "version",
        "viewUrls",
        "worktreeId",
      ].sort(),
    );
    expect(state).toMatchObject({
      automationId: a.automationId,
      binPath: a.binPath,
      sha256: "abc",
      version: "0.1.0",
    });
    let built = false;
    await expect(
      install(
        w.ctx,
        base({
          version: "../../evil",
          build: async (_wt, out) => {
            built = true;
            return out;
          },
        }),
      ),
    ).rejects.toThrow(/version/);
    expect(built).toBe(false);
  });

  test("the default link swaps ~/.local/bin/wingmate atomically to the new binary and never replaces a regular file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wm-link-"));
    const link = join(dir, "bin", "wingmate");
    await defaultSymlink(join(dir, "wingmate-0.1.0"), link);
    expect(readlinkSync(link)).toBe(join(dir, "wingmate-0.1.0"));
    await defaultSymlink(join(dir, "wingmate-0.2.0"), link);
    expect(readlinkSync(link)).toBe(join(dir, "wingmate-0.2.0"));
    const file = join(dir, "bin", "other");
    writeFileSync(file, "the owner's own script");
    await expect(defaultSymlink(join(dir, "wingmate-0.2.0"), file)).rejects.toThrow(/not a symlink/);
    expect(lstatSync(file).isFile()).toBe(true);
  });

  test("viewDefinitions: the board view lists the four Wingmate Lifecycle labels (not Ready) and both views exclude Done/Canceled", async () => {
    const w = await world();
    const [all, needsYou] = viewDefinitions(w.cfg);
    const text = JSON.stringify(all?.filterData);
    for (const n of ["In-Agent", "Needs-Human", "Review-Ready", "Blocked"]) expect(text).toContain(n);
    expect(text).not.toContain('"Ready"');
    expect(JSON.stringify(needsYou?.filterData)).not.toContain("In-Agent");
    for (const v of [all, needsYou])
      expect(JSON.stringify(v?.filterData)).toContain('"nin":["completed","canceled"]');
    for (const p of Object.values(w.cfg.projects)) expect(text).toContain(p.linearProject);
  });
});

describe("install — Task 13 F7 (Ruling R30): core.useReplaceRefs=false in every pilot repository", () => {
  /** `<project>/<repo>` of every configured repository, in config order, with the main checkout the world's Orca lists for it. */
  const pilots = (w: Awaited<ReturnType<typeof world>>) =>
    Object.entries(w.cfg.projects).flatMap(([key, p]) =>
      Object.entries(p.repos).map(([name, repo]) => ({
        repo: `${key}/${name}`,
        orcaRepo: repo.orcaRepo,
        path: join(w.root, "orca", "repos", repo.orcaRepo),
      })),
    );

  test("install sets it in the repository config of each pilot repo's main checkout, writes only when it is not false already, and lists every repo in its result", async () => {
    const w = await world();
    const repos = pilots(w);
    expect(repos.length).toBeGreaterThan(1);
    const first = await install(w.ctx, base());
    expect(first.repoSettings).toEqual(
      repos.map((r) => ({ repo: r.repo, path: r.path, outcome: "set", detail: null })),
    );
    for (const r of repos) expect(w.git.replaceRefsConfig.get(r.path)).toBe(false);
    expect(w.git.configWrites).toEqual(repos.map((r) => r.path));
    const again = await install(w.ctx, base());
    expect(again.repoSettings.map((s) => s.outcome)).toEqual(repos.map(() => "unchanged"));
    // no second write: the common config is in every issue's integrity set (§6.3 step 6)
    expect(w.git.configWrites).toEqual(repos.map((r) => r.path));
    w.git.replaceRefsConfig.set(repos[0]?.path ?? "", true); // set back by hand
    expect((await install(w.ctx, base())).repoSettings[0]?.outcome).toBe("set");
    expect(w.git.replaceRefsConfig.get(repos[0]?.path ?? "")).toBe(false);
  });

  test("a pilot repo without a usable main checkout is listed failed with the reason; install still completes, the automation disabled", async () => {
    const w = await world();
    const [missing, plain, ...rest] = pilots(w);
    if (!missing || !plain) throw new Error("two pilot repos expected");
    w.orca.mains.delete(missing.orcaRepo); // not in Orca's fleet
    w.git.useReplaceRefs = async () => {
      throw new WingmateError("git_failed", "git config failed (3): fatal: bad config line 1");
    };
    const a = await install(w.ctx, base());
    expect(a.repoSettings[0]).toMatchObject({ repo: missing.repo, path: null, outcome: "failed" });
    expect(a.repoSettings[0]?.detail).toContain("main checkout");
    expect(a.repoSettings[1]).toEqual({
      repo: plain.repo,
      path: plain.path,
      outcome: "failed",
      detail: "git_failed",
    });
    expect(a.repoSettings).toHaveLength(2 + rest.length);
    expect(a.enabled).toBe(false);
    expect(await readInstallState(w.dirs)).not.toBeNull();
  });

  test("setting it is a write: a read-only context refuses it before git runs", async () => {
    const w = await world();
    const ro = readOnlyCtx(w.ctx);
    const path = pilots(w)[0]?.path ?? "";
    await w.ctx.orca.worktreePs(); // lists the main checkouts (their .git directories are made on listing)
    await expect(ro.git.disableReplaceRefs(await mainCheckoutTarget(path))).rejects.toMatchObject({
      code: "read_only",
    });
    expect(w.git.configWrites).toEqual([]);
  });
});

describe("upsertViews (§11.5, as the app)", () => {
  type Call = { query: string; variables: Record<string, unknown> };
  const gql = (
    existing: { id: string; name: string; slugId: string; shared: boolean; team: { id: string } | null }[],
  ) => {
    const calls: Call[] = [];
    let n = 0;
    return {
      calls,
      g: {
        query: async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
          calls.push({ query, variables });
          if (query.startsWith("query T")) return { teams: { nodes: [{ id: "team-jrf" }] } } as T;
          if (query.startsWith("query V"))
            return { organization: { urlKey: "jrf" }, customViews: { nodes: existing } } as T;
          n += 1;
          if (query.includes("customViewCreate"))
            return { customViewCreate: { success: true, customView: { slugId: `new${n}` } } } as T;
          return { customViewUpdate: { success: true, customView: { slugId: `upd${n}` } } } as T;
        },
      },
    };
  };
  test("creates both shared views for team JRF as the app, then updates them by name; URLs from urlKey and slugId", async () => {
    const w = await world();
    const fresh = gql([]);
    expect(await upsertViews(w.cfg, fresh.g)).toEqual([
      "https://linear.app/jrf/view/new1",
      "https://linear.app/jrf/view/new2",
    ]);
    const creates = fresh.calls.filter((c) => c.query.includes("customViewCreate"));
    expect(creates.map((c) => (c.variables.input as { name: string }).name)).toEqual([
      "Wingmate",
      "Wingmate · Needs you",
    ]);
    expect(creates[0]?.variables.input).toMatchObject({
      teamId: "team-jrf",
      shared: true,
      filterData: viewDefinitions(w.cfg)[0]?.filterData,
    });
    expect(creates.every((c) => !Object.hasOwn(c.variables.input as object, "ownerId"))).toBe(true);
    const again = gql([
      { id: "v1", name: "Wingmate", slugId: "s1", shared: true, team: { id: "team-jrf" } },
      { id: "v2", name: "Wingmate · Needs you", slugId: "s2", shared: true, team: { id: "team-jrf" } },
      { id: "v3", name: "Wingmate", slugId: "s3", shared: false, team: null }, // someone's personal view: never touched
    ]);
    await upsertViews(w.cfg, again.g);
    const updates = again.calls.filter((c) => c.query.includes("customViewUpdate"));
    expect(updates.map((c) => c.variables.id)).toEqual(["v1", "v2"]);
    expect(again.calls.some((c) => c.query.includes("customViewCreate"))).toBe(false);
  });
  test("an unexpected response shape is linear_shape; a missing team is linear_team_missing", async () => {
    const w = await world();
    await expect(
      upsertViews(w.cfg, { query: async <T>() => ({ teams: { nodes: [] } }) as T }),
    ).rejects.toMatchObject({ code: "linear_team_missing" });
    await expect(
      upsertViews(w.cfg, {
        query: async <T>(q: string) =>
          (q.startsWith("query T")
            ? { teams: { nodes: [{ id: "t" }] } }
            : { customViews: { nodes: [] } }) as T,
      }),
    ).rejects.toMatchObject({ code: "linear_shape" });
  });
});
