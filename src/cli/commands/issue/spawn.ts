// src/cli/commands/issue/spawn.ts — `wingmate issue <id> spawn` (§8.1 amended 2026-10-06, §9.1–9.3): the verb that drives Orca
// orchestration. It re-checks the kit, resolves provider and tier, creates the child Run on first use, then launches the role agent
// itself — a terminal in the issue worktree running the role argv with the kit's per-role settings and agentEnv (§13.3 b/c) — waits
// it out (answering the folder-trust dialog, §4.4) and binds that terminal to the Run with `worker-start --terminal`.
//
// Orca 1.4.220 (`orca agent-context --json`): worker-start takes `(--task | --spec)` and `(--agent | --terminal)`; `--model/--effort`
// cannot be combined with `--terminal` (they travel in the role argv instead); "when reusing --terminal, pass --worktree for that
// terminal" — the same `id:<worktreeId>` selector the terminal was created with.
import { join } from "node:path";
import { z } from "zod";
import { IntegrityFileSchema, verifyIntegrity } from "../../../kit/install";
import { writeIntent } from "../../../kit/intents";
import { type Launch, type Local, readLaunch, worktreeFile, writeLocal } from "../../../kit/local";
import { SPAWN_ROLES, type SpawnRole, agentEnv, launchCommand, roleArgv } from "../../../kit/settings";
import { OrcaError } from "../../../orca/cli";
import { OrcaClient } from "../../../orca/client";
import { parseRateLimits } from "../../../orca/fleet";
import { type Availability, availability } from "../../../policy/quota";
import { WingmateError } from "../../../shared/errors";
import { newUuid } from "../../../shared/ids";
import { readText } from "../../../state/fs";
import type { Argv } from "../../index";
import type { OrcaExec, Out, Refuse } from "../issue";

type Deps = { cwd: string; local: Local; id: string; refuse: Refuse; out: Out; exec: OrcaExec };
const PROMPT_FILE: Record<SpawnRole, string> = {
  "plan-verifier": "planVerifier",
  "code-reviewer": "codeReviewer",
  "security-reviewer": "securityReviewer",
  "ui-reviewer": "uiReviewer",
  worker: "worker",
};
/** The providers spawn can launch under the kit (§8.1 amended): Claude with a role settings file, Codex with `codexArgv`. */
type Launchable = "claude" | "codex";
const LAUNCHABLE: readonly string[] = ["claude", "codex"];
const isLaunchable = (p: string): p is Launchable => LAUNCHABLE.includes(p);
const USAGE =
  "spawn --role <plan-verifier|code-reviewer|security-reviewer|ui-reviewer|worker> --spec <file> [--prefer claude|codex] [--worktree current] [--deps <json>] [--dry-run]";
const DepsList = z.array(z.string().min(1));
const NestedRun = z.object({ run: z.object({ id: z.string().min(1) }) });
const FlatRun = z.object({ id: z.string().min(1) });
const WorkerReceipt = z.object({ dispatchId: z.string().min(1), taskId: z.string().min(1).optional() });
type Check =
  | Availability
  | { available: false; reason: "model_unresolved" | "launch_unsupported"; detail: string };
type Tier = { model: string; effort: string };
/** Orca's argv builders, shared with the dispatcher's own launch path (constructing the client calls nothing). */
const ARGV = new OrcaClient().argvFor;
const TRUST_DIALOG = "agent-trust-workspace";
const DOWN = "\x1b[B";

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** §6.3 step 6: `spawn` re-hashes the integrity set immediately before starting a worker. */
async function kitChanges(cwd: string): Promise<string[]> {
  const t = await readText(join(cwd, ".wingmate", "integrity.json"));
  if (t === null)
    throw new WingmateError(
      "kit_integrity_missing",
      ".wingmate/integrity.json is missing",
      "the dispatcher writes it at claim; do not modify .wingmate kit files",
    );
  let raw: unknown;
  try {
    raw = JSON.parse(t);
  } catch (e) {
    throw new WingmateError("local_state_invalid", `.wingmate/integrity.json: ${(e as Error).message}`);
  }
  const p = IntegrityFileSchema.safeParse(raw);
  if (!p.success)
    throw new WingmateError("local_state_invalid", ".wingmate/integrity.json: unexpected shape");
  return verifyIntegrity(cwd, p.data.commonDir, p.data.hashes);
}

/** The child Run: the one already recorded (by `spawn`, `run --id` or the tick's adoption), else `run-create` once. */
async function ensureRun(d: Deps): Promise<string> {
  const existing = d.local.run?.childRunId ?? d.local.record.childRunId;
  if (existing) return existing;
  const raw = await d.exec(["orchestration", "run-create", "--objective", `${d.id} workers`]);
  const nested = NestedRun.safeParse(raw);
  const flat = FlatRun.safeParse(raw);
  const runId = nested.success ? nested.data.run.id : flat.success ? flat.data.id : null;
  if (!runId)
    throw new WingmateError(
      "run_create_failed",
      "run-create returned no run id",
      "orca orchestration run-list --json",
    );
  d.local.run = { childRunId: runId };
  await writeLocal(d.cwd, d.local);
  await writeIntent(d.cwd, { issue: d.id, kind: "run", payload: { runId } });
  return runId;
}

