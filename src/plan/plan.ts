import path from "node:path";
import type { SourceConfig } from "../pipeline/types";
import { collectWebpage } from "../pipeline/sources";
import { fromRoot, readJson, slugify, writeJsonAtomic } from "../pipeline/utils";
import type { ConfigProfile } from "../config/config-profiles";
import type { RuntimeConfig } from "../config/runtime-config";

export interface PlanOptions {
  url: string;
  profile: ConfigProfile;
  runtimeConfig: RuntimeConfig;
  targetSeconds: number;
  engine: "html-video" | "remotion";
  screenshots: number;
  outputDir: string;
  save?: boolean;
}

export async function createExecutionPlan(options: PlanOptions) {
  const config = await readJson<SourceConfig>(fromRoot("config", "sources.json"));
  const items = await collectWebpage([options.url], config);
  const source = items[0];
  if (!source) throw new Error(`Unable to fetch a readable article from ${options.url}.`);
  const [{ listProviders }, { listTemplateMetadata }] = await Promise.all([
    import("../production/provider-registry"),
    import("../templates/template-registry"),
  ]);
  const providers = listProviders();
  const preferredTts = options.runtimeConfig.tts.provider === "openai" ? "openai-tts" : options.runtimeConfig.tts.provider === "f5" ? "f5" : "local-tts";
  const selectedProviders = [
    providers.find((provider) => provider.id === options.engine),
    providers.find((provider) => provider.id === "playwright"),
    providers.find((provider) => provider.id === preferredTts),
    providers.find((provider) => provider.id === "whisper"),
  ].filter(Boolean);
  const templates = listTemplateMetadata();
  const estimatedNarrationChars = Math.round(options.targetSeconds * 7.5);
  const plan = {
    specVersion: 1,
    createdAt: new Date().toISOString(),
    dryRun: true,
    source: { title: source.title, url: source.url, source: source.source, publishedAt: source.publishedAt, summary: source.summary, contentChars: source.content?.length ?? 0 },
    profile: { name: options.profile.name, description: options.profile.description },
    execution: {
      targetSeconds: options.targetSeconds,
      estimatedNarrationChars,
      engine: options.engine,
      screenshots: options.screenshots,
      outputDir: path.resolve(options.outputDir),
      stagesSkipped: ["LLM draft", "TTS synthesis", "ASR verification", "scene rendering", "video rendering"],
    },
    providers: selectedProviders.map((provider) => ({ id: provider!.id, enabled: provider!.enabled, local: provider!.local, costWeight: provider!.cost, reason: provider!.reason })),
    templates: templates.map((template) => ({ id: template.id, sceneTypes: template.supportedScenes, variants: template.variants.map((variant) => variant.id) })),
    estimatedCost: {
      llmCalls: 1,
      ttsCharacters: estimatedNarrationChars,
      screenshots: options.screenshots,
      externalCostWeight: selectedProviders.reduce((sum, provider) => sum + (provider?.cost ?? 0), 0),
      note: "Cost weight is a relative planning signal, not a currency quote.",
    },
    requiredEnvironment: {
      api: options.profile.doctor.requireApi,
      browser: options.profile.doctor.requireBrowser,
      f5: options.profile.doctor.requireF5,
      whisper: options.profile.doctor.requireWhisper,
      cuda: options.profile.doctor.requireCuda,
    },
  };
  if (options.save !== false) {
    const planPath = fromRoot("dist", "plans", `${new Date().toISOString().replace(/[:.]/g, "-")}-${slugify(source.title, "plan")}.json`);
    await writeJsonAtomic(planPath, plan);
    return { ...plan, planPath };
  }
  return plan;
}

export function formatExecutionPlan(plan: Awaited<ReturnType<typeof createExecutionPlan>>) {
  return [
    `Plan: ${plan.source.title}`,
    `Source: ${plan.source.url}`,
    `Profile: ${plan.profile.name}`,
    `Engine: ${plan.execution.engine}; target ${plan.execution.targetSeconds}s; ~${plan.execution.estimatedNarrationChars} narration chars`,
    `Providers: ${plan.providers.map((provider) => `${provider.id}(${provider.enabled ? "configured" : "unconfigured"})`).join(", ")}`,
    `Templates: ${plan.templates.length} available`,
    `Estimated cost weight: ${plan.estimatedCost.externalCostWeight.toFixed(2)}; LLM calls ${plan.estimatedCost.llmCalls}; TTS chars ${plan.estimatedCost.ttsCharacters}`,
    `Skipped: ${plan.execution.stagesSkipped.join(", ")}`,
    "planPath" in plan ? `Saved: ${plan.planPath}` : "",
  ].filter(Boolean).join("\n");
}
