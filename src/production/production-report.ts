import type { VideoProject } from "../pipeline/types";
import { listProviders } from "./provider-registry";
import { buildProductionDecisions } from "./visual-planner";
import type { ProductionReport } from "./types";
import { z } from "zod";
import { readJson } from "../pipeline/utils";
import { persistMigratedJson, readVersionedFormat } from "../persistence/versioned-format";
import { pronunciationPlanSchema } from "../pipeline/pronunciation/schema";

export const productionReportSchema = z.object({
  specVersion: z.literal(2),
  createdAt: z.string(),
  projectTitle: z.string(),
  sourceUrl: z.string(),
  renderEngine: z.string(),
  providers: z.array(z.unknown()),
  providerSelections: z.array(z.unknown()),
  decisions: z.array(z.unknown()),
  storyPlanning: z.unknown().optional(),
  pronunciationPlans: z.array(pronunciationPlanSchema).optional(),
  summary: z.object({
    sourceMix: z.record(z.string(), z.number()),
    enabledProviders: z.array(z.string()),
    disabledProviders: z.array(z.string()),
    estimatedExternalCost: z.number(),
    wordAlignment: z.enum(["estimated-keyword-cues", "forced-alignment"]),
    alignedCueCount: z.number().int().nonnegative(),
    estimatedCueCount: z.number().int().nonnegative(),
    alignmentCoverage: z.number().min(0).max(1),
    averageAlignmentConfidence: z.number().min(0).max(1),
    exploredTemplateCount: z.number().int().nonnegative(),
    averageTemplateLearnedAdjustment: z.number(),
    templateHistorySamples: z.number().int().nonnegative(),
    unhealthyProviders: z.array(z.string()),
    degradedProviders: z.array(z.string()),
    selectedTtsProvider: z.string().optional(),
    pronunciationStrategy: z.string().optional(),
    quotaConsumed: z.number().nonnegative().default(0),
    quotaRemaining: z.number().optional(),
    providerSwitchCount: z.number().int().nonnegative().default(0),
    verifierRetryCount: z.number().int().nonnegative().default(0),
    avoidedTtsRegenerationCount: z.number().int().nonnegative().default(0),
  }),
}).passthrough();

function migrateProductionReportV1ToV2(value: Record<string, unknown>) {
  return { ...value, specVersion: 2 };
}

export function readProductionReport(raw: unknown) {
  const result = readVersionedFormat({
    raw,
    format: "production report",
    versionField: "specVersion",
    currentVersion: 2,
    migrations: { 1: migrateProductionReportV1ToV2 },
    schema: productionReportSchema,
  });
  return { ...result, value: result.value as ProductionReport };
}

export async function readProductionReportFile(filePath: string, persistMigration = false) {
  const raw = await readJson<unknown>(filePath);
  const result = readProductionReport(raw);
  const backupPath = persistMigration ? await persistMigratedJson(filePath, raw, result) : undefined;
  return { ...result, backupPath };
}

export function buildProductionReport(project: VideoProject, renderEngine = "html-video"): ProductionReport {
  const providers = listProviders();
  const decisions = buildProductionDecisions(project);
  let audioSelection: ProductionReport["providerSelections"][number] | undefined;
  try {
    audioSelection = project.audio?.metrics?.providerSelection ? JSON.parse(project.audio.metrics.providerSelection) as ProductionReport["providerSelections"][number] : undefined;
  } catch {
    audioSelection = undefined;
  }
  const providerSelections = [
    ...(audioSelection ? [audioSelection] : []),
    ...decisions.flatMap((decision) => [decision.visualPlan.providerSelection, decision.visualPlan.fallbackSelection]),
  ];
  const cues = decisions.flatMap((decision) => decision.syncCues);
  const alignedCues = cues.filter((cue) => cue.timingSource === "forced-alignment");
  const sourceMix: Record<string, number> = {};
  for (const decision of decisions) sourceMix[decision.visualPlan.source] = (sourceMix[decision.visualPlan.source] ?? 0) + 1;
  return {
    specVersion: 2,
    createdAt: new Date().toISOString(),
    projectTitle: project.meta.title,
    sourceUrl: project.sources[0]?.url ?? "",
    renderEngine,
    providers,
    providerSelections,
    decisions,
    storyPlanning: project.storyPlanning,
    pronunciationPlans: project.narrationSegments?.flatMap((segment) => segment.pronunciationPlan ? [segment.pronunciationPlan] : []),
    summary: {
      sourceMix,
      enabledProviders: providers.filter((provider) => provider.enabled).map((provider) => provider.id),
      disabledProviders: providers.filter((provider) => !provider.enabled).map((provider) => provider.id),
      estimatedExternalCost: Number(decisions.reduce((sum, decision) => sum + (providers.find((provider) => provider.id === decision.visualPlan.providerId)?.cost ?? 0), 0).toFixed(3)),
      wordAlignment: alignedCues.length > 0 ? "forced-alignment" : "estimated-keyword-cues",
      alignedCueCount: alignedCues.length,
      estimatedCueCount: cues.length - alignedCues.length,
      alignmentCoverage: Number((alignedCues.length / Math.max(1, cues.length)).toFixed(3)),
      averageAlignmentConfidence: Number((alignedCues.reduce((sum, cue) => sum + (cue.confidence ?? 0), 0) / Math.max(1, alignedCues.length)).toFixed(3)),
      exploredTemplateCount: decisions.filter((decision) => decision.templateSelection.explored).length,
      averageTemplateLearnedAdjustment: Number((decisions.reduce((sum, decision) => sum + decision.templateSelection.learnedAdjustment, 0) / Math.max(1, decisions.length)).toFixed(3)),
      templateHistorySamples: decisions.reduce((sum, decision) => sum + decision.templateSelection.history.samples, 0),
      unhealthyProviders: providers.filter((provider) => provider.health === "unhealthy").map((provider) => provider.id),
      degradedProviders: providers.filter((provider) => provider.health === "degraded").map((provider) => provider.id),
      selectedTtsProvider: project.audio?.metrics?.selectedProvider ?? project.audio?.provider,
      pronunciationStrategy: project.audio?.metrics?.pronunciationStrategy,
      quotaConsumed: project.audio?.metrics?.quotaConsumed ?? 0,
      quotaRemaining: project.audio?.metrics?.quotaRemaining !== undefined && project.audio.metrics.quotaRemaining >= 0 ? project.audio.metrics.quotaRemaining : undefined,
      providerSwitchCount: project.audio?.metrics?.providerSwitchCount ?? 0,
      verifierRetryCount: project.audio?.metrics?.verifierRetryCount ?? 0,
      avoidedTtsRegenerationCount: project.audio?.metrics?.avoidedTtsRegenerationCount ?? 0,
    },
  };
}
