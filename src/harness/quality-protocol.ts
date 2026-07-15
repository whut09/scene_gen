import { z } from "zod";
import type { SuggestedAction } from "./stage-types";

export const qualityStageSchema = z.enum(["draft", "audio", "video"]);
export const issueSeveritySchema = z.enum(["warning", "error"]);
export const issueClassSchema = z.enum(["soft", "hard", "environment"]);
export const repairActionSchema = z.enum([
  "none", "regenerate-draft", "revise-scenes", "retry-stage", "check-environment",
  "resynthesize-audio", "remux", "rerender-scenes", "switch-template", "stop",
]);
export const issueEvidenceSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]));

export const qualityIssueSchema = z.object({
  code: z.string().min(1),
  stage: qualityStageSchema,
  severity: issueSeveritySchema,
  issueClass: issueClassSchema,
  sceneIndex: z.number().int().nonnegative().optional(),
  evidence: issueEvidenceSchema,
  repairAction: repairActionSchema,
  retryable: z.boolean(),
  message: z.string().min(1),
});

const storedIssueSchema = z.object({
  code: z.string().min(1),
  severity: issueSeveritySchema,
  message: z.string().optional(),
  stage: qualityStageSchema.optional(),
  issueClass: issueClassSchema.optional(),
  sceneIndex: z.number().int().nonnegative().optional(),
  evidence: issueEvidenceSchema.optional(),
  repairAction: repairActionSchema.optional(),
  retryable: z.boolean().optional(),
  suggestedAction: repairActionSchema.optional(),
});

const storedEvaluationSchema = z.object({
  stage: qualityStageSchema,
  profile: z.object({ name: z.enum(["balanced", "strict", "lenient"]), blockWarnings: z.boolean(), blockingWarningCodes: z.array(z.string()) }).optional(),
  issues: z.array(storedIssueSchema).default([]),
  revisionNotes: z.array(z.string()).default([]),
  scores: z.record(z.string(), z.number()).optional(),
  metrics: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});

export type QualityStage = z.infer<typeof qualityStageSchema>;
export type QualityIssue = z.infer<typeof qualityIssueSchema>;
export type QualityOutcome = "passed" | "failed" | "blocked";

export interface QualityIssueInput {
  code: string;
  severity: "warning" | "error";
  message?: string;
  stage?: QualityStage;
  issueClass?: "soft" | "hard" | "environment";
  sceneIndex?: number;
  evidence?: Record<string, string | number | boolean | string[]>;
  repairAction?: SuggestedAction;
  retryable?: boolean;
}

export interface QualityProfile {
  name: "balanced" | "strict" | "lenient";
  blockWarnings: boolean;
  blockingWarningCodes: string[];
}

export interface QualityEvaluation {
  stage: QualityStage;
  profile: QualityProfile;
  outcome: QualityOutcome;
  passed: boolean;
  issues: QualityIssue[];
  revisionNotes: string[];
  scores?: Record<string, number>;
  metrics: Record<string, number | string | boolean>;
}

const issueActions: Record<string, SuggestedAction> = {
  scene_narration_mismatch: "revise-scenes", scene_narration_overloaded: "revise-scenes",
  scene_extra_numbers: "revise-scenes", scene_source_number_unverified: "revise-scenes",
  briefing_thin: "revise-scenes", chart_thin: "revise-scenes", flow_thin: "revise-scenes",
  outro_thin: "revise-scenes", qualitative_chart_fake_percentage: "revise-scenes",
  parallel_flow_prompt_mismatch: "revise-scenes", github_briefing_template_mismatch: "revise-scenes",
  title_not_spoken_first: "revise-scenes", news_date_not_spoken: "revise-scenes",
  news_date_missing: "regenerate-draft", title_not_chinese_summary: "regenerate-draft",
  audio_title_opening_missing: "revise-scenes", audio_title_incomplete: "revise-scenes",
  duration_out_of_range: "revise-scenes", speech_too_fast: "revise-scenes", speech_too_slow: "revise-scenes",
  segment_speed_uneven: "revise-scenes", segment_speed_variance: "revise-scenes", tts_arabic_digits: "revise-scenes",
  audio_missing: "resynthesize-audio", segment_timing_missing: "resynthesize-audio", audio_scene_drift: "resynthesize-audio",
  asr_verification_failed: "check-environment", judge_unavailable: "check-environment",
  stream_duration_drift: "remux", video_project_duration_drift: "remux",
  blank_frame: "rerender-scenes", stream_missing: "rerender-scenes", wrong_dimensions: "rerender-scenes",
  scene_motion_too_static: "switch-template", video_motion_too_static: "switch-template",
};

