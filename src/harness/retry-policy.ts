import type { QualityIssue, QualityIssueInput, QualityProfile, QualityStage } from "./quality-protocol";
import { normalizeQualityIssue } from "./quality-protocol";
import type { SuggestedAction } from "./stage-types";
import { dirtyPlanFromIssues, emptyDirtyPlan, mergeDirtyPlans, type DirtyPlan } from "./dirty-plan";
import {
  repairCandidateSchema,
  repairDecisionSchema,
  type RepairCandidate,
  type RepairDecision,
  type RepairPolicyWeights,
} from "./repair-candidate";
import { pronunciationStrategySchema, type PronunciationStrategy } from "../production/tts-routing";

export interface RepairPlan {
  action: SuggestedAction;
  sceneIndexes: number[];
  audioSceneIndexes: number[];
  videoSceneIndexes: number[];
  muxRequired: boolean;
  forceAudioRebuild: boolean;
  forceVideoRebuild: boolean;
  retryable: boolean;
  reason: string;
  dirtyPlan: DirtyPlan;
  candidates: RepairCandidate[];
  decision: RepairDecision;
  pronunciationStrategy?: PronunciationStrategy;
}

function pronunciationStrategyFor(issues: QualityIssue[]): PronunciationStrategy | undefined {
  if (issues.some((issue) => issue.code === "verification_inconclusive")) return "retry-verifier";
  if (issues.some((issue) => issue.code === "audio_pronunciation_mismatch")) return "switch-tts-provider";
  return undefined;
}

const defaultWeights: RepairPolicyWeights = { costWeight: 0.28, latencyWeight: 0.18, riskWeight: 0.24 };

function nonnegativeEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function resolveRepairPolicyWeights(): RepairPolicyWeights {
  return {
    costWeight: nonnegativeEnv("REPAIR_COST_WEIGHT", defaultWeights.costWeight),
    latencyWeight: nonnegativeEnv("REPAIR_LATENCY_WEIGHT", defaultWeights.latencyWeight),
    riskWeight: nonnegativeEnv("REPAIR_RISK_WEIGHT", defaultWeights.riskWeight),
  };
}

const actionEstimates: Record<SuggestedAction, { success: number; cost: number; durationMs: number; risk: number }> = {
  none: { success: 1, cost: 0, durationMs: 0, risk: 0 },
  "check-environment": { success: 0.94, cost: 0.02, durationMs: 60_000, risk: 0.02 },
  remux: { success: 0.84, cost: 0.03, durationMs: 15_000, risk: 0.03 },
  "reconcat-video": { success: 0.78, cost: 0.09, durationMs: 45_000, risk: 0.08 },
  "rerender-scenes": { success: 0.86, cost: 0.34, durationMs: 180_000, risk: 0.24 },
  "resynthesize-audio": { success: 0.88, cost: 0.24, durationMs: 120_000, risk: 0.16 },
  "revise-scenes": { success: 0.76, cost: 0.42, durationMs: 120_000, risk: 0.3 },
  "regenerate-draft": { success: 0.7, cost: 0.72, durationMs: 180_000, risk: 0.58 },
  "switch-template": { success: 0.74, cost: 0.48, durationMs: 210_000, risk: 0.38 },
  "retry-stage": { success: 0.62, cost: 0.08, durationMs: 60_000, risk: 0.1 },
  stop: { success: 1, cost: 0, durationMs: 0, risk: 0 },
};

export function withSuggestedActions(issues: QualityIssueInput[], stage: QualityStage) {
  return issues.map((issue) => normalizeQualityIssue(stage, issue));
}

function uniqueIndexes(values: number[]) {
  return [...new Set(values)].sort((left, right) => left - right);
}