type Plan = { role: SpawnRole; spec: string; deps: string | null; prefer: string | null };

async function readPlan(argv: Argv, d: Deps): Promise<Plan | { refused: number }> {
  const f = (k: string) => (typeof argv.flags[k] === "string" ? (argv.flags[k] as string) : null);
  const role = SPAWN_ROLES.find((r) => r === f("role"));
  const specFile = f("spec");
  const worktree = f("worktree") ?? "current";
  const deps = f("deps");
  const prefer = f("prefer");
  if (!role) return { refused: d.refuse("usage", USAGE) };
  // worker-start takes --task or --spec, never both, so an existing task cannot carry the role header: spawn creates the task
  // itself from --spec (with --deps for a DAG edge) and every role agent reads its prompt first
  if (argv.flags.task !== undefined)
    return {
      refused: d.refuse(
        "task_unsupported",
        "worker-start cannot add the role header to an existing task (it takes --task or --spec, not both)",
        `wingmate issue ${d.id} spawn --role ${role} --spec <file> [--deps '["<taskId>"]'] (worker-start creates the task)`,
      ),
    };
  if (worktree === "new-child")
    return {
      refused: d.refuse(
        "new_child_unsupported",
        "a child worktree would need its own settings file, which only the dispatcher can write into the kit (§8.1)",
        "use --worktree current (the default): graph workers share the issue worktree with exclusive file ownership",
      ),
    };
  if (worktree !== "current" || specFile === null) return { refused: d.refuse("usage", USAGE) };
  if (prefer !== null && (role !== "worker" || !isLaunchable(prefer)))
    return { refused: d.refuse("usage", "--prefer claude|codex applies to --role worker only") };
  if (deps !== null) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(deps);
    } catch {
      parsed = null;
    }
    if (!DepsList.safeParse(parsed).success)
      return { refused: d.refuse("usage", "--deps is a JSON array of task ids") };
  }
  const sf = await worktreeFile(d.cwd, specFile);
  if (!sf.ok) return { refused: d.refuse("spec_invalid", sf.error) };
  return { role, spec: (await readText(sf.abs)) ?? "", deps, prefer };
}

type Pick = { provider: Launchable; tier: Tier | null; fallback: string | null } | { refused: number };

/** §9.1 availability and §9.2 tier: reviewers go to the other provider when `verifyCross`, workers by the project's list. */
async function pickProvider(d: Deps, plan: Plan, launch: Launch): Promise<Pick> {
  const isReview = plan.role !== "worker";
  const other: Launchable = launch.provider === "claude" ? "codex" : "claude";
  const order = isReview
    ? launch.verifyCross
      ? [other, launch.provider]
      : [launch.provider]
    : [...new Set([...(plan.prefer ? [plan.prefer] : []), ...launch.workers])];
  const rl = parseRateLimits({ ok: true, result: await d.exec(["account", "list"]) });
  const blocked = (p: string): Check | null =>
    !isLaunchable(p)
      ? {
          available: false,
          reason: "launch_unsupported",
          detail: "spawn launches only claude and codex under the kit (§8.1)",
        }
      : isReview && !launch.tiers[p] // §9.2: a review provider whose tier best was not resolved at claim
        ? {
            available: false,
            reason: "model_unresolved",
            detail: `no tier best for ${p} in .wingmate/launch.json`,
          }
        : null;
  const checked = order.map((p) => ({ p, a: blocked(p) ?? availability(rl, p, launch.quota, Date.now()) }));
  const why = (p: string) => {
    const a = checked.find((c) => c.p === p)?.a;
    return a && !a.available ? `${a.reason}: ${a.detail}` : "available";
  };
  const provider = checked.find((c) => c.a.available)?.p;
  if (!provider || !isLaunchable(provider))
    return {
      refused: d.refuse(
        "provider_unavailable",
        `none of ${order.join(",")} available (${order.map((p) => `${p} ${why(p)}`).join("; ")})`,
        "wait for quota to reset, or ask the owner",
      ),
    };
  // §9.1 never substitutes silently: a cross-provider review that falls back to the coordinator's provider is reported
  const fallback =
    isReview && launch.verifyCross && provider !== other
      ? `${other} unavailable (${why(other)}); ${plan.role} runs on ${provider}`
      : null;
  return { provider, tier: isReview ? (launch.tiers[provider] ?? null) : null, fallback };
}

/**
 * §4.4's wait, as the dispatcher's own launch does it: tui-idle; on the folder-trust dialog (default option "No, exit") answer Down
 * then Enter once — never the spec — and wait again; still not ready → once more with the longer timeout.
 */
