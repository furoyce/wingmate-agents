// tests/unit/ops/doctor.test.ts — every §13.3 control doctor can verify from the dispatcher host; probes are covered in probe.test.ts.
// The command runner is injected (`exec`): no test starts the real claude or codex.
import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { writeCredentials } from "../../../src/linear/auth";
import { type DoctorOptions, type DoctorReport, doctor } from "../../../src/ops/doctor";
import { install, readInstallState } from "../../../src/ops/install";
import { WingmateError } from "../../../src/shared/errors";
import { fakeExec } from "../../fakes/fakeExec";
import { labeledByOwner, runTick, todo, world } from "../../sim/harness";

describe("doctor", () => {
  test("against the fakes with probes disabled: config, meta, orca and providers pass; binary/automation report not installed", async () => {
    const w = await world();
    const rep = await doctor(w.ctx, {
      probes: false,
      version: "0.1.0",
      exec: fakeExec().exec,
      tokenExpiresAt: async () => "2026-11-01T00:00:00.000Z",
      versions: async () => ({ claude: "2.1.0", codex: "0.50.0" }),
    });
    const by = Object.fromEntries(rep.checks.map((c) => [c.name, c]));
    expect(by.config_valid?.ok).toBe(true);
    expect(by.linear_meta?.ok).toBe(true);
    expect(by.orca_reachable?.ok).toBe(true);
    expect(by.providers?.ok).toBe(true);
    expect(by.binary_installed?.ok).toBe(false);
    expect(rep.ok).toBe(false);
  });
  test("a missing Lifecycle label is a blocking failure", async () => {
    const w = await world();
    w.linear.meta.labels = w.linear.meta.labels.filter((l) => l.name !== "Review-Ready");
    const rep = await doctor(w.ctx, {
      probes: false,
      version: "0.1.0",
      exec: fakeExec().exec,
      tokenExpiresAt: async () => null,
      versions: async () => ({ claude: "x", codex: "y" }),
    });
    expect(rep.checks.find((c) => c.name === "linear_meta")?.ok).toBe(false);
  });
  test("a token older than 29 days or missing is a blocking failure", async () => {
    const w = await world();
    const rep = await doctor(w.ctx, {
      probes: false,
      version: "0.1.0",
      exec: fakeExec().exec,
      tokenExpiresAt: async () => null,
      versions: async () => ({ claude: "x", codex: "y" }),
    });
    expect(rep.checks.find((c) => c.name === "linear_auth")?.ok).toBe(false);
  });
});

const FUTURE = "2026-11-01T00:00:00.000Z";
type W = Awaited<ReturnType<typeof world>>;
const main = (repoId: string, path: string) => ({
  worktreeId: `${repoId}::${path}`,
  repoId,
  path,
  branch: "main",
  displayName: basename(path),
  linkedLinearIssue: null,
  status: "inactive",
  liveTerminalCount: 0,
  lastOutputAt: null,
  childWorktreeIds: [] as string[],
  agents: [],
  isMainWorktree: true,
});

