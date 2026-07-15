import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { FeedbackEntry } from "../harness/feedback-store";
import type { QualityIssue } from "../harness/quality-protocol";
import type { VisualAuditFile } from "../html-video/visual-audit";
import type { VideoProject, VideoScene } from "../pipeline/types";
import { fromRoot } from "../pipeline/utils";
import type { HtmlTemplateDefinition, SceneIntent } from "./template.schema";

export type TemplateContentDomain = "ai" | "finance" | "product" | "policy" | "general";
export type TemplateInformationStructure = "horizontal" | "vertical" | "mixed";

export interface TemplateLearningFeatures {
  domain: TemplateContentDomain;
  intent: SceneIntent;
  sceneType: VideoScene["type"];
  textLength: number;
  itemCount: number;
  dataCount: number;
  numericCount: number;
  informationStructure: TemplateInformationStructure;
  assetAvailable: boolean;
}

export interface TemplateHistoryStats {
  samples: number;
  scope: "exact" | "scene" | "template" | "prior";
  passRate: number;
  blankRate: number;
  overflowRate: number;
  staticRate: number;
  averageQualityScore: number;
  averageRenderMs: number;
  cacheHitRate: number;
  averageFeedbackScore: number;
  uncertainty: number;
}

export interface TemplateScoreBreakdown {
  ruleScore: number;
  historyPass: number;
  quality: number;
  overflowRisk: number;
  blankRisk: number;
  staticRisk: number;
  estimatedCost: number;
  estimatedLatency: number;
  cacheProbability: number;
  userFeedback: number;
  exploration: number;
  learnedAdjustment: number;
  finalScore: number;
}

const featureSchema = z.object({
  domain: z.enum(["ai", "finance", "product", "policy", "general"]),
  intent: z.enum(["hook", "briefing", "comparison", "evidence", "timeline", "workflow", "repository", "summary"]),
  sceneType: z.enum(["title", "briefing_points", "news_stack", "signal_chart", "web_screenshot_zoom", "timeline", "github_pulse", "flow", "outro"]),
  textLength: z.number().int().nonnegative(),
  itemCount: z.number().int().nonnegative(),
  dataCount: z.number().int().nonnegative(),
  numericCount: z.number().int().nonnegative(),
  informationStructure: z.enum(["horizontal", "vertical", "mixed"]),
  assetAvailable: z.boolean(),
});

const outcomeSchema = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  runId: z.string().optional(),
  templateId: z.string().min(1),
  variantId: z.string().min(1),
  sceneIndex: z.number().int().nonnegative(),
  features: featureSchema,
  passed: z.boolean(),
  qualityScore: z.number().min(0).max(100),
  blank: z.boolean(),
  overflow: z.boolean(),
  static: z.boolean(),
  renderMs: z.number().nonnegative(),
  cacheHit: z.boolean(),
  feedbackScore: z.number().min(-4).max(4),
});

export type TemplateOutcome = z.infer<typeof outcomeSchema>;

export function templateOutcomeFilePath() {
  return process.env.TEMPLATE_OUTCOME_FILE
    ? path.resolve(process.env.TEMPLATE_OUTCOME_FILE)
    : fromRoot("data", "template-learning", "outcomes.jsonl");
}

function sceneValues(scene: VideoScene): string[] {
  const values: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") values.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(scene);
  return values;
}

function sceneItemCount(scene: VideoScene) {
  switch (scene.type) {
    case "briefing_points": return scene.metrics.length + scene.points.length;
    case "news_stack": return scene.items.length;
    case "signal_chart": return scene.bars.length;
    case "web_screenshot_zoom": return scene.shots.length;
    case "timeline": return scene.events.length;
    case "github_pulse": return scene.repos.length;
    case "flow": return scene.steps.length;
    case "outro": return scene.bullets.length;
    case "title": return 3;
  }
}

function sceneDataCount(scene: VideoScene) {
  if (scene.type === "signal_chart") return scene.bars.length;
  if (scene.type === "briefing_points") return scene.metrics.length;
  if (scene.type === "github_pulse") return scene.repos.length;
  return 0;
}

