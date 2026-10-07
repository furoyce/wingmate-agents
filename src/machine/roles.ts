// Dispatcher-owned role jobs. The outer runner captures stdout before the model's sandbox starts;
// the model gets neither Orca access nor write access to this result directory.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { gitTarget } from "../git/trust";
import type { Intent } from "../kit/intents";
import { readNoFollow, worktreeDir, worktreeFile, writeInWorktree } from "../kit/local";
import { PROMPTS } from "../kit/prompts";
import {
  agentEnv,
  launchCommand,
  roleArgv,
  roleSettingsFile,
  shellQuote,
  userClaudeCredentialEnv,
} from "../kit/settings";
import { resolveTier } from "../policy/providers";
import { availability } from "../policy/quota";
import { WingmateError } from "../shared/errors";
import { newUuid } from "../shared/ids";
import { readText, writeAtomic } from "../state/fs";
import type { WRecord } from "../state/records";
import { type RoleJob, rolePending } from "../state/roles";
import type { Ctx } from "./context";
import { prepareLaunch } from "./launch";
import type { Reconciled } from "./reconcile";
import { saveRecord } from "./save";
import { addAttention, dropAttention } from "./states";

const MAX_OUTPUT = 8 * 1024 * 1024;
const RoleResult = z.object({
  text: z.string(),
  verdict: z.enum(["PASS", "FAIL"]),
  tokens: z.number().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
});
type Result = z.infer<typeof RoleResult>;
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const number = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const tokens = (u: Record<string, unknown>, keys: string[]) => {
  const counts = keys.flatMap((k) => (number(u[k]) === null ? [] : [number(u[k]) as number]));
  return counts.length ? counts.reduce((a, b) => a + b, 0) : null;
};

