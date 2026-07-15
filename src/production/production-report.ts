import type { VideoProject } from "../pipeline/types";
import { listProviders } from "./provider-registry";
import { buildProductionDecisions } from "./visual-planner";
import type { ProductionReport } from "./types";

export function buildProductionReport(project: VideoProject, renderEngine = "html-video"): ProductionReport {
  const providers = listProviders();
  const decisions = buildProductionDecisions(project);
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
      wordAlignment: providers.some((provider) => provider.id === "whisper" && provider.enabled) ? "forced-alignment" : "estimated-keyword-cues",
    },
  };
}