function contentDomain(project: VideoProject) {
  const terms = project.sources.flatMap((source) => [source.title, source.summary, source.content, ...(source.tags ?? [])]).join(" ").toLowerCase();
  if (/ai|agent|llm|model|prompt|token|github|code|人工智能|模型|智能体|代码/.test(terms)) return "ai" as const;
  if (/finance|investment|valuation|stock|revenue|profit|金融|投资|估值|股票|营收|利润/.test(terms)) return "finance" as const;
  if (/policy|government|regulation|政策|监管|政府/.test(terms)) return "policy" as const;
  if (/product|release|feature|workflow|产品|发布|功能|工作流/.test(terms)) return "product" as const;
  return "general" as const;
}

export function buildTemplateLearningFeatures(scene: VideoScene, project: VideoProject, intent: SceneIntent): TemplateLearningFeatures {
  const values = sceneValues(scene);
  const text = values.join(" ");
  const structure: TemplateInformationStructure = scene.type === "timeline" || scene.type === "flow"
    ? "horizontal"
    : scene.type === "briefing_points" || scene.type === "news_stack" || scene.type === "outro"
      ? "vertical"
      : "mixed";
  return {
    domain: contentDomain(project),
    intent,
    sceneType: scene.type,
    textLength: [...text.replace(/\s+/g, "")].length,
    itemCount: sceneItemCount(scene),
    dataCount: sceneDataCount(scene),
    numericCount: (text.match(/\d+(?:\.\d+)?%?/g) ?? []).length,
    informationStructure: structure,
    assetAvailable: Boolean(project.assets?.length || project.screenshots?.length || scene.type === "web_screenshot_zoom"),
  };
}

export function readTemplateOutcomes(): TemplateOutcome[] {
  const filePath = templateOutcomeFilePath();
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const parsed = outcomeSchema.safeParse(JSON.parse(line));
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
}

function aggregateOutcomes(outcomes: TemplateOutcome[], scope: TemplateHistoryStats["scope"]): TemplateHistoryStats {
  const samples = outcomes.length;
  if (!samples) return { samples: 0, scope: "prior", passRate: 0.5, blankRate: 0.05, overflowRate: 0.08, staticRate: 0.08, averageQualityScore: 75, averageRenderMs: 0, cacheHitRate: 0.5, averageFeedbackScore: 0, uncertainty: 1 };
  const average = (selector: (outcome: TemplateOutcome) => number) => outcomes.reduce((sum, outcome) => sum + selector(outcome), 0) / samples;
  return {
    samples,
    scope,
    passRate: (outcomes.filter((outcome) => outcome.passed).length + 2) / (samples + 4),
    blankRate: (outcomes.filter((outcome) => outcome.blank).length + 0.25) / (samples + 5),
    overflowRate: (outcomes.filter((outcome) => outcome.overflow).length + 0.4) / (samples + 5),
    staticRate: (outcomes.filter((outcome) => outcome.static).length + 0.4) / (samples + 5),
    averageQualityScore: average((outcome) => outcome.qualityScore),
    averageRenderMs: average((outcome) => outcome.renderMs),
    cacheHitRate: (outcomes.filter((outcome) => outcome.cacheHit).length + 1) / (samples + 2),
    averageFeedbackScore: average((outcome) => outcome.feedbackScore),
    uncertainty: 1 / Math.sqrt(samples + 1),
  };
}

export function templateHistoryStats(templateId: string, variantId: string, features: TemplateLearningFeatures, outcomes = readTemplateOutcomes()) {
  const template = outcomes.filter((outcome) => outcome.templateId === templateId);
  const scene = template.filter((outcome) => outcome.features.sceneType === features.sceneType && outcome.features.intent === features.intent);
  const exact = scene.filter((outcome) => outcome.variantId === variantId && outcome.features.domain === features.domain);
  if (exact.length >= 2) return aggregateOutcomes(exact, "exact");
  const variantScene = scene.filter((outcome) => outcome.variantId === variantId);
  if (variantScene.length >= 2) return aggregateOutcomes(variantScene, "scene");
  if (template.length) return aggregateOutcomes(template, "template");
  return aggregateOutcomes([], "prior");
}

