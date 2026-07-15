import type { VideoProject } from "../pipeline/types";
import { listProviders } from "./provider-registry";
import { buildProductionDecisions } from "./visual-planner";
import type { ProductionReport } from "./types";

export function buildProductionReport(project: VideoProject, renderEngine = "html-video"): ProductionReport {
  const providers = listProviders();
  const decisions = buildProductionDecisions(project);
  const cues = decisions.flatMap((decision) => decision.syncCues);
  const alignedCues = cues.filter((cue) => cue.timingSource === "forced-alignment");
  const sourceMix: Record<string, number> = {};
  for (const decision of decisions) sourceMix[decision.visualPlan.source] = (sourceMix[decision.visualPlan.source] ?? 0) + 1;
  return {
    specVersion: 1,
    createdAt: new Date().toISOString(),
    projectTitle: project.meta.title,
    sourceUrl: project.sources[0]?.url ?? "",
    renderEngine,
    providers,
    decisions,
    storyPlanning: project.storyPlanning,
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
    },
  };
}
