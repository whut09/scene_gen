import type { VideoProject, VideoScene } from "../pipeline/types";

export type TemplateEngine = "remotion" | "html-video";

export type SceneIntent =
  | "hook"
  | "briefing"
  | "comparison"
  | "evidence"
  | "timeline"
  | "workflow"
  | "repository"
  | "summary";

export type TemplateDataDensity = "low" | "medium" | "high";
export type TemplateMotionFamily = "kinetic" | "editorial" | "diagram" | "measured";

export interface TemplateOutputSpec {
  formats: Array<"mp4" | "webm">;
  defaultFormat: "mp4" | "webm";
  supportedAspects: string[];
  fps: number[];
  duration: {
    type: "fixed" | "variable";
    minSec: number;
    maxSec: number;
    defaultSec: number;
  };
  audio: boolean;
}

export interface TemplateInputSpec {
  schema: Record<string, unknown>;
  examples: unknown[];
}

export interface TemplateVariantDefinition {
  id: string;
  name: string;
  tags: string[];
  bestFor: string[];
}

export interface TemplateDefinition {
  id: string;
  version: string;
  name: string;
  description: string;
  engine: TemplateEngine;
  category: string;
  subcategory?: string;
  tags: string[];
  bestFor: string[];
  notFor: string[];
  supportedIntents: SceneIntent[];
  supportedScenes: VideoScene["type"][];
  dataDensity: TemplateDataDensity[];
  motionFamily: TemplateMotionFamily;
  visualFamily: string;
  variants: TemplateVariantDefinition[];
  output: TemplateOutputSpec;
  inputs: TemplateInputSpec;
  license: {
    spdx: string;
    attributionRequired: boolean;
    redistributionAllowed: boolean;
    commercialUse: boolean;
  };
  provenance: {
    kind: "original" | "adapted" | "third-party";
    source?: string;
    note?: string;
  };
  performance: {
    tier: "light" | "standard" | "heavy";
    expectedRenderRatio: number;
  };
}

export interface TemplateSelection {
  template: HtmlTemplateDefinition;
  score: number;
  intent: SceneIntent;
  variantId: string;
  reasons: string[];
}

export interface TemplateRenderContext {
  project: VideoProject;
  scene: VideoScene;
  sceneIndex: number;
  width: number;
  height: number;
  variantId: string;
}

export interface HtmlTemplateDefinition extends TemplateDefinition {
  engine: "html-video";
  renderHtml: (ctx: TemplateRenderContext) => string;
}