function stableUnit(value: string) {
  const hash = createHash("sha256").update(value).digest();
  return hash.readUInt32BE(0) / 0xffffffff;
}

export function shouldExploreTemplate(project: VideoProject, sceneIndex: number) {
  if (process.env.TEMPLATE_LEARNING_DISABLED === "1") return false;
  const rate = Math.max(0, Math.min(0.25, Number(process.env.TEMPLATE_EXPLORATION_RATE ?? 0.07)));
  return stableUnit(`${project.meta.title}:${project.sources[0]?.url ?? ""}:${sceneIndex}`) < rate;
}

export function scoreTemplateCandidate(input: {
  ruleScore: number;
  template: HtmlTemplateDefinition;
  variantId: string;
  features: TemplateLearningFeatures;
  explore: boolean;
  outcomes?: TemplateOutcome[];
}) {
  if (process.env.TEMPLATE_LEARNING_DISABLED === "1") {
    const history = aggregateOutcomes([], "prior");
    return { history, breakdown: { ruleScore: input.ruleScore, historyPass: 0, quality: 0, overflowRisk: 0, blankRisk: 0, staticRisk: 0, estimatedCost: 0, estimatedLatency: 0, cacheProbability: 0, userFeedback: 0, exploration: 0, learnedAdjustment: 0, finalScore: input.ruleScore } satisfies TemplateScoreBreakdown };
  }
  const history = templateHistoryStats(input.template.id, input.variantId, input.features, input.outcomes);
  const tierCost = { light: 0.5, standard: 1, heavy: 1.7 }[input.template.performance.tier];
  const historyPass = (history.passRate - 0.5) * 32;
  const quality = ((history.averageQualityScore - 75) / 25) * 10;
  const overflowRisk = -history.overflowRate * 22;
  const blankRisk = -history.blankRate * 18;
  const staticRisk = -history.staticRate * 18;
  const estimatedCost = -tierCost * 2.5;
  const expectedRatio = Math.max(0.1, input.template.performance.expectedRenderRatio);
  const observedLatency = history.averageRenderMs > 0 ? Math.min(3, history.averageRenderMs / 20_000) : expectedRatio;
  const estimatedLatency = -observedLatency * 3;
  const cacheProbability = (history.cacheHitRate - 0.5) * 8;
  const userFeedback = history.averageFeedbackScore * 4;
  const exploration = input.explore ? history.uncertainty * Number(process.env.TEMPLATE_EXPLORATION_BONUS ?? 14) : 0;
  const learnedAdjustment = historyPass + quality + overflowRisk + blankRisk + staticRisk + estimatedCost + estimatedLatency + cacheProbability + userFeedback + exploration;
  return {
    history,
    breakdown: {
      ruleScore: Number(input.ruleScore.toFixed(2)), historyPass: Number(historyPass.toFixed(2)), quality: Number(quality.toFixed(2)),
      overflowRisk: Number(overflowRisk.toFixed(2)), blankRisk: Number(blankRisk.toFixed(2)), staticRisk: Number(staticRisk.toFixed(2)),
      estimatedCost: Number(estimatedCost.toFixed(2)), estimatedLatency: Number(estimatedLatency.toFixed(2)), cacheProbability: Number(cacheProbability.toFixed(2)),
      userFeedback: Number(userFeedback.toFixed(2)), exploration: Number(exploration.toFixed(2)), learnedAdjustment: Number(learnedAdjustment.toFixed(2)),
      finalScore: Number(Math.max(0, input.ruleScore + learnedAdjustment).toFixed(2)),
    },
  };
}

function parseMetricArray(value: unknown): number[] {
  if (Array.isArray(value)) return value.filter((item): item is number => typeof item === "number");
  if (typeof value !== "string") return [];
  try { return z.array(z.number()).parse(JSON.parse(value)); } catch { return []; }
}

