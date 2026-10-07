// src/ops/doctor.ts — every §13.3 control that can be verified from the dispatcher host, the install's integrity (§4.3) and the live
// sandbox probes (default on; `--quick` skips them). A failing blocking check makes `ok` false, which refuses `install --enable`.
// Details carry identifiers, paths, versions and codes — never a secret, never ticket text — and the report is written to doctor.json.
import { readlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Ctx } from "../machine/context";
import { resolveTier } from "../policy/providers";
import { scanText } from "../policy/secrets";
import type { FleetSnapshot } from "../ports";
import { errorCode } from "../shared/errors";
import { run } from "../shared/exec";
import { readText, writeAtomic } from "../state/fs";
import { readLastTick } from "../state/heartbeat";
import {
  AUTOMATION_NAME,
  AUTOMATION_PROMPT,
  defaultSha256,
  precheckCommand,
  readInstallState,
} from "./install";
import { type NotifyState, notifyTest } from "./notify";
import {
  type ClaudeProbeResult,
  type CodexProbeResult,
  type Runner,
  claudeProbe,
  codexProbe,
  settingsPosture,
  withCanary,
} from "./probe";
import { replaceRefsDisabled } from "./repoSettings";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  blocking: boolean;
}
export interface DoctorReport {
  ok: boolean;
  at: string;
  checks: Check[];
  /** §13.3(c): whether Codex blocked a read outside its worktree (absent when not probed). */
  codexReadsBlocked?: boolean;
  /** D14: whether the `orca` CLI answered from inside the Claude sandbox (absent when not probed). */
  orcaFromSandbox?: boolean;
  notify?: NotifyState;
}
export interface ProbeOutcome {
  claude: ClaudeProbeResult;
  /** null when no Codex CLI is installed (no Codex session can start). */
  codex: CodexProbeResult | null;
}
export interface DoctorOptions {
  probes: boolean;
  /** The running CLI's version, compared with install.json's. */
  version?: string;
  notifyTest?: string;
  confirmNotify?: boolean;
  /** The app token's expiry after a mint when fewer than 24 h remain (§11.1); absent → `linear_auth` fails. */
  tokenExpiresAt?: () => Promise<string | null>;
  versions?: () => Promise<{ claude: string | null; codex: string | null }>;
  /** Runs `claude`/`codex` (versions, the posture check, the probes); tests inject a fake. */
  exec?: Runner;
  /** The checkout doctor runs from (the probe's worktree is made in its repository). */
  cwd?: string;
  /** Replaces the live probes (tests). */
  probe?: (ctx: Ctx) => Promise<ProbeOutcome>;
}

const CADENCE_MS = 5 * 60_000;
const DAY_MS = 24 * 3600_000;
const ClaudeJson = z
  .object({
    projects: z.record(z.object({ hasTrustDialogAccepted: z.boolean().optional() }).passthrough()).optional(),
  })
  .passthrough();
const NotifyZ = z.object({
  askedAt: z.string(),
  issue: z.string(),
  confirmed: z.boolean(),
  confirmedAt: z.string().nullish(),
});
const PrevReport = z.object({ notify: NotifyZ.optional() }).passthrough();

/** A check detail: bounded, and withheld if it ever looks like a secret (error texts can echo what they were given). */
const safe = (detail: string) =>
  scanText(detail).length ? "(detail withheld: it looked like a secret)" : detail.slice(0, 900);

async function cliVersions(exec: Runner): Promise<{ claude: string | null; codex: string | null }> {
  const v = async (bin: string) => {
    const r = await exec([bin, "--version"], { timeoutMs: 20_000 }).catch(() => null);
    return r && r.code === 0 ? (r.stdout.trim().split("\n")[0]?.slice(0, 60) ?? null) : null;
  };
  return { claude: await v("claude"), codex: await v("codex") };
}

const codexUsed = (ctx: Ctx) =>
  ctx.cfg.defaults.providers.verifyCross ||
  ctx.cfg.defaults.providers.coordinatorCascade.includes("codex") ||
  ctx.cfg.defaults.providers.workers.includes("codex");

