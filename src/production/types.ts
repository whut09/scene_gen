import type { StoryPlanningAudit, VideoProject, VideoScene } from "../pipeline/types";
import type { TemplateHistoryStats, TemplateLearningFeatures, TemplateScoreBreakdown } from "../templates/template-learning";

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
  phrase?: string;
  startRatio: number;
  endRatio: number;
  audioStartMs?: number;
  audioEndMs?: number;
  confidence?: number;
  timingSource: "forced-alignment" | "estimated-ratio";
  emphasis: "primary" | "secondary";
}

export interface ProductionDecision {
  sceneIndex: number;
  sceneType: VideoScene["type"];
  visualPlan: VisualPlan;
  syncCues: SyncCue[];
  templateSelection: {
    templateId: string;
    variantId: string;
    motionFamily: import("../templates/template.schema").TemplateMotionFamily;
    score: number;
    ruleScore: number;
    learnedAdjustment: number;
    explored: boolean;
    reasons: string[];
    features: TemplateLearningFeatures;
    history: TemplateHistoryStats;
    scoreBreakdown: TemplateScoreBreakdown;
  };
}

export interface ProductionReport {
  specVersion: 1;
  createdAt: string;
  projectTitle: string;
  sourceUrl: string;
  renderEngine: string;
  providers: ProviderDescriptor[];
  decisions: ProductionDecision[];
  storyPlanning?: StoryPlanningAudit;
  summary: {
    sourceMix: Record<string, number>;
    enabledProviders: string[];
    disabledProviders: string[];
    estimatedExternalCost: number;
    wordAlignment: "estimated-keyword-cues" | "forced-alignment";
    alignedCueCount: number;
    estimatedCueCount: number;
    alignmentCoverage: number;
    averageAlignmentConfidence: number;
    exploredTemplateCount: number;
    averageTemplateLearnedAdjustment: number;
    templateHistorySamples: number;
  };
}

export type SceneWithProject = { project: VideoProject; scene: VideoScene; sceneIndex: number };
