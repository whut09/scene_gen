import { createHash } from "node:crypto";
import type { QualityEvaluation, QualityIssue } from "./quality-protocol";
import type { RunJournal } from "./run-journal";
import type { LoopAudit } from "./loop-engineering";
import type { SuggestedAction } from "./stage-types";

export type LoopStrategyId =
  | "local-evidence-constraints"
  | "alternate-revision-prompt"
  | "alternate-template-variant"
  | "alternate-provider"
  | "widen-dirty-scope"
  | "global-replan"
  | "human-review";

export interface LoopStrategyTrace {
  id: string;
  iteration: number;
  stage: "draft" | "audio" | "video";
  strategyId: LoopStrategyId;
  promptStrategy: "default" | "evidence-constrained" | "counterexample-first";
  templateStrategy: "keep" | "alternate-variant";
  providerStrategy: "keep" | "fallback";
  providerId?: string;
  templateSelections: Array<{ sceneIndex: number; templateId: string; variantId: string }>;
  repairAction: SuggestedAction;
  issueCodes: string[];
  issueEvidenceSignature: string;
  scoreBefore?: number;
  scoreAfter?: number;
  affectedScenes: number[];
  outcome: "pending" | "improved" | "no-progress" | "failed";
  observedSuccess?: boolean;
  actualSuccessRate: number;
  startedAt: string;
  completedAt?: string;
}

export interface LoopBudgetLimits {
  maxLlmTokens: number;
  maxTtsRebuilds: number;
  maxRenderMinutes: number;
  maxEstimatedCost: number;
  maxRepairsPerIssue: number;
}

export interface LoopBudgetUsage {
  llmTokens: number;
  ttsRebuilds: number;
  renderMinutes: number;
  estimatedCost: number;
  repairsByIssue: Record<string, number>;
}

export interface LoopBudgetStatus {
  limits: LoopBudgetLimits;
  usage: LoopBudgetUsage;
  exceeded: string[];
  allowed: boolean;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stableValue(child)]));
  return value;
}

export function issueEvidenceSignature(issues: Array<Pick<QualityIssue, "code" | "sceneIndex" | "evidence">>) {
  return createHash("sha256").update(JSON.stringify(stableValue(issues.map((issue) => ({ code: issue.code, sceneIndex: issue.sceneIndex, evidence: issue.evidence }))))).digest("hex");
}

export function finalizePendingStrategies(trajectory: LoopStrategyTrace[], stage: LoopStrategyTrace["stage"], evaluation: QualityEvaluation) {
  const signature = issueEvidenceSignature(evaluation.issues);
  const scoreValues = Object.values(evaluation.scores ?? {});
  const scoreAfter = typeof evaluation.metrics.scoreAverage === "number"
    ? evaluation.metrics.scoreAverage
    : scoreValues.length ? scoreValues.reduce((sum, value) => sum + value, 0) / scoreValues.length : undefined;
  let pendingIndex = -1;
  for (let index = trajectory.length - 1; index >= 0; index -= 1) {
    if (trajectory[index].stage === stage && trajectory[index].outcome === "pending") {
      pendingIndex = index;
      break;
    }
  }
  if (pendingIndex < 0) return trajectory;
  const entry = trajectory[pendingIndex];
  const scoreImproved = scoreAfter !== undefined && entry.scoreBefore !== undefined && scoreAfter > entry.scoreBefore + 0.5;
  const improved = signature !== entry.issueEvidenceSignature || scoreImproved || evaluation.passed;
  const updated = [...trajectory];
  updated[pendingIndex] = { ...entry, scoreAfter, outcome: improved ? "improved" : "no-progress", observedSuccess: improved, completedAt: new Date().toISOString() };
  return updated;
}

function strategySuccessRate(trajectory: LoopStrategyTrace[], strategyId: LoopStrategyId, issueCodes: string[]) {
  const comparable = trajectory.filter((entry) => entry.strategyId === strategyId && entry.issueCodes.some((code) => issueCodes.includes(code)) && entry.observedSuccess !== undefined);
  if (!comparable.length) return 0.5;
  return comparable.filter((entry) => entry.observedSuccess).length / comparable.length;
}

