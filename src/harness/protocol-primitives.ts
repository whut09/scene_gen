import { z } from "zod";

export const qualityStageSchema = z.enum(["draft", "audio", "video"]);
export const issueSeveritySchema = z.enum(["warning", "error"]);
export const issueClassSchema = z.enum(["soft", "hard", "environment"]);
export const issueEvidenceValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);
export const issueEvidenceSchema = z.record(z.string(), issueEvidenceValueSchema);
export const repairActionSchema = z.enum([
  "none", "regenerate-draft", "revise-scenes", "retry-stage", "check-environment",
  "resynthesize-audio", "remux", "reconcat-video", "rerender-scenes", "switch-template", "stop",
]);

export type QualityStage = z.infer<typeof qualityStageSchema>;
export type IssueSeverity = z.infer<typeof issueSeveritySchema>;
export type IssueClass = z.infer<typeof issueClassSchema>;
export type IssueEvidence = z.infer<typeof issueEvidenceSchema>;
export type RepairAction = z.infer<typeof repairActionSchema>;
