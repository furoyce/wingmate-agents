// src/cli/commands/issue/spawn.ts — `wingmate issue <id> spawn` (§8.1, §9.1–9.3): the verb that drives Orca orchestration. It
// re-checks the kit, resolves provider and tier, creates the child Run on first use and starts the worker.
import { join } from "node:path";
import { z } from "zod";
import { IntegrityFileSchema, verifyIntegrity } from "../../../kit/install";
import { writeIntent } from "../../../kit/intents";
import { type Local, readLaunch, worktreeFile, writeLocal } from "../../../kit/local";
import { parseRateLimits } from "../../../orca/fleet";
import { availability } from "../../../policy/quota";
import { WingmateError } from "../../../shared/errors";
import { newUlid } from "../../../shared/ids";
import { readText } from "../../../state/fs";
import type { Argv } from "../../index";
import type { OrcaExec, Out, Refuse } from "../issue";

type Deps = { cwd: string; local: Local; id: string; refuse: Refuse; out: Out; exec: OrcaExec };
const ROLES = ["plan-verifier", "code-reviewer", "security-reviewer", "ui-reviewer", "worker"] as const;
type Role = (typeof ROLES)[number];
const PROMPT_FILE: Record<Role, string> = {
  "plan-verifier": "planVerifier",
  "code-reviewer": "codeReviewer",
  "security-reviewer": "securityReviewer",
  "ui-reviewer": "uiReviewer",
  worker: "worker",
};
const PROVIDERS = ["claude", "codex", "cursor", "antigravity"];
const USAGE =
  "spawn --role <plan-verifier|code-reviewer|security-reviewer|ui-reviewer|worker> (--spec <file> | --task <id>) [--prefer <provider>] [--worktree current|new-child] [--deps <json>] [--dry-run]";
const DepsList = z.array(z.string().min(1));
const NestedRun = z.object({ run: z.object({ id: z.string().min(1) }) });
const FlatRun = z.object({ id: z.string().min(1) });
const WorkerReceipt = z.object({ dispatchId: z.string().min(1), taskId: z.string().min(1).optional() });

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

type Plan = { role: Role; spec: string | null; task: string | null; worktree: string; deps: string | null };

async function readPlan(argv: Argv, d: Deps): Promise<Plan | { refused: number }> {
  const f = (k: string) => (typeof argv.flags[k] === "string" ? (argv.flags[k] as string) : null);
  const role = f("role") as Role | null;
  const specFile = f("spec");
  const task = f("task");
  const worktree = f("worktree") ?? "current";
  const deps = f("deps");
  const prefer = f("prefer");
  if (!role || !ROLES.includes(role) || (specFile === null) === (task === null))
    return {
      refused: d.refuse("usage", USAGE, "pass exactly one of --spec and --task (worker-start takes one)"),
    };
  if (worktree !== "current" && worktree !== "new-child") return { refused: d.refuse("usage", USAGE) };
  if (prefer !== null && (role !== "worker" || !PROVIDERS.includes(prefer)))
    return { refused: d.refuse("usage", `--prefer ${PROVIDERS.join("|")} applies to --role worker only`) };
  if (deps !== null) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(deps);
    } catch {
      parsed = null;
    }
    if (task !== null || !DepsList.safeParse(parsed).success)
      return {
        refused: d.refuse("usage", "--deps is a JSON array of task ids and goes with --spec (a new task)"),
      };
  }
  if (specFile === null) return { role, spec: null, task, worktree, deps: null };
  const sf = await worktreeFile(d.cwd, specFile);
  if (!sf.ok) return { refused: d.refuse("spec_invalid", sf.error) };
  return { role, spec: (await readText(sf.abs)) ?? "", task: null, worktree, deps };
}

export async function spawnVerb(argv: Argv, d: Deps): Promise<number> {
  const plan = await readPlan(argv, d);
  if ("refused" in plan) return plan.refused;
  const prefer = typeof argv.flags.prefer === "string" ? argv.flags.prefer : null;
  const launch = await readLaunch(d.cwd);
  const changed = await kitChanges(d.cwd);
  if (changed.length)
    return d.refuse(
      "kit_tampered",
      changed.slice(0, 10).join(","),
      "do not modify the kit; the dispatcher will block the issue",
    );
  const isReview = plan.role !== "worker";
  const other: "claude" | "codex" = launch.provider === "claude" ? "codex" : "claude";
  const order = isReview
    ? launch.verifyCross
      ? [other, launch.provider]
      : [launch.provider]
    : [...new Set([...(prefer ? [prefer] : []), ...launch.workers])];
  const rl = parseRateLimits({ ok: true, result: await d.exec(["account", "list"]) });
  const checked = order.map((p) => ({ p, a: availability(rl, p, launch.quota, Date.now()) }));
  const why = (p: string) => {
    const a = checked.find((c) => c.p === p)?.a;
    return a && !a.available ? `${a.reason}: ${a.detail}` : "available";
  };
  const provider = checked.find((c) => c.a.available)?.p;
  if (!provider)
    return d.refuse(
      "provider_unavailable",
      `none of ${order.join(",")} available (${order.map((p) => `${p} ${why(p)}`).join("; ")})`,
      "wait for quota to reset, or ask the owner",
    );
  const tier = isReview ? (launch.tiers[provider] ?? null) : null;
  // §9.1 never substitutes silently: a cross-provider review that falls back to the coordinator's provider is reported.
  const fallback =
    isReview && launch.verifyCross && provider !== other
      ? `${other} unavailable (${why(other)}); ${plan.role} runs on ${provider}`
      : null;
  if (argv.flags["dry-run"] === true) {
    d.out({ ok: true, dryRun: true, provider, tier, ...(fallback ? { fallback } : {}) });
    return 0;
  }
  const runId = await ensureRun(d);
  const header = `Role: ${plan.role} for ${d.id}. Read .wingmate/prompts/${PROMPT_FILE[plan.role]}.md first.\n\n`;
  const args = [
    "orchestration",
    "worker-start",
    "--run",
    runId,
    "--worktree",
    plan.worktree,
    "--agent",
    provider,
    ...(plan.task !== null
      ? ["--task", plan.task]
      : ["--spec", header + (plan.spec ?? ""), "--task-title", `${d.id} ${plan.role}`]),
    ...(plan.deps !== null ? ["--deps", plan.deps] : []),
    ...(tier ? ["--model", tier.model, "--effort", tier.effort] : []),
    ...(plan.worktree === "new-child"
      ? ["--name", `wm-${d.id.toLowerCase()}-${plan.role}-${newUlid().slice(-4).toLowerCase()}`]
      : []),
  ];
  const raw = rec(await d.exec(args, { timeoutMs: 180_000 }));
  const receipt = WorkerReceipt.safeParse(typeof rec(raw.worker).dispatchId === "string" ? raw.worker : raw);
  if (!receipt.success)
    return d.refuse(
      "spawn_receipt_unparsed",
      "worker-start returned no dispatchId; the worker may have started",
      `orca orchestration worker-list --run ${runId} --json (check before spawning again)`,
    );
  if (fallback)
    await writeIntent(d.cwd, { issue: d.id, kind: "note", payload: { text: `spawn: ${fallback}` } });
  d.out({
    ok: true,
    provider,
    dispatchId: receipt.data.dispatchId,
    taskId: receipt.data.taskId ?? null,
    runId,
    ...(fallback ? { fallback } : {}),
  });
  return 0;
}
