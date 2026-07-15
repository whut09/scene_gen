import { z } from "zod";
import { dirtyPlanSchema } from "./dirty-plan";

export const repairActionSchema = z.enum([
  "none", "regenerate-draft", "revise-scenes", "retry-stage", "check-environment",
  "resynthesize-audio", "remux", "reconcat-video", "rerender-scenes", "switch-template", "stop",
]);

export const repairPolicyWeightsSchema = z.object({
  costWeight: z.number().nonnegative(),
  latencyWeight: z.number().nonnegative(),
  riskWeight: z.number().nonnegative(),
}).strict();

export const repairCandidateSchema = z.object({
  action: repairActionSchema,
  expectedSuccess: z.number().min(0).max(1),
  estimatedCost: z.number().nonnegative(),
  estimatedDurationMs: z.number().nonnegative(),
  affectedScenes: z.array(z.number().int().nonnegative()),
  risk: z.number().min(0).max(1),
  evidenceConfidence: z.number().min(0).max(1),
  utility: z.number(),
  issueCodes: z.array(z.string().min(1)),
  reasons: z.array(z.string()),
  dirtyPlan: dirtyPlanSchema,
}).strict();

export const repairDecisionSchema = z.object({
  selectedAction: repairActionSchema,
  selectedCandidateIndex: z.number().int().nonnegative(),
  weights: repairPolicyWeightsSchema,
  objective: z.literal("expectedSuccess*evidenceConfidence-cost-latency-risk-scope"),
  reason: z.string().min(1),
}).strict();

export type RepairPolicyWeights = z.infer<typeof repairPolicyWeightsSchema>;
export type RepairCandidate = z.infer<typeof repairCandidateSchema>;
export type RepairDecision = z.infer<typeof repairDecisionSchema>;