async function linearMeta(ctx: Ctx): Promise<{ ok: boolean; detail: string }> {
  const tm = await ctx.linear.teamMeta(ctx.cfg.workspace.team);
  const l = ctx.cfg.labels;
  const want: [string, string | null][] = [
    ...[...l.agent.supported, l.agent.human].map((n): [string, string | null] => [n, l.agentGroup]),
    ...l.lifecycle.map((n): [string, string | null] => [n, l.lifecycleGroup]),
    [l.allowDeps, null],
  ];
  const missing = want.filter(([n]) => !tm.labels.some((x) => x.name === n)).map(([n]) => n);
  const misgrouped = want
    .filter(
      ([n, g]) =>
        g !== null &&
        tm.labels.some((x) => x.name === n) &&
        !tm.labels.some((x) => x.name === n && x.parentName === g),
    )
    .map(([n, g]) => `${n} (not in ${g})`);
  const states = ["Todo", "In Progress", "In Review"].filter((n) => !tm.states.some((s) => s.name === n));
  const ok = !missing.length && !misgrouped.length && !states.length;
  return {
    ok,
    detail: ok
      ? `${want.length} labels and the Todo/In Progress/In Review states present`
      : [
          missing.length ? `missing labels: ${missing.join(", ")}` : "",
          misgrouped.length ? `misgrouped: ${misgrouped.join(", ")}` : "",
          states.length ? `missing states: ${states.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("; "),
  };
}

/** R6: Claude's folder-trust answer recorded for each pilot repo's main checkout (`worktree ps` row with `isMainWorktree`). */
async function claudeTrust(ctx: Ctx, fleet: FleetSnapshot | null): Promise<{ ok: boolean; detail: string }> {
  const text = await readText(join(ctx.home, ".claude.json"));
  const cj = ClaudeJson.safeParse(text === null ? {} : JSON.parse(text));
  if (!cj.success) return { ok: false, detail: "~/.claude.json does not parse" };
  const rows: string[] = [];
  let all = true;
  for (const [key, p] of Object.entries(ctx.cfg.projects))
    for (const [name, repo] of Object.entries(p.repos)) {
      const main = fleet?.worktrees.find((w) => w.repoId === repo.orcaRepo && w.isMainWorktree === true);
      if (!main) {
        all = false;
        rows.push(`${key}/${name}: main checkout not in the fleet`);
        continue;
      }
      const trusted = cj.data.projects?.[main.path]?.hasTrustDialogAccepted === true;
      if (!trusted) all = false;
      rows.push(
        `${key}/${name}: ${trusted ? "trusted" : "NOT trusted (the first launch answers the folder-trust dialog)"}`,
      );
    }
  return { ok: all, detail: rows.join("; ") };
}

async function binaryInstalled(
  ctx: Ctx,
  version: string | undefined,
): Promise<{ ok: boolean; detail: string }> {
  const inst = await readInstallState(ctx.dirs);
  if (!inst) return { ok: false, detail: "not installed (no install.json): run `wingmate install`" };
  const sha = await defaultSha256(inst.binPath).catch(() => null);
  if (!sha) return { ok: false, detail: `binary missing at ${inst.binPath}: re-run \`wingmate install\`` };
  if (sha !== inst.sha256)
    return {
      ok: false,
      detail: `${inst.binPath} no longer hashes as install.json says: re-run \`wingmate install\``,
    };
  const link = join(ctx.home, ".local", "bin", "wingmate");
  const [target, real] = await Promise.all([
    realpath(link).catch(() => null),
    realpath(inst.binPath).catch(() => null),
  ]);
  if (!target || target !== real)
    return {
      ok: false,
      detail: `${link} does not point at ${inst.binPath} (${(await readlink(link).catch(() => null)) ?? "missing"}): re-run \`wingmate install\``,
    };
  const skew = version && version !== inst.version ? `; this CLI is ${version}` : "";
  return { ok: true, detail: `${inst.binPath} (${inst.version}) hashes as installed${skew}` };
}

/** §4.3: the live automation against install.json — present, the same id, and its prompt, precheck and workspace mode as written. */
async function automationPresent(ctx: Ctx): Promise<{ ok: boolean; detail: string }> {
  const inst = await readInstallState(ctx.dirs);
  if (!inst) return { ok: false, detail: "not installed" };
  const rows = await ctx.orca.automationsList();
  const a = rows.find((x) => x.id === inst.automationId) ?? rows.find((x) => x.name === AUTOMATION_NAME);
  if (!a) return { ok: false, detail: "automation not found: re-run `wingmate install`" };
  const diffs: string[] = [];
  const named = rows.filter((x) => x.name === AUTOMATION_NAME);
  if (named.length > 1)
    diffs.push(`${named.length} automations named ${AUTOMATION_NAME} (${named.map((x) => x.id).join(", ")})`);
  if (a.id !== inst.automationId)
    diffs.push(`id ${a.id} is not install.json's ${inst.automationId ?? "null"}`);
  if (a.name !== AUTOMATION_NAME) diffs.push("name");
  if (a.prompt != null && a.prompt !== AUTOMATION_PROMPT) diffs.push("prompt");
  if (a.precheckCommand !== undefined && a.precheckCommand !== precheckCommand(inst.binPath))
    diffs.push("precheck");
  if (a.precheckTimeoutSec != null && a.precheckTimeoutSec !== ctx.cfg.defaults.dispatcher.precheckTimeoutSec)
    diffs.push(`precheck timeout ${a.precheckTimeoutSec}`);
  if (a.workspaceMode != null && a.workspaceMode.replace(/-/g, "_") !== "existing")
    diffs.push(`workspace mode ${a.workspaceMode}`);
  return diffs.length
    ? {
        ok: false,
        detail: `automation ${a.id} differs from the install: ${diffs.join(", ")}; re-run \`wingmate install\``,
      }
    : { ok: true, detail: `${a.id} enabled=${a.enabled}` };
}

async function defaultProbe(
  ctx: Ctx,
  exec: Runner,
  cwd: string,
  codexInstalled: boolean,
): Promise<ProbeOutcome> {
  return withCanary(join(ctx.dirs.config, "credentials.json"), async () => ({
    claude: await claudeProbe(ctx, { exec, cwd }),
    codex: codexInstalled ? await codexProbe(ctx, { exec }) : null,
  }));
}

export async function doctor(ctx: Ctx, o: DoctorOptions): Promise<DoctorReport> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, blocking = true) =>
    checks.push({ name, ok, detail: safe(detail), blocking });
  const attempt = async (
    name: string,
    f: () => Promise<{ ok: boolean; detail: string }>,
    blocking = true,
  ) => {
    try {
      const r = await f();
      add(name, r.ok, r.detail, blocking);
    } catch (e) {
      add(name, false, `failed: ${errorCode(e)}`, blocking);
    }
  };
  const exec: Runner = o.exec ?? run;
  const nowMs = Date.parse(ctx.now());
  const repos = Object.values(ctx.cfg.projects).reduce((n, p) => n + Object.keys(p.repos).length, 0);
  add(
    "config_valid",
    true,
    `${Object.keys(ctx.cfg.projects).length} projects, ${repos} repos, team ${ctx.cfg.workspace.team}`,
  );
  await attempt("linear_auth", async () => {
    if (!o.tokenExpiresAt) return { ok: false, detail: "no token source" };
    const exp = await o.tokenExpiresAt();
    if (!exp)
      return {
        ok: false,
        detail:
          "no app token: run `wingmate install --client-id <id> --client-secret -` (the secret on stdin)",
      };
    const left = Date.parse(exp) - nowMs;
    return left >= DAY_MS
      ? { ok: true, detail: `app token valid until ${exp}` }
      : { ok: false, detail: `app token expires ${exp} (less than 24 h left; minting a new one failed)` };
  });
  await attempt("linear_meta", () => linearMeta(ctx));
  let fleet: FleetSnapshot | null = null;
  await attempt("orca_reachable", async () => {
    fleet = await ctx.orca.worktreePs();
    const partial = fleet.truncated || fleet.omittedHostIds.length > 0;
    return {
      ok: !partial,
      detail: partial
        ? `partial fleet read (truncated=${fleet.truncated}; omitted hosts ${fleet.omittedHostIds.join(",") || "none"})`
        : `${fleet.worktrees.length} worktrees`,
    };
  });
  const versions = await (o.versions ?? (() => cliVersions(exec)))();
  await attempt("providers", async () => {
    const tiers = {
      claude: await resolveTier("claude", { home: ctx.home }),
      codex: await resolveTier("codex", { home: ctx.home }),
    };
    const p = ctx.cfg.defaults.providers;
    const needCodex = p.coordinatorCascade.includes("codex") || p.workers.includes("codex");
    const ok = !!tiers.claude && !!versions.claude && (!needCodex || (!!tiers.codex && !!versions.codex));
    return {
      ok,
      detail: `claude ${versions.claude ?? "missing"} → ${tiers.claude?.model ?? "no default model"}; codex ${versions.codex ?? "missing"} → ${tiers.codex?.model ?? "no default model"}${needCodex ? "" : " (reviewer only)"}`,
    };
  });
  await attempt("claude_trust", () => claudeTrust(ctx, fleet), false);
  // R30 (D14): Orca's checkout of a pilot repository must follow no replace ref an agent could plant in the shared git dir
  await attempt("replace_refs_disabled", () => replaceRefsDisabled(ctx, fleet));
  await attempt("binary_installed", () => binaryInstalled(ctx, o.version));
  await attempt("automation_present", () => automationPresent(ctx));
  await attempt(
    "heartbeat_fresh",
    async () => {
      const hb = await readLastTick(ctx.dirs);
      if (!hb) return { ok: false, detail: "no tick yet" };
      const age = nowMs - Date.parse(hb.at);
      return {
        ok: age < 3 * CADENCE_MS,
        detail: `${hb.kind} ${hb.outcome} at ${hb.at} (${Math.round(age / 60_000)} min ago)`,
      };
    },
    false,
  );
  await attempt(
    "journal_clean",
    async () => {
      const poisoned = (await ctx.journal.all()).filter((e) => e.state === "poisoned");
      return {
        ok: poisoned.length === 0,
        detail: poisoned.length
          ? `poisoned: ${poisoned.map((e) => `${e.issue}/${e.kind}`).join(", ")}`
          : "no poisoned entries",
      };
    },
    false,
  );
  await attempt("sandbox_settings", () => settingsPosture(ctx, exec));
  let codexReadsBlocked: boolean | undefined;
  let orcaFromSandbox: boolean | undefined;
  if (!o.probes) add("sandbox_probe", false, "skipped (--quick)", false);
  else {
    let outcome: ProbeOutcome | null = null;
    try {
      outcome = await (
        o.probe ?? ((c: Ctx) => defaultProbe(c, exec, o.cwd ?? process.cwd(), versions.codex !== null))
      )(ctx);
    } catch (e) {
      add("sandbox_probe", false, `probe failed to run: ${errorCode(e)}`);
    }
    if (outcome) {
      add("sandbox_probe", outcome.claude.ok, outcome.claude.detail);
      const reach = outcome.claude.orcaReachable;
      if (reach !== null) orcaFromSandbox = reach;
      add(
        "orca_from_sandbox",
        reach === true,
        reach === true
          ? "reachable: spawn can start workers; D14 residual — an agent can start processes outside the sandbox through Orca"
          : reach === false
            ? "unreachable: `wingmate issue spawn` cannot start workers from the sandbox (R22: dispatcher-executed spawn needed)"
            : "unknown (no result line)",
        false,
      );
      if (outcome.codex === null)
        add("codex_sandbox", true, "codex not installed: no Codex session can start", false);
      else {
        add("codex_sandbox", outcome.codex.ok, outcome.codex.detail, codexUsed(ctx));
        if (outcome.codex.readsBlocked !== null) codexReadsBlocked = outcome.codex.readsBlocked;
        const p = ctx.cfg.defaults.providers;
        if (
          outcome.codex.readsBlocked === false &&
          (p.coordinatorCascade.includes("codex") || p.workers.includes("codex"))
        )
          add(
            "d14_extension",
            false,
            "Codex sessions can read every file of the owner's user, and codex coordinates or works: keep providers to [claude] or record the owner's acceptance (D14)",
            false,
          );
      }
    }
  }
  // §7.5 step 4 and §16.1: the notification test, kept across runs in doctor.json; `install --enable` waits for its confirmation
  const prevText = await readText(join(ctx.dirs.state, "doctor.json")).catch(() => null);
  let notify: NotifyState | undefined;
  try {
    const prev = PrevReport.safeParse(prevText ? JSON.parse(prevText) : {});
    if (prev.success && prev.data.notify)
      notify = { ...prev.data.notify, confirmedAt: prev.data.notify.confirmedAt ?? null };
  } catch {
    notify = undefined; // an unreadable doctor.json starts the notification test afresh
  }
  let notifyNote = "";
  if (o.notifyTest)
    try {
      notify = await notifyTest(ctx, o.notifyTest);
    } catch (e) {
      notifyNote = `the notification test could not be posted: ${errorCode(e)}; `;
    }
  if (o.confirmNotify) {
    if (notify && !notify.confirmed) notify = { ...notify, confirmed: true, confirmedAt: ctx.now() };
    else if (!notify)
      notifyNote += "nothing to confirm: run `wingmate doctor --notify-test <scratch issue>` first; ";
  }
  add(
    "notify_test",
    notify?.confirmed === true,
    notifyNote +
      (notify
        ? notify.confirmed
          ? `confirmed for ${notify.issue} at ${notify.confirmedAt ?? "?"}`
          : `asked on ${notify.issue} at ${notify.askedAt}; run \`wingmate doctor --confirm-notify\` once both notifications arrived`
        : "not run: `wingmate doctor --notify-test <scratch issue>`"),
  );
  const report: DoctorReport = {
    ok: checks.every((c) => c.ok || !c.blocking),
    at: ctx.now(),
    checks,
    ...(codexReadsBlocked === undefined ? {} : { codexReadsBlocked }),
    ...(orcaFromSandbox === undefined ? {} : { orcaFromSandbox }),
    ...(notify ? { notify } : {}),
  };
  await writeAtomic(join(ctx.dirs.state, "doctor.json"), JSON.stringify(report, null, 2));
  return report;
}

/** `install --enable` without an injected doctor: probes on, no token source — so it never passes and never enables. */
export const defaultInstallDoctor = (ctx: Ctx): Promise<DoctorReport> => doctor(ctx, { probes: true });