async function waitReady(
  exec: OrcaExec,
  handle: string,
): Promise<{ ready: boolean; blockedReason: string | null }> {
  const wait = async (ms: number) =>
    OrcaClient.mapWait(
      rec(await exec(ARGV.terminalWait(handle, "tui-idle", ms), { timeoutMs: ms + 10_000 })),
    );
  let w = await wait(120_000);
  if (!w.satisfied && w.blockedReason === TRUST_DIALOG) {
    await exec(ARGV.terminalKeys(handle, { text: DOWN }), { timeoutMs: 15_000 });
    await exec(ARGV.terminalKeys(handle, { enter: true }), { timeoutMs: 15_000 });
    w = await wait(120_000);
  }
  if (!w.satisfied) w = await wait(180_000);
  return { ready: w.satisfied, blockedReason: w.blockedReason ?? null };
}

/** Starts the role agent in its own terminal of the issue worktree; a terminal that never gets ready is closed again. */
async function launchRole(
  d: Deps,
  plan: Plan,
  launch: Launch,
  pick: { provider: Launchable; tier: Tier | null },
): Promise<{ handle: string } | { refused: number }> {
  const argv = roleArgv({
    provider: pick.provider,
    role: plan.role,
    tier: pick.tier,
    sessionId: newUuid(),
    settingsFile: launch.roleSettings[plan.role],
    worktreePath: d.cwd,
  });
  const create = ARGV.terminalCreate(
    launch.worktreeId,
    `wingmate ${d.id} ${plan.role}`,
    launchCommand(argv, agentEnv(launch.kitDir)),
  );
  const { handle } = OrcaClient.mapTerminalCreate(rec(await d.exec(create, { timeoutMs: 60_000 })));
  const w = await waitReady(d.exec, handle);
  if (w.ready) return { handle };
  // it never got its task, and the coordinator cannot close terminals: do not leave an idle agent behind
  const closed = await d
    .exec(["terminal", "close", "--terminal", handle], { timeoutMs: 60_000 })
    .then(() => "closed")
    .catch((e: unknown) => `close failed: ${e instanceof Error ? e.message : String(e)}`);
  return {
    refused: d.refuse(
      "spawn_not_ready",
      `the ${pick.provider} ${plan.role} terminal ${handle} never reached tui-idle${w.blockedReason ? ` (${w.blockedReason})` : ""}; ${closed}`,
      "spawn again once; if it stays unready, ask the owner",
    ),
  };
}

export async function spawnVerb(argv: Argv, d: Deps): Promise<number> {
  const plan = await readPlan(argv, d);
  if ("refused" in plan) return plan.refused;
  const launch = await readLaunch(d.cwd);
  const changed = await kitChanges(d.cwd);
  if (changed.length)
    return d.refuse(
      "kit_tampered",
      changed.slice(0, 10).join(","),
      "do not modify the kit; the dispatcher will block the issue",
    );
  const pick = await pickProvider(d, plan, launch);
  if ("refused" in pick) return pick.refused;
  const { provider, tier, fallback } = pick;
  if (argv.flags["dry-run"] === true) {
    d.out({ ok: true, dryRun: true, provider, tier, ...(fallback ? { fallback } : {}) });
    return 0;
  }
  const runId = await ensureRun(d);
  const term = await launchRole(d, plan, launch, pick);
  if ("refused" in term) return term.refused;
  const unconfirmed = `orca orchestration worker-list --run ${runId} --json (check before spawning again)`;
  const header = `Role: ${plan.role} for ${d.id}. Read .wingmate/prompts/${PROMPT_FILE[plan.role]}.md first.\n\n`;
  const args = [
    ...["orchestration", "worker-start", "--run", runId, "--worktree", `id:${launch.worktreeId}`],
    ...["--terminal", term.handle, "--spec", header + plan.spec, "--task-title", `${d.id} ${plan.role}`],
    ...(plan.deps !== null ? ["--deps", plan.deps] : []),
  ];
  let raw: unknown;
  try {
    raw = await d.exec(args, { timeoutMs: 180_000 });
  } catch (e) {
    if (!(e instanceof OrcaError)) throw e;
    // the bind may or may not have happened: leave the terminal alone and say where to look
    return d.refuse(
      "spawn_unconfirmed",
      `worker-start failed (${e.code}: ${e.message.slice(0, 200)}); terminal ${term.handle} may be bound`,
      unconfirmed,
    );
  }
  const r = rec(raw);
  const receipt = WorkerReceipt.safeParse(typeof rec(r.worker).dispatchId === "string" ? r.worker : r);
  if (!receipt.success)
    return d.refuse(
      "spawn_receipt_unparsed",
      `worker-start returned no dispatchId; terminal ${term.handle} may be bound`,
      unconfirmed,
    );
  if (fallback)
    await writeIntent(d.cwd, { issue: d.id, kind: "note", payload: { text: `spawn: ${fallback}` } });
  d.out({
    ok: true,
    provider,
    dispatchId: receipt.data.dispatchId,
    taskId: receipt.data.taskId ?? null,
    terminalHandle: term.handle,
    runId,
    ...(fallback ? { fallback } : {}),
  });
  return 0;
}