const environmentCodes = new Set(["asr_verification_failed", "judge_unavailable", "stage_timeout_or_cancelled"]);

export function repairActionForIssue(issue: Pick<QualityIssueInput, "code" | "sceneIndex">, stage: QualityStage): SuggestedAction {
  if (issueActions[issue.code]) return issueActions[issue.code];
  if (stage === "draft") return issue.sceneIndex === undefined ? "regenerate-draft" : "revise-scenes";
  if (stage === "audio") return issue.sceneIndex === undefined ? "check-environment" : "revise-scenes";
  if (stage === "video") return "rerender-scenes";
  return "stop";
}

export function actionIsRetryable(action: SuggestedAction) {
  return !["none", "check-environment", "stop", "switch-template"].includes(action);
}

export function loadQualityProfile(value = process.env.QUALITY_GATE_PROFILE): QualityProfile {
  const normalized = value?.trim().toLowerCase();
  const name = normalized === "strict" || normalized === "lenient" ? normalized : "balanced";
  return {
    name,
    blockWarnings: name === "strict",
    blockingWarningCodes: (process.env.QUALITY_BLOCKING_WARNING_CODES ?? "").split(",").map((item) => item.trim()).filter(Boolean),
  };
}

export function normalizeQualityIssue(stage: QualityStage, issue: QualityIssueInput): QualityIssue {
  const repairAction = issue.repairAction ?? repairActionForIssue(issue, stage);
  const issueClass = issue.issueClass ?? (environmentCodes.has(issue.code) ? "environment" : issue.severity === "error" ? "hard" : "soft");
  const message = issue.message ?? String(issue.evidence?.summary ?? issue.code);
  return qualityIssueSchema.parse({
    ...issue,
    stage,
    issueClass,
    evidence: issue.evidence ?? { summary: message },
    repairAction,
    retryable: issue.retryable ?? actionIsRetryable(repairAction),
    message,
  });
}

export function finalizeQualityEvaluation(input: Omit<QualityEvaluation, "profile" | "outcome" | "passed" | "issues"> & {
  issues: QualityIssueInput[];
  profile?: QualityProfile;
}): QualityEvaluation {
  const profile = input.profile ?? loadQualityProfile();
  const issues = input.issues.map((issue) => normalizeQualityIssue(input.stage, issue));
  const environmentBlocked = issues.some((issue) => issue.issueClass === "environment" && issue.severity === "error");
  const hardFailed = issues.some((issue) => issue.issueClass === "hard" && issue.severity === "error");
  const softFailed = issues.some((issue) => issue.issueClass === "soft" && issue.severity === "warning"
    && (profile.blockWarnings || profile.blockingWarningCodes.includes(issue.code)));
  const outcome: QualityOutcome = environmentBlocked ? "blocked" : hardFailed || softFailed ? "failed" : "passed";
  return { ...input, profile, outcome, passed: outcome === "passed", issues };
}

export function normalizeStoredQualityEvaluation(value: unknown) {
  const stored = storedEvaluationSchema.parse(value);
  return finalizeQualityEvaluation({
    ...stored,
    issues: stored.issues.map((issue) => ({ ...issue, repairAction: issue.repairAction ?? issue.suggestedAction })),
  });
}
