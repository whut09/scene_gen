import { z } from "zod";
import { repairActionSchema } from "./repair-candidate";
import { issueClassSchema, issueCodeSchema, issueDefinition, issueEvidenceSchema, issueSeveritySchema, normalizeIssueCode, qualityStageSchema, type RepairAction } from "./issue-registry";

export const qualityScoreStatusSchema = z.enum(["measured", "partially-measured", "unavailable", "not-required"]);
export { repairActionSchema } from "./repair-candidate";
export { issueClassSchema, issueCodeSchema, issueEvidenceSchema, issueSeveritySchema, qualityStageSchema } from "./issue-registry";

export const qualityIssueSchema = z.object({
  code: issueCodeSchema,
  stage: qualityStageSchema,
  severity: issueSeveritySchema,
  issueClass: issueClassSchema,
  sceneIndex: z.number().int().nonnegative().optional(),
  evidence: issueEvidenceSchema,
  repairAction: repairActionSchema,
  retryable: z.boolean(),
  message: z.string().min(1),
}).superRefine((issue, context) => {
  const evidence = issueDefinition(issue.code).evidenceSchema.safeParse(issue.evidence);
  if (!evidence.success) context.addIssue({ code: "custom", message: `Invalid evidence for ${issue.code}: ${evidence.error.message}` });
});

export const qualityIssueInputSchema = z.object({
  code: z.string().min(1),
  severity: issueSeveritySchema,
  message: z.string().optional(),
  stage: qualityStageSchema.optional(),
  issueClass: issueClassSchema.optional(),
  sceneIndex: z.number().int().nonnegative().optional(),
  evidence: issueEvidenceSchema.optional(),
  repairAction: repairActionSchema.optional(),
  retryable: z.boolean().optional(),
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
  scoreStatus: qualityScoreStatusSchema.optional(),
  metrics: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});

export type QualityStage = z.infer<typeof qualityStageSchema>;
export type QualityScoreStatus = z.infer<typeof qualityScoreStatusSchema>;
export type QualityIssue = z.infer<typeof qualityIssueSchema>;
export type QualityIssueInput = z.infer<typeof qualityIssueInputSchema>;
export const qualityOutcomeSchema = z.enum(["passed", "failed", "blocked"]);
export type QualityOutcome = z.infer<typeof qualityOutcomeSchema>;
export const qualityProfileSchema = z.object({ name: z.enum(["balanced", "strict", "lenient"]), blockWarnings: z.boolean(), blockingWarningCodes: z.array(z.string()) });
export type QualityProfile = z.infer<typeof qualityProfileSchema>;
export const qualityEvaluationSchema = z.object({ stage: qualityStageSchema, profile: qualityProfileSchema, outcome: qualityOutcomeSchema, passed: z.boolean(), issues: z.array(qualityIssueSchema), revisionNotes: z.array(z.string()), scores: z.record(z.string(), z.number()).optional(), scoreStatus: qualityScoreStatusSchema, metrics: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) });
export type QualityEvaluation = z.infer<typeof qualityEvaluationSchema>;

export function repairActionForIssue(issue: Pick<QualityIssueInput, "code">, _stage: QualityStage): RepairAction {
  return issueDefinition(normalizeIssueCode(issue.code)).repairAction;
}

export function actionIsRetryable(action: RepairAction) {
  return !["none", "check-environment", "stop", "switch-template"].includes(action);
}

export function loadQualityProfile(value = process.env.QUALITY_GATE_PROFILE): QualityProfile {
  const normalized = value?.trim().toLowerCase();
  const name = normalized === "strict" || normalized === "lenient" ? normalized : "balanced";
  return {
    name,
    blockWarnings: name === "strict",
    blockingWarningCodes: (process.env.QUALITY_BLOCKING_WARNING_CODES ?? "").split(",").map((item) => item.trim()).filter(Boolean).map(normalizeIssueCode),
  };
}

export function normalizeQualityIssue(stage: QualityStage, issue: QualityIssueInput): QualityIssue {
  const code = normalizeIssueCode(issue.code);
  const definition = issueDefinition(code);
  const repairAction = issue.repairAction ?? definition.repairAction;
  const issueClass = issue.issueClass ?? definition.issueClass;
  const message = issue.message ?? String(issue.evidence?.summary ?? issue.code);
  const evidence = { ...(issue.evidence ?? { summary: message }), ...(code === "unregistered_issue" ? { originalCode: issue.code } : {}) };
  return qualityIssueSchema.parse({
    ...issue,
    code,
    stage,
    issueClass,
    evidence,
    repairAction,
    retryable: issue.retryable ?? definition.retryable,
    message,
  });
}

export function finalizeQualityEvaluation(input: Omit<QualityEvaluation, "profile" | "outcome" | "passed" | "issues" | "scoreStatus"> & {
  issues: QualityIssueInput[];
  profile?: QualityProfile;
  scoreStatus?: QualityScoreStatus;
}): QualityEvaluation {
  const profile = input.profile ?? loadQualityProfile();
  const issues = input.issues.map((issue) => normalizeQualityIssue(input.stage, issue));
  const environmentBlocked = issues.some((issue) => issue.issueClass === "environment" && issue.severity === "error");
  const hardFailed = issues.some((issue) => issue.issueClass === "hard" && issue.severity === "error");
  const softFailed = issues.some((issue) => issue.issueClass === "soft" && issue.severity === "warning"
    && (profile.blockWarnings || profile.blockingWarningCodes.includes(issue.code)));
  const outcome: QualityOutcome = environmentBlocked ? "blocked" : hardFailed || softFailed ? "failed" : "passed";
  const scoreStatus = input.scoreStatus ?? (input.scores && Object.keys(input.scores).length > 0
    ? "measured"
    : input.stage === "draft" ? "unavailable" : "not-required");
  return { ...input, scoreStatus, profile, outcome, passed: outcome === "passed", issues };
}

export function normalizeStoredQualityEvaluation(value: unknown) {
  const stored = storedEvaluationSchema.parse(value);
  return finalizeQualityEvaluation({
    ...stored,
    issues: stored.issues.map((issue) => {
      const code = normalizeIssueCode(issue.code);
      const evidence = { ...(issue.evidence ?? {}), ...(code === "unregistered_issue" ? { originalCode: issue.code } : {}) };
      return { ...issue, code, evidence, repairAction: issue.repairAction ?? issue.suggestedAction };
    }),
  });
}