function parseMetricMap(value: unknown): Record<string, number> {
  if (value && typeof value === "object" && !Array.isArray(value)) return z.record(z.string(), z.number()).catch({}).parse(value);
  if (typeof value !== "string") return {};
  try { return z.record(z.string(), z.number()).parse(JSON.parse(value)); } catch { return {}; }
}

export async function recordTemplateOutcomes(input: {
  runId?: string;
  project: VideoProject;
  nodes: Array<{ sceneIndex: number; templateId: string; variantId: string; intent: SceneIntent }>;
  visualAudit?: VisualAuditFile;
  videoIssues: QualityIssue[];
  renderMetrics: Record<string, unknown>;
  feedback: FeedbackEntry[];
}) {
  if (process.env.TEMPLATE_LEARNING_DISABLED === "1") return { recorded: 0, filePath: templateOutcomeFilePath() };
  const cacheHits = new Set(parseMetricArray(input.renderMetrics.cacheHitScenes));
  const recordMs = parseMetricMap(input.renderMetrics.perSceneRecordMs);
  const encodeMs = parseMetricMap(input.renderMetrics.perSceneEncodeMs);
  const severityWeight = { low: 1, medium: 2, high: 3, critical: 4 } as const;
  const outcomes = input.nodes.flatMap((node): TemplateOutcome[] => {
    const scene = input.project.scenes[node.sceneIndex];
    if (!scene) return [];
    const audit = input.visualAudit?.scenes.find((item) => item.sceneIndex === node.sceneIndex);
    const issueCodes = new Set([...(audit?.issues.map((issue) => issue.code) ?? []), ...input.videoIssues.filter((issue) => issue.sceneIndex === node.sceneIndex).map((issue) => issue.code)]);
    const errorCount = audit?.issues.filter((issue) => issue.severity === "error").length ?? 0;
    const warningCount = audit?.issues.filter((issue) => issue.severity === "warning").length ?? 0;
    const relevantFeedback = input.feedback.filter((entry) => /template|visual|layout|motion|模板|视觉|布局|动效/i.test(`${entry.category} ${entry.issue}`)
      && (entry.appliesTo.includes("global") || entry.appliesTo.includes(`template:${node.templateId}`)));
    const feedbackScore = relevantFeedback.length
      ? relevantFeedback.reduce((sum, entry) => sum + (errorCount === 0 ? 0.5 : -severityWeight[entry.severity]), 0) / relevantFeedback.length
      : 0;
    const blank = issueCodes.has("blank_frame");
    const overflow = [...issueCodes].some((code) => /overflow|clipped|out_of_bounds|unsafe_zone/.test(code));
    const staticScene = issueCodes.has("scene_motion_too_static");
    const passed = errorCount === 0 && !blank && !overflow && !input.videoIssues.some((issue) => issue.sceneIndex === node.sceneIndex && issue.severity === "error");
    return [outcomeSchema.parse({
      version: 1, createdAt: new Date().toISOString(), runId: input.runId, templateId: node.templateId, variantId: node.variantId, sceneIndex: node.sceneIndex,
      features: buildTemplateLearningFeatures(scene, input.project, node.intent), passed,
      qualityScore: Math.max(0, Math.min(100, 100 - errorCount * 22 - warningCount * 5 - (blank ? 30 : 0) - (staticScene ? 12 : 0))),
      blank, overflow, static: staticScene,
      renderMs: (recordMs[String(node.sceneIndex)] ?? 0) + (encodeMs[String(node.sceneIndex)] ?? 0),
      cacheHit: cacheHits.has(node.sceneIndex),
      feedbackScore: Math.max(-4, Math.min(4, feedbackScore)),
    })];
  });
  const filePath = templateOutcomeFilePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  if (outcomes.length) await appendFile(filePath, outcomes.map((outcome) => JSON.stringify(outcome)).join("\n") + "\n", "utf8");
  return { recorded: outcomes.length, filePath };
}