export function selectNextLoopStrategy(input: {
  stage: LoopStrategyTrace["stage"];
  iteration: number;
  issues: QualityIssue[];
  repairAction: SuggestedAction;
  affectedScenes: number[];
  trajectory: LoopStrategyTrace[];
  fallbackProviderId?: string;
  templateSelections?: LoopStrategyTrace["templateSelections"];
  scoreBefore?: number;
}) {
  const used = new Set(input.trajectory.filter((entry) => entry.stage === input.stage && entry.issueCodes.some((code) => input.issues.some((issue) => issue.code === code))).map((entry) => entry.strategyId));
  const sequence: LoopStrategyId[] = input.stage === "video"
    ? ["alternate-template-variant", ...(input.fallbackProviderId ? ["alternate-provider" as const] : []), "widen-dirty-scope", "global-replan", "human-review"]
    : input.stage === "audio"
      ? ["local-evidence-constraints", ...(input.fallbackProviderId ? ["alternate-provider" as const] : []), "widen-dirty-scope", "human-review"]
      : ["local-evidence-constraints", "alternate-revision-prompt", ...(input.fallbackProviderId ? ["alternate-provider" as const] : []), "widen-dirty-scope", "global-replan", "human-review"];
  const strategyId = sequence.find((candidate) => !used.has(candidate)) ?? "human-review";
  const issueCodes = [...new Set(input.issues.map((issue) => issue.code))].sort();
  return {
    id: `${input.stage}-${input.iteration}-${strategyId}`,
    iteration: input.iteration,
    stage: input.stage,
    strategyId,
    promptStrategy: strategyId === "local-evidence-constraints" ? "evidence-constrained"
      : strategyId === "alternate-revision-prompt" ? "counterexample-first" : "default",
    templateStrategy: strategyId === "alternate-template-variant" ? "alternate-variant" : "keep",
    providerStrategy: strategyId === "alternate-provider" ? "fallback" : "keep",
    providerId: strategyId === "alternate-provider" ? input.fallbackProviderId : undefined,
    templateSelections: input.templateSelections ?? [],
    repairAction: input.repairAction,
    issueCodes,
    issueEvidenceSignature: issueEvidenceSignature(input.issues),
    scoreBefore: input.scoreBefore,
    affectedScenes: [...new Set(input.affectedScenes)].sort((left, right) => left - right),
    outcome: "pending",
    actualSuccessRate: strategySuccessRate(input.trajectory, strategyId, issueCodes),
    startedAt: new Date().toISOString(),
  } satisfies LoopStrategyTrace;
}

function positiveNumber(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

export function resolveLoopBudgetLimits(args: Record<string, string | boolean>): LoopBudgetLimits {
  return {
    maxLlmTokens: positiveNumber(args["max-llm-tokens"] ?? process.env.HARNESS_MAX_LLM_TOKENS, 120_000),
    maxTtsRebuilds: positiveNumber(args["max-tts-rebuilds"] ?? process.env.HARNESS_MAX_TTS_REBUILDS, 20),
    maxRenderMinutes: positiveNumber(args["max-render-minutes"] ?? process.env.HARNESS_MAX_RENDER_MINUTES, 30),
    maxEstimatedCost: positiveNumber(args["max-estimated-cost"] ?? process.env.HARNESS_MAX_ESTIMATED_COST, 5),
    maxRepairsPerIssue: positiveNumber(args["max-issue-repairs"] ?? process.env.HARNESS_MAX_ISSUE_REPAIRS, 3),
  };
}

export function calculateLoopBudgetUsage(journal: RunJournal, audits: LoopAudit[]): LoopBudgetUsage {
  const repairsByIssue: Record<string, number> = {};
  let estimatedCost = 0;
  for (const audit of audits) {
    const repairedCodes = new Set(audit.reasons
      .filter((reason) => reason.repairAction !== "none")
      .map((reason) => reason.code));
    for (const code of repairedCodes) repairsByIssue[code] = (repairsByIssue[code] ?? 0) + 1;
  }
  for (const stage of journal.stages) {
    if (stage.status !== "succeeded") continue;
    const selected = stage.repairDecision ? stage.repairCandidates?.[stage.repairDecision.selectedCandidateIndex] : undefined;
    estimatedCost += selected?.estimatedCost ?? 0;
  }
  return {
    llmTokens: audits.reduce((sum, audit) => sum + audit.cost.totalTokens, 0),
    ttsRebuilds: journal.stages.filter((stage) => stage.name === "synthesize" && stage.status === "succeeded" && stage.metrics.forcedAudioRebuild === true).reduce((sum, stage) => sum + Number(stage.metrics.generatedSceneCount ?? stage.metrics.generatedAudioSceneCount ?? 0), 0),
    renderMinutes: journal.stages.filter((stage) => stage.name === "render" && stage.status === "succeeded").reduce((sum, stage) => sum + stage.durationMs, 0) / 60_000,
    estimatedCost: Number(estimatedCost.toFixed(4)),
    repairsByIssue,
  };
}

export function evaluateLoopBudget(limits: LoopBudgetLimits, usage: LoopBudgetUsage, currentIssues: Array<Pick<QualityIssue, "code">> = []): LoopBudgetStatus {
  const exceeded: string[] = [];
  if (usage.llmTokens >= limits.maxLlmTokens) exceeded.push("max-llm-tokens");
  if (usage.ttsRebuilds >= limits.maxTtsRebuilds) exceeded.push("max-tts-rebuilds");
  if (usage.renderMinutes >= limits.maxRenderMinutes) exceeded.push("max-render-minutes");
  if (usage.estimatedCost >= limits.maxEstimatedCost) exceeded.push("max-estimated-cost");
  for (const code of [...new Set(currentIssues.map((issue) => issue.code))]) {
    if ((usage.repairsByIssue[code] ?? 0) >= limits.maxRepairsPerIssue) exceeded.push(`max-issue-repairs:${code}`);
  }
  return { limits, usage, exceeded, allowed: exceeded.length === 0 };
}
