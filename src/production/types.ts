import type { VideoProject, VideoScene } from "../pipeline/types";

export type VisualSource =
  | "programmatic"
  | "web-screenshot"
  | "stock-video"
  | "generated-image"
  | "generated-video"
  | "github-ui"
  | "mixed";

export type ProviderCapability = "programmatic" | "browser" | "stock-video" | "image" | "video" | "tts" | "music" | "alignment";

export interface ProviderDescriptor {
  id: string;
  name: string;
  capability: ProviderCapability;
  enabled: boolean;
  local: boolean;
  quality: number;
  cost: number;
  latency: number;
  supportsPortrait: boolean;
  commercialUse: boolean;
  reason?: string;
}

export interface VisualPlan {
  source: VisualSource;
  providerId: string;
  fallback: VisualSource;
  fallbackProviderId: string;
  searchQueries: string[];
  rationale: string[];
  motionTargets: number;
  expectedMotionRatio: number;
}

export interface SyncCue {
  text: string;
  startRatio: number;
  endRatio: number;
  emphasis: "primary" | "secondary";
}

export interface ProductionDecision {
  sceneIndex: number;
  sceneType: VideoScene["type"];
  visualPlan: VisualPlan;
  syncCues: SyncCue[];
}

export interface ProductionReport {
  specVersion: 1;
  createdAt: string;
  projectTitle: string;
  sourceUrl: string;
  renderEngine: string;
  providers: ProviderDescriptor[];
  decisions: ProductionDecision[];
  summary: {
    sourceMix: Record<string, number>;
    enabledProviders: string[];
    disabledProviders: string[];
    estimatedExternalCost: number;
    wordAlignment: "estimated-keyword-cues" | "forced-alignment";
  };
}

export type SceneWithProject = { project: VideoProject; scene: VideoScene; sceneIndex: number };
