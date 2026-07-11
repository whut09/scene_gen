import type { VideoProject, VideoScene } from "../pipeline/types";

export type TemplateEngine = "remotion" | "html-video";

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

export interface TemplateDefinition {
  id: string;
  name: string;
  description: string;
  engine: TemplateEngine;
  category: string;
  tags: string[];
  bestFor: string[];
  supportedScenes: VideoScene["type"][];
  output: TemplateOutputSpec;
  inputs: TemplateInputSpec;
  license: {
    spdx: string;
    attributionRequired: boolean;
    redistributionAllowed: boolean;
    commercialUse: boolean;
  };
}

export interface TemplateRenderContext {
  project: VideoProject;
  scene: VideoScene;
  sceneIndex: number;
  width: number;
  height: number;
}

export interface HtmlTemplateDefinition extends TemplateDefinition {
  engine: "html-video";
  renderHtml: (ctx: TemplateRenderContext) => string;
}
