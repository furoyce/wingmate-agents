import type { PipelineStage, WRecord } from "../state/records";

type Timers = {
  intakeMin: number;
  planMin: number;
  planVerifyMin: number;
  implementMin: number;
  validateMin: number;
  uiMin: number;
  securityMin: number;
  prMin: number;
  graceMin: number;
  idleNudgeMin: number;
};

export const capMinFor = (stage: PipelineStage, t: Timers): number =>
  ({
    intake: t.intakeMin,
    plan: t.planMin,
    planVerify: t.planVerifyMin,
    implement: t.implementMin,
    validate: t.validateMin,
    ui: t.uiMin,
    security: t.securityMin,
    pr: t.prMin,
  })[stage];

// §9.6: timers run only while an agent is supposed to be working; parked and paused records never advance (I10).
export function timerState(
  r: WRecord,
  nowIso: string,
  t: Timers,
): "none" | "cap_passed" | "grace_running" | "grace_expired" {
  if (r.stage !== "working" && r.stage !== "claimed") return "none";
  if (r.paused) return "none";
  const now = Date.parse(nowIso);
  if (r.timers.graceEndsAt)
    return now >= Date.parse(r.timers.graceEndsAt) ? "grace_expired" : "grace_running";
  const cap = r.timers.capMin || capMinFor(r.pipelineStage, t);
  return now - Date.parse(r.timers.stageStartedAt) > cap * 60_000 ? "cap_passed" : "none";
}
