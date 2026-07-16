import { z } from "zod";
import { dirtyPlanSchema } from "./dirty-plan";
import { qualityIssueSchema } from "./quality-protocol";
import { repairActionSchema, repairCandidateSchema, repairDecisionSchema } from "./repair-candidate";

export const videoStageOrder = [
  "ingest",
  "draft",
  "draft-gate",
  "revise",
  "synthesize",
  "audio-gate",
  "render",
  "video-gate",
  "publish",
] as const;

export const videoStageNameSchema = z.enum(videoStageOrder);
export const stageStatusSchema = z.enum(["running", "succeeded", "failed", "skipped"]);
export const stageMetricValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export const stageResultSchema = z.object({
  name: videoStageNameSchema,
  status: stageStatusSchema,
  inputHash: z.string(),
  outputs: z.record(z.string(), z.string()),
  issues: z.array(qualityIssueSchema),
  metrics: z.record(z.string(), stageMetricValueSchema),
  dirtyPlan: dirtyPlanSchema.optional(),
  repairCandidates: z.array(repairCandidateSchema).optional(),
  repairDecision: repairDecisionSchema.optional(),
  durationMs: z.number().nonnegative(),
  attempt: z.number().int().positive(),
  suggestedAction: repairActionSchema,
  startedAt: z.string(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
});

export type VideoStageName = z.infer<typeof videoStageNameSchema>;
export type StageStatus = z.infer<typeof stageStatusSchema>;
export type SuggestedAction = z.infer<typeof repairActionSchema>;
export type StageIssue = z.infer<typeof qualityIssueSchema>;
export type StageResult = z.infer<typeof stageResultSchema>;

const stageAliases: Record<string, VideoStageName> = {
  audio: "synthesize",
  draft: "draft",
  generate: "draft",
  quality: "draft-gate",
  video: "render",
};

export function parseStageName(value: string): VideoStageName {
  const normalized = value.trim().toLowerCase();
  const stage = stageAliases[normalized] ?? videoStageOrder.find((item) => item === normalized);
  if (!stage) throw new Error(`Unknown stage: ${value}. Expected one of ${videoStageOrder.join(", ")}.`);
  return stage;
}

export function stageIndex(stage: VideoStageName) {
  return videoStageOrder.indexOf(stage);
}