function numericEvidence(issue: QualityIssue, ...keys: string[]) {
  for (const key of keys) {
    const value = issue.evidence[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function evidenceConfidence(issues: QualityIssue[]) {
  const values = issues.map((issue) => numericEvidence(issue, "confidence", "asrConfidence", "evidenceConfidence"))
    .filter((value): value is number => value !== undefined)
    .map((value) => Math.max(0, Math.min(1, value)));
  if (values.length) return values.reduce((sum, value) => sum + value, 0) / values.length;
  return issues.some((issue) => Object.keys(issue.evidence).length > 0) ? 0.78 : 0.62;
}

function calculateUtility(input: Omit<RepairCandidate, "utility">, weights: RepairPolicyWeights, sceneCount: number) {
  const durationPenalty = Math.min(1, input.estimatedDurationMs / 600_000);
  const scopePenalty = sceneCount > 0 ? input.affectedScenes.length / sceneCount : 0;
  return input.expectedSuccess * input.evidenceConfidence
    - weights.costWeight * input.estimatedCost
    - weights.latencyWeight * durationPenalty
    - weights.riskWeight * Math.min(1, input.risk + scopePenalty * 0.25);
}

function makeCandidate(input: {
  action: SuggestedAction;
  issues: QualityIssue[];
  dirtyPlan: DirtyPlan;
  affectedScenes: number[];
  sceneCount: number;
  attempt: number;
  weights: RepairPolicyWeights;
  successAdjustment?: number;
  reasons?: string[];
}) {
  const estimate = actionEstimates[input.action];
  const scope = Math.max(1, input.affectedScenes.length);
  const repeatedAttemptPenalty = Math.max(0, input.attempt - 1) * (input.action === "remux" ? 0.16 : 0.06);
  const candidateWithoutUtility: Omit<RepairCandidate, "utility"> = {
    action: input.action,
    expectedSuccess: Math.max(0.05, Math.min(1, estimate.success + (input.successAdjustment ?? 0) - repeatedAttemptPenalty)),
    estimatedCost: Math.min(1, estimate.cost * (input.affectedScenes.length ? scope : 1)),
    estimatedDurationMs: estimate.durationMs * (input.affectedScenes.length ? scope : 1),
    affectedScenes: uniqueIndexes(input.affectedScenes),
    risk: Math.min(1, estimate.risk + Math.max(0, scope - 1) * 0.04),
    evidenceConfidence: evidenceConfidence(input.issues),
    issueCodes: [...new Set(input.issues.map((issue) => issue.code))].sort(),
    reasons: input.reasons ?? input.issues.map((issue) => issue.code),
    dirtyPlan: input.dirtyPlan,
  };
  return repairCandidateSchema.parse({
    ...candidateWithoutUtility,
    utility: Number(calculateUtility(candidateWithoutUtility, input.weights, input.sceneCount).toFixed(6)),
  });
}

function driftCandidates(issues: QualityIssue[], sceneCount: number, attempt: number, weights: RepairPolicyWeights) {
  const driftIssues = issues.filter((issue) => issue.code === "video_project_duration_drift");
  if (!driftIssues.length) return [];
  const likelySources = driftIssues.map((issue) => issue.evidence.likelySource).filter((value): value is string => typeof value === "string");
  const invalidScenes = uniqueIndexes(driftIssues.flatMap((issue) => {
    const raw = issue.evidence.invalidSceneIndexes;
    return Array.isArray(raw) ? raw.map(Number).filter((value) => Number.isInteger(value) && value >= 0) : [];
  }));
  const remuxPlan = mergeDirtyPlans(emptyDirtyPlan(), {
    ...emptyDirtyPlan(),
    remux: true,
    reasons: driftIssues.map((issue) => ({ code: issue.code, stage: "video" as const, detail: "candidate:remux" })),
  });
  const concatPlan = mergeDirtyPlans(emptyDirtyPlan(), {
    ...emptyDirtyPlan(),
    concatVideo: true,
    remux: true,
    reasons: driftIssues.map((issue) => ({ code: issue.code, stage: "video" as const, detail: "candidate:reconcat-video" })),
  });
  const candidates = [
    makeCandidate({
      action: "remux", issues: driftIssues, dirtyPlan: remuxPlan, affectedScenes: [], sceneCount, attempt, weights,
      successAdjustment: likelySources.includes("mux") ? 0.12
        : likelySources.some((source) => source.includes("concat")) ? -0.2
          : likelySources.includes("scene") ? -0.32 : 0,
      reasons: [`likelySource:${likelySources.join(",") || "unknown"}`, "cheapest-nondestructive-repair"],
    }),
    makeCandidate({
      action: "reconcat-video", issues: driftIssues, dirtyPlan: concatPlan,
      affectedScenes: [], sceneCount, attempt, weights,
      successAdjustment: likelySources.some((source) => source.includes("concat")) ? 0.18 : -0.08,
      reasons: [`likelySource:${likelySources.join(",") || "unknown"}`, "reuse-scene-cache-and-rebuild-timeline"],
    }),
  ];
  if (invalidScenes.length) {
    const rerenderPlan = mergeDirtyPlans(emptyDirtyPlan(), {
      ...emptyDirtyPlan(),
      videoSceneIndexes: invalidScenes,
      concatVideo: true,
      remux: true,
      reasons: driftIssues.map((issue) => ({ code: issue.code, stage: "video" as const, detail: `invalid-scenes:${invalidScenes.join(",")}` })),
    });
    candidates.push(makeCandidate({
      action: "rerender-scenes", issues: driftIssues, dirtyPlan: rerenderPlan, affectedScenes: invalidScenes, sceneCount, attempt, weights,
      successAdjustment: 0.12,
      reasons: ["ffprobe-scene-evidence", `invalidScenes:${invalidScenes.join(",")}`],
    }));
  }
  return candidates;
}

export function planRepair(
  stage: QualityStage,
  issues: Array<QualityIssue | QualityIssueInput>,
  profile?: QualityProfile,
  sceneCount?: number,
  attempt = 1,
  weights: RepairPolicyWeights = resolveRepairPolicyWeights(),
): RepairPlan {
  const errors = withSuggestedActions(issues.filter((issue) => issue.severity === "error"
    || (issue.severity === "warning" && Boolean(profile && (profile.blockWarnings || profile.blockingWarningCodes.includes(issue.code))))), stage);
  if (errors.length === 0) {
    const candidate = makeCandidate({ action: "none", issues: [], dirtyPlan: emptyDirtyPlan(), affectedScenes: [], sceneCount: sceneCount ?? 0, attempt, weights, reasons: ["no-blocking-issues"] });
    return {
      action: "none", sceneIndexes: [], audioSceneIndexes: [], videoSceneIndexes: [], muxRequired: false,
      forceAudioRebuild: false, forceVideoRebuild: false, retryable: false, reason: "No blocking issues.", dirtyPlan: emptyDirtyPlan(),
      candidates: [candidate],
      decision: repairDecisionSchema.parse({ selectedAction: "none", selectedCandidateIndex: 0, weights, objective: "expectedSuccess*evidenceConfidence-cost-latency-risk-scope", reason: "No blocking issues." }),
      pronunciationStrategy: undefined,
    };
  }

  const inferredSceneCount = sceneCount ?? Math.max(0, ...errors.map((issue) => (issue.sceneIndex ?? -1) + 1));
  const specialDriftCandidates = driftCandidates(errors, inferredSceneCount, attempt, weights);
  const genericIssues = errors.filter((issue) => issue.code !== "video_project_duration_drift");
  const genericCandidates = [...new Set(genericIssues.map((issue) => issue.repairAction))].map((action) => {
    const actionIssues = genericIssues.filter((issue) => issue.repairAction === action);
    const actionPlan = dirtyPlanFromIssues(actionIssues, inferredSceneCount);
    const affectedScenes = uniqueIndexes(actionIssues.map((issue) => issue.sceneIndex).filter((value): value is number => typeof value === "number"));
    return makeCandidate({ action, issues: actionIssues, dirtyPlan: actionPlan, affectedScenes, sceneCount: inferredSceneCount, attempt, weights });
  });
  const candidates = [...specialDriftCandidates, ...genericCandidates]
    .sort((left, right) => right.utility - left.utility || left.estimatedCost - right.estimatedCost || left.action.localeCompare(right.action));
  const selected = candidates[0] ?? makeCandidate({ action: "stop", issues: errors, dirtyPlan: emptyDirtyPlan(), affectedScenes: [], sceneCount: inferredSceneCount, attempt, weights, reasons: ["no-valid-repair-candidate"] });
  const action = selected.action;
  const dirtyPlan = selected.dirtyPlan;
  const sceneIndexes = ["revise-scenes", "rerender-scenes", "resynthesize-audio"].includes(action) ? selected.affectedScenes : [];
  const reason = `${selected.issueCodes.join(", ") || "repair-required"}; utility=${selected.utility}; ${selected.reasons.join("; ")}`;

  return {
    action,
    sceneIndexes,
    audioSceneIndexes: dirtyPlan.audioSceneIndexes,
    videoSceneIndexes: dirtyPlan.videoSceneIndexes,
    muxRequired: dirtyPlan.remux,
    forceAudioRebuild: dirtyPlan.concatAudio,
    forceVideoRebuild: dirtyPlan.fullRebuild,
    retryable: !["check-environment", "stop", "switch-template", "none"].includes(action),
    reason,
    dirtyPlan,
    candidates,
    decision: repairDecisionSchema.parse({ selectedAction: action, selectedCandidateIndex: 0, weights, objective: "expectedSuccess*evidenceConfidence-cost-latency-risk-scope", reason }),
    pronunciationStrategy: pronunciationStrategySchema.optional().parse(pronunciationStrategyFor(errors)),
  };
}
