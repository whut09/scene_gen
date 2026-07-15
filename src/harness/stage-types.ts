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

export type VideoStageName = (typeof videoStageOrder)[number];
export type StageStatus = "running" | "succeeded" | "failed" | "skipped";
export type SuggestedAction =
  | "none"
  | "regenerate-draft"
  | "revise-scenes"
  | "retry-stage"
  | "check-environment"
  | "resynthesize-audio"
  | "remux"
  | "rerender-scenes"
  | "switch-template"
  | "stop";

export interface StageIssue {
  severity: "warning" | "error";
  code: string;
  message: string;
  stage: "draft" | "audio" | "video";
  issueClass: "soft" | "hard" | "environment";
  sceneIndex?: number;
  evidence: Record<string, string | number | boolean | string[]>;
  repairAction: SuggestedAction;
  retryable: boolean;
}

export interface StageResult {
  name: VideoStageName;
  status: StageStatus;
  inputHash: string;
  outputs: Record<string, string>;
  issues: StageIssue[];
  metrics: Record<string, string | number | boolean>;
  dirtyPlan?: DirtyPlan;
  durationMs: number;
  attempt: number;
  suggestedAction: SuggestedAction;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

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
import type { DirtyPlan } from "./dirty-plan";