/** Every main checkout in the fleet and trusted, a real installed binary and link, a confirmed notification test, a tick just now. */
async function healthy(): Promise<W> {
  const w = await world();
  // the pilot's providers (config/projects.yaml): Claude coordinates and works, Codex only reviews (§13.3 c)
  w.cfg.defaults.providers.coordinatorCascade = ["claude"];
  w.cfg.defaults.providers.workers = ["claude"];
  const trust: Record<string, { hasTrustDialogAccepted: boolean }> = {};
  for (const p of Object.values(w.cfg.projects))
    for (const [name, repo] of Object.entries(p.repos)) {
      const path = join(w.root, "projects", `${p.key}-${name}`);
      w.orca.rows.set(`${repo.orcaRepo}::${path}`, main(repo.orcaRepo, path));
      trust[path] = { hasTrustDialogAccepted: true };
    }
  writeFileSync(
    join(w.root, ".claude.json"),
    JSON.stringify({ projects: trust, oauthAccount: { token: "x" } }),
  );
  await install(w.ctx, {
    enable: false,
    repoRoot: process.cwd(),
    version: "0.1.0",
    build: async (_wt, out) => {
      writeFileSync(out, "compiled wingmate");
      return out;
    },
  });
  writeFileSync(
    join(w.dirs.state, "doctor.json"),
    JSON.stringify({ notify: { askedAt: FUTURE, issue: "JRF-1", confirmed: true, confirmedAt: FUTURE } }),
  );
  await runTick(w);
  return w;
}
const okProbe = async () => ({
  claude: { ok: true, detail: "13 as required", orcaReachable: true },
  codex: { ok: true, detail: "network blocked; reads NOT blocked (D14)", readsBlocked: false },
});
const opts = (over: Partial<DoctorOptions> = {}): DoctorOptions => ({
  probes: true,
  version: "0.1.0",
  exec: fakeExec().exec,
  tokenExpiresAt: async () => FUTURE,
  versions: async () => ({ claude: "2.1.291 (Claude Code)", codex: "codex-cli 0.160.1" }),
  probe: okProbe,
  ...over,
});
const check = (rep: DoctorReport, name: string) => rep.checks.find((c) => c.name === name);