/** Only a successful final provider response counts. Tool output and intermediate text never prove a verdict. */
export function parseRoleOutput(provider: "claude" | "codex", stdout: string, exit: number): Result | null {
  if (exit !== 0 || Buffer.byteLength(stdout) > MAX_OUTPUT) return null;
  try {
    let text: unknown;
    let count: number | null = null;
    let cost: number | null = null;
    if (provider === "claude") {
      const r = obj(JSON.parse(stdout));
      if (r.type !== "result" || r.subtype !== "success" || r.is_error === true) return null;
      text = r.result;
      count = tokens(obj(r.usage), [
        "input_tokens",
        "output_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
      ]);
      cost = number(r.total_cost_usd);
    } else {
      let completed = false;
      for (const line of stdout.trim().split("\n")) {
        const event = obj(JSON.parse(line));
        if (event.type === "turn.failed" || event.type === "error") return null;
        const item = obj(event.item);
        if (event.type === "item.completed" && item.type === "agent_message") text = item.text;
        if (event.type === "turn.completed") {
          completed = true;
          count = tokens(obj(event.usage), ["input_tokens", "output_tokens"]);
        }
      }
      if (!completed) return null;
    }
    if (typeof text !== "string") return null;
    const verdict = /^(PASS|FAIL)(?:\s|$)/.exec(text)?.[1];
    const result = RoleResult.safeParse({ text, verdict, tokens: count, costUsd: cost });
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function rolePrintArgv(a: Parameters<typeof roleArgv>[0]): string[] {
  const argv = roleArgv(a);
  return a.provider === "claude"
    ? [...argv, "--print", "--output-format", "json"]
    : ["codex", "exec", ...argv.slice(1), "--json", "-"];
}

const PROMPT: Record<RoleJob["role"], keyof typeof PROMPTS> = {
  "plan-verifier": "planVerifier",
  "code-reviewer": "codeReviewer",
  "security-reviewer": "securityReviewer",
  "ui-reviewer": "uiReviewer",
  worker: "worker",
};
export const roleJobDir = (ctx: Ctx, r: WRecord, id: string): string =>
  join(ctx.kitDirFor(r.identifier), "roles", id);
export async function planHash(wt: string): Promise<string | null> {
  const f = await worktreeFile(wt, ".wingmate/plan.md");
  if (!f.ok) return null;
  const bytes = await readNoFollow(f.abs, 64001);
  if (bytes.length > 64000) throw new WingmateError("plan_too_large", "the plan exceeds 64000 bytes");
  return createHash("sha256").update(bytes).digest("hex");
}

/** A replay never creates another terminal. An unknown create remains explicitly unverifiable. */
export async function startRole(
  ctx: Ctx,
  r: WRecord,
  intent: Extract<Intent, { kind: "spawn" }>,
): Promise<void> {
  if (r.roleJobs.some((j) => j.id === intent.id)) return;
  if (r.roleMode !== "terminal-job")
    throw new WingmateError("role_mode", "re-queue this issue to install the dispatcher role protocol");
  if (intent.payload.role === "worker")
    throw new WingmateError(
      "graph_unavailable",
      "the terminal-job fallback uses method loop; only reviewers are launched",
    );
  if (!r.worktree || r.stage !== "working")
    throw new WingmateError("stage_mismatch", "role jobs require a working issue");
  if (r.roleJobs.filter(rolePending).length >= 4)
    throw new WingmateError("roles_busy", "four role jobs are already pending");
  if (r.roleJobs.length >= 128)
    throw new WingmateError("role_limit", "re-queue the issue before requesting more role jobs");
  for (const id of intent.payload.deps) {
    const dep = r.roleJobs.find(
      (j) => j.id === id && j.cycle === r.cycle && j.attempt === r.coordinator.attempt,
    );
    if (!dep)
      throw new WingmateError("dependency_invalid", "a dependency is not a request from this attempt");
    if (rolePending(dep)) throw new WingmateError("roles_busy", "a dependency is still pending");
    if (dep.status !== "succeeded" || dep.verdict !== "PASS")
      throw new WingmateError("dependency_failed", "a dependency did not pass");
  }
  const policy = ctx.cfg.defaults.providers;
  if (intent.payload.prefer)
    throw new WingmateError("provider_not_allowed", "reviewers use the review provider policy");
  const other = r.provider === "claude" ? "codex" : "claude";
  const order = policy.verifyCross ? [other, r.provider] : [r.provider];
  const limits = await ctx.orca.accountList(); // quota is checked at the actual launch, not just at enqueue
  let pick: { provider: "claude" | "codex"; tier: Awaited<ReturnType<typeof resolveTier>> } | null = null;
  for (const provider of order) {
    if (provider !== "claude" && provider !== "codex") continue;
    if (!availability(limits, provider, ctx.cfg.defaults.quota, Date.parse(ctx.now())).available) continue;
    const tier = await resolveTier(provider, { home: ctx.home });
    if (!tier) continue;
    pick = { provider, tier };
    break;
  }
  if (!pick)
    throw new WingmateError(
      "provider_unavailable",
      "no configured role provider has quota and a resolved tier",
    );
  await prepareLaunch(ctx, r);
  const headSha = await ctx.git.revParse(gitTarget(r.worktree), "HEAD");
  const job: RoleJob = {
    id: intent.id,
    mode: "terminal-job",
    role: intent.payload.role,
    cycle: r.cycle,
    attempt: r.coordinator.attempt,
    provider: pick.provider,
    status: "starting",
    launchUncertain: true,
    terminalHandle: null,
    paneKey: null,
    headSha,
    planHash: await planHash(r.worktree.path),
    createdAt: ctx.now(),
    completedAt: null,
    verdict: null,
    reportPath: null,
    reportHash: null,
    notified: false,
  };
  const dir = roleJobDir(ctx, r, job.id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const argv = rolePrintArgv({
    provider: pick.provider,
    role: job.role,
    tier: pick.tier,
    sessionId: newUuid(),
    settingsFile: roleSettingsFile(ctx.kitDirFor(r.identifier), job.role),
    worktreePath: r.worktree.path,
  });
  const prompt = `You are the ${job.role} for ${r.identifier}, Wingmate request ${job.id}. Base SHA: ${r.worktree.baseSha}; input HEAD: ${headSha}.\n${PROMPTS[PROMPT[job.role]]}\n\nThis is a terminal job, NOT an Orca Dispatch. Orca is deliberately unavailable. Do not run Orca lifecycle commands or ask an interactive question. If blocked, report FAIL and explain what is needed. Your final answer MUST begin with PASS or FAIL, followed by findings and validation evidence. Complete this one task and exit.\n\nTask specification:\n${intent.payload.spec}\n`;
  await writeAtomic(join(dir, "prompt.txt"), prompt);
  const q = (name: string) => shellQuote([join(dir, name)]);
  // Redirection belongs to this trusted outer shell, not to a command run by the model.
  const runner = `#!/bin/sh\numask 077\n${shellQuote(argv)} < ${q("prompt.txt")} > ${q("stdout")} 2> ${q("stderr")}\nwingmate_role_exit=$?\ndate -u '%Y-%m-%dT%H:%M:%SZ' > ${q("completed-at")}\nprintf '%s\\n' "$wingmate_role_exit" > ${q("exit.tmp")}\nmv ${q("exit.tmp")} ${q("exit")}\nexit "$wingmate_role_exit"\n`;
  await writeAtomic(join(dir, "runner.sh"), runner);
  r.roleJobs.push(job);
  await saveRecord(ctx, r); // before an uncertain mutation: no duplicate create on replay
  const t = await ctx.orca.terminalCreate(
    r.worktree.id,
    `wingmate ${r.identifier} ${job.role}`,
    launchCommand(
      ["sh", join(dir, "runner.sh")],
      agentEnv(ctx.kitDirFor(r.identifier), job.role, userClaudeCredentialEnv(ctx.home)),
    ),
  );
  Object.assign(job, {
    status: "running",
    launchUncertain: false,
    terminalHandle: t.handle,
    paneKey: `${t.tabId}:${t.leafId}`,
  });
  dropAttention(r, "roles_busy");
  dropAttention(r, "provider_unavailable");
  await saveRecord(ctx, r);
  await ctx.ledger.append({
    at: ctx.now(),
    issue: r.identifier,
    type: "role_started",
    data: {
      requestId: job.id,
      role: job.role,
      provider: job.provider,
      mode: job.mode,
      headSha,
      crossProviderFallback: policy.verifyCross && job.provider !== other,
    },
  });
}

async function mirrorJobs(r: WRecord): Promise<void> {
  if (!r.worktree || !existsSync(r.worktree.path)) return;
  const dir = await worktreeDir(r.worktree.path, ".wingmate", true);
  await writeInWorktree(dir, "roles.json", JSON.stringify(r.roleJobs, null, 2));
}

/** Polling captures files only. No live job is retried or declared successful on absence. */
export async function collectRoles(ctx: Ctx, r: WRecord, rec: Reconciled): Promise<void> {
  if (!r.worktree || !existsSync(r.worktree.path)) return;
  for (const job of r.roleJobs.filter(rolePending)) {
    if (job.cycle !== r.cycle || job.attempt !== r.coordinator.attempt) continue;
    const dir = roleJobDir(ctx, r, job.id);
    const exit = await readText(join(dir, "exit"));
    if (exit === null) {
      const terminals = rec.terminals.get(r.worktree.id) ?? [];
      const own =
        terminals.find((t) => t.handle === job.terminalHandle) ??
        terminals.find((t) => `${t.tabId}:${t.leafId}` === job.paneKey);
      if (own) {
        job.status = "running";
        job.terminalHandle = own.handle;
        job.paneKey = `${own.tabId}:${own.leafId}`;
      } else {
        job.status = "unverifiable";
        addAttention(r, "role_unverifiable");
      }
      continue;
    }
    const size = await stat(join(dir, "stdout"))
      .then((s) => (s.isFile() ? s.size : MAX_OUTPUT + 1))
      .catch(() => MAX_OUTPUT + 1);
    const stdout =
      size <= MAX_OUTPUT ? (await readNoFollow(join(dir, "stdout"), MAX_OUTPUT + 1)).toString("utf8") : "";
    const result = /^\d+\s*$/.test(exit) ? parseRoleOutput(job.provider, stdout, Number(exit)) : null;
    job.status = result ? "succeeded" : "failed";
    job.verdict = result?.verdict ?? "FAIL";
    const completed = (await readText(join(dir, "completed-at")))?.trim();
    const validTime =
      completed &&
      Number.isFinite(Date.parse(completed)) &&
      Date.parse(completed) >= Date.parse(job.createdAt) &&
      Date.parse(completed) <= Date.parse(ctx.now());
    job.completedAt = validTime ? new Date(completed).toISOString() : ctx.now();
    job.reportPath = `.wingmate/evidence/role-${job.id}.md`;
    const text =
      result?.text ??
      "FAIL\nThe role process failed or produced an invalid or oversized final response. Inspect the dispatcher-owned role logs.";
    job.reportHash = createHash("sha256").update(text).digest("hex");
    const evidence = await worktreeDir(r.worktree.path, ".wingmate/evidence", true);
    await writeInWorktree(evidence, `role-${job.id}.md`, text);
    const minutes = Math.max(0, (Date.parse(job.completedAt) - Date.parse(job.createdAt)) / 60000);
    if (!r.usage.bySession.some((s) => s.sessionRef === job.id))
      r.usage.bySession.push({
        role: job.role,
        provider: job.provider,
        sessionRef: job.id,
        tokens: result?.tokens ?? null,
        costUsd: result?.costUsd ?? null,
        agentMinutes: minutes,
        provenance: result?.tokens !== null && result?.tokens !== undefined ? "measured-transcript" : "timed",
      });
    await ctx.ledger.append({
      at: ctx.now(),
      issue: r.identifier,
      type: "role_settled",
      data: {
        requestId: job.id,
        status: job.status,
        verdict: job.verdict,
        exitCode: Number(exit),
      },
    });
  }
  if (!r.roleJobs.some((j) => j.status === "unverifiable")) dropAttention(r, "role_unverifiable");
  // Include the coordinator honestly: no token estimate masquerades as measured usage.
  if (r.coordinator.startedAt) {
    const sessionRef = r.coordinator.sessionId ?? r.coordinator.terminalHandle ?? "coordinator";
    const previous = r.coordinator.usageSampleAt;
    const minutes =
      previous && r.coordinator.usageSampleWorking
        ? Math.max(0, (Date.parse(ctx.now()) - Date.parse(previous)) / 60000)
        : 0;
    const own = r.usage.bySession.find((s) => s.sessionRef === sessionRef);
    if (own) own.agentMinutes += minutes;
    else
      r.usage.bySession.push({
        role: "coordinator",
        provider: r.provider,
        sessionRef,
        tokens: null,
        costUsd: null,
        agentMinutes: minutes,
        provenance: "timed",
      });
    r.coordinator.usageSampleAt = ctx.now();
    r.coordinator.usageSampleWorking = rec.liveness.get(r.identifier) === "working";
  }
  r.usage.agentMinutes = r.usage.bySession.reduce((sum, s) => sum + s.agentMinutes, 0);
  r.usage.tokens =
    r.usage.bySession.length && r.usage.bySession.every((s) => s.tokens !== null)
      ? r.usage.bySession.reduce((sum, s) => sum + (s.tokens ?? 0), 0)
      : null;
  r.usage.costUsd =
    r.usage.bySession.length && r.usage.bySession.every((s) => s.costUsd !== null)
      ? r.usage.bySession.reduce((sum, s) => sum + (s.costUsd ?? 0), 0)
      : null;
  await mirrorJobs(r);
}

/** The trusted record, not agent-writable evidence, proves an independent review at this commit. */
export async function verifyRoleGate(
  ctx: Ctx,
  r: WRecord,
  stage: string,
  requestId: string | null,
  headSha: string | null,
  pinnedHead?: string,
): Promise<void> {
  if (!r.worktree || r.roleMode !== "terminal-job") return;
  const role =
    stage === "planVerify"
      ? "plan-verifier"
      : stage === "validate"
        ? "code-reviewer"
        : stage === "security"
          ? "security-reviewer"
          : null;
  if (!role) return;
  const job = r.roleJobs.find(
    (j) =>
      j.id === requestId && j.role === role && j.cycle === r.cycle && j.attempt === r.coordinator.attempt,
  );
  if (!job || job.status !== "succeeded" || job.verdict !== "PASS")
    throw new WingmateError("review_required", `${stage} requires a settled PASS from ${role}`);
  const report = job.reportPath
    ? await worktreeFile(r.worktree.path, job.reportPath, ".wingmate/evidence")
    : null;
  if (
    !report?.ok ||
    !job.reportHash ||
    createHash("sha256")
      .update(await readNoFollow(report.abs, MAX_OUTPUT + 1))
      .digest("hex") !== job.reportHash
  )
    throw new WingmateError(
      "review_evidence_tampered",
      "the independent review report changed; request a fresh review",
    );
  const current = pinnedHead ?? (await ctx.git.revParse(gitTarget(r.worktree), "HEAD"));
  if (
    job.headSha !== current ||
    headSha !== current ||
    (stage === "planVerify" && job.planHash !== (await planHash(r.worktree.path)))
  )
    throw new WingmateError("review_stale", "the review does not describe this commit or plan");
}