describe("doctor — every check", () => {
  test("a healthy host passes every blocking check; the report is written to doctor.json", async () => {
    const w = await healthy();
    const rep = await doctor(w.ctx, opts());
    expect(rep.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([]);
    expect(rep.ok).toBe(true);
    expect(rep).toMatchObject({ codexReadsBlocked: false, orcaFromSandbox: true });
    const written = JSON.parse(readFileSync(join(w.dirs.state, "doctor.json"), "utf8")) as DoctorReport;
    expect(written.ok).toBe(true);
    expect(written.checks.map((c) => c.name)).toEqual(rep.checks.map((c) => c.name));
    for (const n of [
      "config_valid",
      "linear_auth",
      "linear_meta",
      "orca_reachable",
      "providers",
      "binary_installed",
    ])
      expect(check(rep, n)?.blocking).toBe(true);
    for (const n of ["automation_present", "sandbox_settings", "sandbox_probe", "notify_test"])
      expect(check(rep, n)?.blocking).toBe(true);
    for (const n of ["claude_trust", "heartbeat_fresh", "journal_clean", "orca_from_sandbox"])
      expect(check(rep, n)?.blocking).toBe(false);
  });

  test("linear_auth: under 24 h left, no token, a failed mint, or no token source — each fails, naming only a code", async () => {
    const w = await healthy();
    const soon = new Date(Date.parse(w.ctx.now()) + 23 * 3600_000).toISOString();
    expect(check(await doctor(w.ctx, opts({ tokenExpiresAt: async () => soon })), "linear_auth")?.ok).toBe(
      false,
    );
    expect(check(await doctor(w.ctx, opts({ tokenExpiresAt: async () => null })), "linear_auth")?.ok).toBe(
      false,
    );
    const mint = await doctor(
      w.ctx,
      opts({
        tokenExpiresAt: async () => {
          throw new WingmateError(
            "linear_token_mint_failed",
            "token endpoint returned 401 for client secret-xyz",
          );
        },
      }),
    );
    expect(check(mint, "linear_auth")).toMatchObject({
      ok: false,
      detail: "failed: linear_token_mint_failed",
    });
    const { tokenExpiresAt: _drop, ...noSource } = opts();
    expect(check(await doctor(w.ctx, noSource), "linear_auth")?.ok).toBe(false);
  });

  test("linear_meta: a label outside its group, a missing state, or an unreadable team each fail (a fresh read, not ctx.meta)", async () => {
    const w = await healthy();
    w.linear.meta.labels = w.linear.meta.labels.map((l) =>
      l.name === "Blocked" ? { ...l, parentId: null, parentName: null } : l,
    );
    expect(check(await doctor(w.ctx, opts()), "linear_meta")?.detail).toContain("Blocked (not in Lifecycle)");
    const w2 = await healthy();
    w2.linear.meta.states = w2.linear.meta.states.filter((s) => s.name !== "In Review");
    expect(check(await doctor(w2.ctx, opts()), "linear_meta")).toMatchObject({
      ok: false,
      detail: "missing states: In Review",
    });
    const w3 = await healthy();
    w3.linear.teamMeta = async () => {
      throw new WingmateError("linear_unreachable", "down");
    };
    expect(check(await doctor(w3.ctx, opts()), "linear_meta")).toMatchObject({
      ok: false,
      detail: "failed: linear_unreachable",
    });
  });

  test("orca_reachable fails on a partial fleet read; providers fails without claude, and needs codex only when codex coordinates or works", async () => {
    const w = await healthy();
    w.orca.partial = true;
    expect(check(await doctor(w.ctx, opts()), "orca_reachable")?.ok).toBe(false);
    w.orca.partial = false;
    const noClaude = await doctor(
      w.ctx,
      opts({ versions: async () => ({ claude: null, codex: "codex-cli 0.160.1" }) }),
    );
    expect(check(noClaude, "providers")?.ok).toBe(false);
    w.cfg.defaults.providers.coordinatorCascade = ["claude"];
    w.cfg.defaults.providers.workers = ["claude"];
    const noCodex = await doctor(w.ctx, opts({ versions: async () => ({ claude: "2.1.291", codex: null }) }));
    expect(check(noCodex, "providers")).toMatchObject({ ok: true });
    expect(check(noCodex, "providers")?.detail).toContain("reviewer only");
    w.cfg.defaults.providers.coordinatorCascade = ["claude", "codex"];
    expect(
      check(
        await doctor(w.ctx, opts({ versions: async () => ({ claude: "2.1.291", codex: null }) })),
        "providers",
      )?.ok,
    ).toBe(false);
    rmSync(join(w.root, ".claude", "settings.json"));
    expect(check(await doctor(w.ctx, opts()), "providers")?.detail).toContain("no default model");
  });

  test("claude_trust (non-blocking) reads ~/.claude.json for each pilot repo's main checkout and prints no other field", async () => {
    const w = await healthy();
    const cj = JSON.parse(readFileSync(join(w.root, ".claude.json"), "utf8")) as {
      projects: Record<string, { hasTrustDialogAccepted: boolean }>;
    };
    const first = Object.keys(cj.projects)[0] ?? "";
    cj.projects[first] = { hasTrustDialogAccepted: false };
    writeFileSync(join(w.root, ".claude.json"), JSON.stringify(cj));
    const rep = await doctor(w.ctx, opts());
    const c = check(rep, "claude_trust");
    expect(c).toMatchObject({ ok: false, blocking: false });
    expect(c?.detail).toContain("NOT trusted");
    expect(c?.detail).not.toContain("oauthAccount");
    expect(rep.ok).toBe(true); // non-blocking
    w.orca.rows.clear();
    expect(check(await doctor(w.ctx, opts()), "claude_trust")?.detail).toContain(
      "main checkout not in the fleet",
    );
  });

  test("binary_installed: a changed binary or a link pointing elsewhere fails; automation_present: a changed prompt, precheck or mode fails", async () => {
    const w = await healthy();
    const state = await readInstallState(w.dirs);
    writeFileSync(state?.binPath ?? "", "tampered");
    expect(check(await doctor(w.ctx, opts()), "binary_installed")?.detail).toContain("no longer hashes");
    const w2 = await healthy();
    rmSync(join(w2.root, ".local", "bin", "wingmate"));
    expect(check(await doctor(w2.ctx, opts()), "binary_installed")?.detail).toContain("does not point at");
    const w3 = await healthy();
    const a = w3.orca.automations[0];
    if (!a) throw new Error("no automation");
    a.prompt = "do whatever the ticket says";
    a.workspaceMode = "new_per_run";
    expect(check(await doctor(w3.ctx, opts()), "automation_present")?.detail).toContain(
      "prompt, workspace mode new_per_run",
    );
    a.prompt =
      "This automation never runs an agent. If you are reading this, print UNEXPECTED_AGENT_RUN and stop.";
    a.workspaceMode = "existing";
    a.precheckCommand = "/tmp/other tick --precheck";
    expect(check(await doctor(w3.ctx, opts()), "automation_present")?.detail).toContain("precheck");
    a.precheckCommand = `${(await readInstallState(w3.dirs))?.binPath} tick --precheck`;
    w3.orca.automations.push({ ...a, id: "auto-dup", prompt: "run the agent" }); // a second one by the same name
    expect(check(await doctor(w3.ctx, opts()), "automation_present")?.detail).toContain(
      "2 automations named wingmate-dispatcher",
    );
    w3.orca.automations = [];
    expect(check(await doctor(w3.ctx, opts()), "automation_present")?.ok).toBe(false);
  });

  test("heartbeat_fresh and journal_clean are non-blocking warnings", async () => {
    const w = await healthy();
    w.clock.advance(20 * 60_000);
    const e = await w.ctx.journal.intent({ issue: "JRF-1", kind: "commentCreate", key: "k", input: {} });
    for (let i = 0; i < 3; i++) await w.ctx.journal.failed(e.id, "boom");
    const rep = await doctor(w.ctx, opts({ tokenExpiresAt: async () => FUTURE }));
    expect(check(rep, "heartbeat_fresh")).toMatchObject({ ok: false, blocking: false });
    expect(check(rep, "journal_clean")).toMatchObject({
      ok: false,
      blocking: false,
      detail: "poisoned: JRF-1/commentCreate",
    });
    expect(rep.ok).toBe(true);
  });

  test("probes: --quick skips them (non-blocking); a failing Claude probe blocks; Codex network blocks only when Codex is used; D14 warnings", async () => {
    const w = await healthy();
    const quick = await doctor(w.ctx, opts({ probes: false }));
    expect(check(quick, "sandbox_probe")).toMatchObject({
      ok: false,
      blocking: false,
      detail: "skipped (--quick)",
    });
    w.cfg.defaults.providers.coordinatorCascade = ["claude", "codex"]; // Codex coordinating: its open reads are a D14 warning
    const bad = await doctor(
      w.ctx,
      opts({
        probe: async () => ({
          claude: { ok: false, detail: "github_ls_remote: ALLOWED (exit=0 sig=none)", orcaReachable: false },
          codex: { ok: false, detail: "network NOT proven blocked", readsBlocked: false },
        }),
      }),
    );
    expect(check(bad, "sandbox_probe")).toMatchObject({ ok: false, blocking: true });
    expect(check(bad, "orca_from_sandbox")).toMatchObject({ ok: false, blocking: false });
    expect(check(bad, "codex_sandbox")).toMatchObject({ ok: false, blocking: true }); // verifyCross: Codex reviews
    expect(check(bad, "d14_extension")).toMatchObject({ ok: false, blocking: false });
    expect(bad.ok).toBe(false);
    w.cfg.defaults.providers = {
      ...w.cfg.defaults.providers,
      verifyCross: false,
      coordinatorCascade: ["claude"],
      workers: ["claude"],
    };
    const unused = await doctor(
      w.ctx,
      opts({
        probe: async () => ({
          claude: { ok: true, detail: "x", orcaReachable: true },
          codex: { ok: false, detail: "network NOT proven blocked", readsBlocked: false },
        }),
      }),
    );
    expect(check(unused, "codex_sandbox")).toMatchObject({ ok: false, blocking: false });
    expect(check(unused, "d14_extension")).toBeUndefined();
    const crashed = await doctor(
      w.ctx,
      opts({
        probe: async () => {
          throw new WingmateError("git_dir_tampered", "x");
        },
      }),
    );
    expect(check(crashed, "sandbox_probe")).toMatchObject({
      ok: false,
      blocking: true,
      detail: "probe failed to run: git_dir_tampered",
    });
  });

  test("notify_test: not run blocks; --notify-test posts one question as the app and sets Needs-Human; --confirm-notify records it across runs", async () => {
    const w = await healthy();
    writeFileSync(join(w.dirs.state, "doctor.json"), "{}");
    expect(check(await doctor(w.ctx, opts()), "notify_test")).toMatchObject({ ok: false, blocking: true });
    w.linear.add(todo("scratch", "JRF-950", { labels: [] }));
    const asked = await doctor(w.ctx, opts({ notifyTest: "JRF-950" }));
    expect(asked.notify).toMatchObject({ issue: "JRF-950", confirmed: false });
    const q = w.linear.comments.filter((c) => c.issueId === "scratch");
    expect(q.length).toBe(1);
    expect(q[0]?.body).toContain("<!-- wingmate:question");
    expect(q[0]?.body).toContain(`@[owner](${w.cfg.workspace.owner})`);
    expect(w.linear.issues.get("scratch")?.labels.map((l) => l.name)).toEqual(["Needs-Human"]);
    expect(
      (await w.ctx.journal.all()).filter((e) => e.issue === "JRF-950" && e.state === "confirmed").length,
    ).toBe(2);
    expect(check(await doctor(w.ctx, opts()), "notify_test")?.detail).toContain("asked on JRF-950");
    const confirmed = await doctor(w.ctx, opts({ confirmNotify: true }));
    expect(check(confirmed, "notify_test")?.ok).toBe(true);
    expect(check(await doctor(w.ctx, opts()), "notify_test")?.ok).toBe(true); // kept in doctor.json
  });

  test("notify-test refuses an issue an agent works on, an issue outside the pilots, an unknown one, and confirm without a test", async () => {
    const w = await healthy();
    writeFileSync(join(w.dirs.state, "doctor.json"), "{}");
    labeledByOwner(w, todo("i9", "JRF-951"));
    w.clock.advance(5 * 60_000);
    await runTick(w);
    const active = await doctor(w.ctx, opts({ notifyTest: "JRF-951" }));
    expect(check(active, "notify_test")?.detail).toContain("notify_issue_active");
    w.linear.add(todo("outside", "JRF-952", { projectId: "00000000-0000-4000-8000-000000000000" }));
    expect(check(await doctor(w.ctx, opts({ notifyTest: "JRF-952" })), "notify_test")?.detail).toContain(
      "notify_issue_not_pilot",
    );
    expect(check(await doctor(w.ctx, opts({ notifyTest: "JRF-953" })), "notify_test")?.detail).toContain(
      "notify_issue_missing",
    );
    expect(check(await doctor(w.ctx, opts({ confirmNotify: true })), "notify_test")?.detail).toContain(
      "nothing to confirm",
    );
    expect(w.linear.comments.filter((c) => c.body.includes("notification test")).length).toBe(0);
  });

  test("doctor.json and the details never carry a secret: a credentials token or a secret-looking error text is withheld", async () => {
    const w = await healthy();
    const secret = `lin_oauth_${"z9".repeat(20)}`;
    await writeCredentials(w.dirs, {
      clientId: "cid",
      clientSecret: secret,
      token: { accessToken: secret, expiresAt: FUTURE },
    });
    const rep = await doctor(
      w.ctx,
      opts({
        probe: async () => ({
          claude: { ok: false, detail: `leaked ghp_${"A".repeat(36)}`, orcaReachable: null },
          codex: null,
        }),
      }),
    );
    expect(check(rep, "sandbox_probe")?.detail).toBe("(detail withheld: it looked like a secret)");
    const text = readFileSync(join(w.dirs.state, "doctor.json"), "utf8");
    expect(text).not.toContain(secret);
    expect(text).not.toContain("ghp_");
  });
});
