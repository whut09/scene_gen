import { calculateProviderStats, canonicalProviderId, providerCostMetric, readProviderOutcomes, type ProviderSelectionContext } from "./provider-stats";
import type { ProviderCandidateDecision, ProviderCapability, ProviderDescriptor, ProviderSelectionAudit, TtsProviderCapabilities } from "./types";

interface ProviderDefinition {
  id: string;
  name: string;
  capability: ProviderCapability;
  enabled: boolean;
  local: boolean;
  priorQuality: number;
  priorCost: number;
  priorLatency: number;
  priorPronunciationAccuracy?: number;
  supportsPortrait: boolean;
  commercialUse: boolean;
  fallbackOnly?: boolean;
  reason?: string;
  ttsCapabilities?: TtsProviderCapabilities;
}

function configured(...keys: string[]) {
  return keys.some((key) => Boolean(process.env[key] && process.env[key] !== "xxx"));
}

function definitions(): ProviderDefinition[] { return [
  { id: "nvidia", name: "NVIDIA Magpie Multilingual TTS", capability: "tts", enabled: configured("NVIDIA_API_KEY"), local: false, priorQuality: 0.95, priorCost: 0, priorLatency: 0.32, priorPronunciationAccuracy: 0.98, supportsPortrait: true, commercialUse: true, reason: "Requires NVIDIA_API_KEY", ttsCapabilities: { supportsExplicitPhoneme: true, supportsCustomLexicon: true, supportsVoiceClone: false, supportsSsml: false, supportsStreaming: true, supportsCommercialUse: true, pronunciationControlLevel: "explicit-phoneme", freeQuotaType: "credits", estimatedLatency: 0.32, estimatedCost: 0 } },
  { id: "html-video", name: "HTML Video", capability: "programmatic", enabled: true, local: true, priorQuality: 0.9, priorCost: 0, priorLatency: 0.35, supportsPortrait: true, commercialUse: true },
  { id: "remotion", name: "Remotion", capability: "programmatic", enabled: true, local: true, priorQuality: 0.84, priorCost: 0, priorLatency: 0.25, supportsPortrait: true, commercialUse: true },
  { id: "playwright", name: "Playwright", capability: "browser", enabled: true, local: true, priorQuality: 0.86, priorCost: 0, priorLatency: 0.4, supportsPortrait: true, commercialUse: true },
  { id: "pexels", name: "Pexels", capability: "stock-video", enabled: configured("PEXELS_API_KEY"), local: false, priorQuality: 0.78, priorCost: 0, priorLatency: 0.55, supportsPortrait: true, commercialUse: true, reason: "Requires PEXELS_API_KEY" },
  { id: "pixabay", name: "Pixabay", capability: "stock-video", enabled: configured("PIXABAY_API_KEY"), local: false, priorQuality: 0.72, priorCost: 0, priorLatency: 0.55, supportsPortrait: true, commercialUse: true, reason: "Requires PIXABAY_API_KEY" },
  { id: "openai-image", name: "OpenAI Image", capability: "image", enabled: configured("OPENAI_API_KEY", "LLM_API_KEY"), local: false, priorQuality: 0.88, priorCost: 0.35, priorLatency: 0.65, supportsPortrait: true, commercialUse: true, reason: "Requires an image-capable API" },
  { id: "kling", name: "Kling", capability: "video", enabled: configured("KLING_API_KEY"), local: false, priorQuality: 0.9, priorCost: 0.8, priorLatency: 0.9, supportsPortrait: true, commercialUse: true, reason: "Requires KLING_API_KEY" },
  { id: "f5", name: "F5-TTS", capability: "tts", enabled: configured("F5_TTS_VENV", "F5_TTS_PYTHON"), local: true, priorQuality: 0.86, priorCost: 0, priorLatency: 0.7, priorPronunciationAccuracy: 0.93, supportsPortrait: true, commercialUse: true, reason: "Requires F5_TTS_VENV or F5_TTS_PYTHON", ttsCapabilities: { supportsExplicitPhoneme: false, supportsCustomLexicon: true, supportsVoiceClone: true, supportsSsml: false, supportsStreaming: false, supportsCommercialUse: true, pronunciationControlLevel: "lexicon", freeQuotaType: "local", estimatedLatency: 0.7, estimatedCost: 0 } },
  { id: "azure", name: "Azure Speech TTS", capability: "tts", enabled: configured("AZURE_SPEECH_KEY") && configured("AZURE_SPEECH_REGION", "AZURE_SPEECH_ENDPOINT"), local: false, priorQuality: 0.94, priorCost: 0, priorLatency: 0.38, priorPronunciationAccuracy: 0.98, supportsPortrait: true, commercialUse: true, reason: "Requires AZURE_SPEECH_KEY and AZURE_SPEECH_REGION or AZURE_SPEECH_ENDPOINT", ttsCapabilities: { supportsExplicitPhoneme: true, supportsCustomLexicon: true, supportsVoiceClone: false, supportsSsml: true, supportsStreaming: true, supportsCommercialUse: true, pronunciationControlLevel: "explicit-phoneme", freeQuotaType: "monthly-characters", estimatedLatency: 0.38, estimatedCost: 0 } },
  { id: "cloudflare-melotts", name: "Cloudflare MeloTTS", capability: "tts", enabled: configured("CLOUDFLARE_API_TOKEN") && configured("CLOUDFLARE_ACCOUNT_ID"), local: false, priorQuality: 0.8, priorCost: 0, priorLatency: 0.25, priorPronunciationAccuracy: 0.82, supportsPortrait: true, commercialUse: true, reason: "Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID", ttsCapabilities: { supportsExplicitPhoneme: false, supportsCustomLexicon: false, supportsVoiceClone: false, supportsSsml: false, supportsStreaming: false, supportsCommercialUse: true, pronunciationControlLevel: "fallback-only", freeQuotaType: "daily-neurons", estimatedLatency: 0.25, estimatedCost: 0 } },
  { id: "edge", name: "Edge TTS", capability: "tts", enabled: configured("EDGE_TTS_COMMAND"), local: false, priorQuality: 0.78, priorCost: 0, priorLatency: 0.22, priorPronunciationAccuracy: 0.78, supportsPortrait: true, commercialUse: true, reason: "Unofficial provider; requires EDGE_TTS_COMMAND", ttsCapabilities: { supportsExplicitPhoneme: false, supportsCustomLexicon: false, supportsVoiceClone: false, supportsSsml: false, supportsStreaming: true, supportsCommercialUse: true, pronunciationControlLevel: "fallback-only", freeQuotaType: "none", estimatedLatency: 0.22, estimatedCost: 0, unofficial: true } },
  { id: "openai", name: "OpenAI-compatible TTS", capability: "tts", enabled: configured("OPENAI_TTS_API_KEY", "OPENAI_API_KEY"), local: false, priorQuality: 0.9, priorCost: 0.2, priorLatency: 0.35, priorPronunciationAccuracy: 0.9, supportsPortrait: true, commercialUse: true, reason: "Requires OPENAI_TTS_API_KEY or OPENAI_API_KEY", ttsCapabilities: { supportsExplicitPhoneme: false, supportsCustomLexicon: false, supportsVoiceClone: false, supportsSsml: false, supportsStreaming: true, supportsCommercialUse: true, pronunciationControlLevel: "fallback-only", freeQuotaType: "none", estimatedLatency: 0.35, estimatedCost: 0.2 } },
  { id: "windows", name: "Windows TTS", capability: "tts", enabled: process.platform === "win32", local: true, priorQuality: 0.55, priorCost: 0, priorLatency: 0.2, priorPronunciationAccuracy: 0.62, supportsPortrait: true, commercialUse: true, fallbackOnly: true, reason: "Windows System.Speech fallback", ttsCapabilities: { supportsExplicitPhoneme: false, supportsCustomLexicon: false, supportsVoiceClone: false, supportsSsml: false, supportsStreaming: false, supportsCommercialUse: true, pronunciationControlLevel: "fallback-only", freeQuotaType: "local", estimatedLatency: 0.2, estimatedCost: 0 } },
  { id: "mock", name: "Mock TTS", capability: "tts", enabled: process.env.SCENE_GEN_PROFILE === "ci-offline" || process.env.TTS_PROVIDER === "mock", local: true, priorQuality: 1, priorCost: 0, priorLatency: 0.01, priorPronunciationAccuracy: 1, supportsPortrait: true, commercialUse: true, ttsCapabilities: { supportsExplicitPhoneme: true, supportsCustomLexicon: true, supportsVoiceClone: false, supportsSsml: true, supportsStreaming: false, supportsCommercialUse: true, pronunciationControlLevel: "explicit-phoneme", freeQuotaType: "local", estimatedLatency: 0.01, estimatedCost: 0 } },
  { id: "whisper", name: "Whisper alignment", capability: "alignment", enabled: configured("ASR_MODEL", "WHISPER_MODEL"), local: true, priorQuality: 0.82, priorCost: 0, priorLatency: 0.65, supportsPortrait: true, commercialUse: true, reason: "Requires ASR_MODEL for forced alignment" },
  { id: "news-llm", name: "News LLM", capability: "llm", enabled: configured("NEWS_LLM_API_KEY", "OPENAI_API_KEY"), local: false, priorQuality: 0.86, priorCost: 0.35, priorLatency: 0.55, supportsPortrait: true, commercialUse: true, reason: "Requires NEWS_LLM_API_KEY or OPENAI_API_KEY" },
]; }

function resolvedContext(context: Partial<ProviderSelectionContext> = {}): ProviderSelectionContext {
  return {
    profile: context.profile ?? process.env.SCENE_GEN_PROFILE ?? "custom",
    language: context.language,
    domain: context.domain,
    device: context.device,
    highRiskTerms: context.highRiskTerms,
    memoryPressure: context.memoryPressure,
  };
}

function profileWeights(profile: string) {
  if (profile === "fast-preview") return { quality: 0.12, success: 0.12, latency: 0.5, cost: 0.12, health: 0.14 };
  if (profile === "production") return { quality: 0.34, success: 0.34, latency: 0.1, cost: 0.06, health: 0.16 };
  if (profile === "ci-offline") return { quality: 0.12, success: 0.2, latency: 0.18, cost: 0.1, health: 0.4 };
  return { quality: 0.28, success: 0.28, latency: 0.2, cost: 0.1, health: 0.14 };
}

function healthValue(health: ProviderDescriptor["health"]) {
  return { healthy: 1, unknown: 0.72, degraded: 0.42, unhealthy: 0.05 }[health];
}

function dynamicDescriptor(definition: ProviderDefinition, context: ProviderSelectionContext, outcomes = readProviderOutcomes()): ProviderDescriptor {
  const stats = calculateProviderStats(definition.id, context, {
    quality: definition.priorQuality,
    cost: definition.priorCost,
    latency: definition.priorLatency,
    pronunciationAccuracy: definition.priorPronunciationAccuracy,
  }, outcomes);
  const latency = stats.p50LatencyMs > 0
    ? Math.min(1, stats.p50LatencyMs / Math.max(1, Number(process.env.PROVIDER_LATENCY_REFERENCE_MS ?? 120_000)))
    : definition.priorLatency;
  return {
    id: definition.id,
    name: definition.name,
    capability: definition.capability,
    enabled: definition.enabled,
    local: definition.local,
    quality: stats.qualityScore,
    cost: providerCostMetric(stats, definition.capability, definition.priorCost),
    latency,
    supportsPortrait: definition.supportsPortrait,
    commercialUse: definition.commercialUse,
    reason: definition.reason,
    health: stats.health,
    stats,
    ttsCapabilities: definition.ttsCapabilities,
  };
}

export function listProviders(context: Partial<ProviderSelectionContext> = {}) {
  const resolved = resolvedContext(context);
  const outcomes = readProviderOutcomes();
  return definitions().map((definition) => dynamicDescriptor(definition, resolved, outcomes));
}

export function rankProviders(capability: ProviderCapability, preferred: string[] = [], context: Partial<ProviderSelectionContext> = {}) {
  const resolved = resolvedContext(context);
  const weights = profileWeights(resolved.profile);
  const descriptors = listProviders(resolved).filter((provider) => provider.capability === capability);
  const definitionById = new Map(definitions().map((definition) => [definition.id, definition]));
  const healthyAlternative = descriptors.some((provider) => provider.enabled && provider.commercialUse && provider.supportsPortrait && provider.health !== "unhealthy");
  const healthyPrimaryAlternative = descriptors.some((provider) => provider.enabled && provider.commercialUse && provider.supportsPortrait && provider.health !== "unhealthy" && !definitionById.get(provider.id)?.fallbackOnly);
  const normalizedPreferred = preferred.map(canonicalProviderId);
  const candidates: ProviderCandidateDecision[] = descriptors.map((provider) => {
    const reasons: string[] = [];
    let eliminated = false;
    if (!provider.enabled) { eliminated = true; reasons.push(provider.reason ?? "provider is not configured"); }
    if (!provider.commercialUse) { eliminated = true; reasons.push("commercial use is not allowed"); }
    if (!provider.supportsPortrait) { eliminated = true; reasons.push("portrait output is unsupported"); }
    if (capability === "tts" && resolved.profile === "production" && provider.ttsCapabilities?.unofficial) { eliminated = true; reasons.push("unofficial providers are excluded from production"); }
    if (definitionById.get(provider.id)?.fallbackOnly && healthyPrimaryAlternative) { eliminated = true; reasons.push("reserved as fallback while a primary provider is healthy"); }
    if (provider.health === "unhealthy" && healthyAlternative) { eliminated = true; reasons.push(`unhealthy after ${provider.stats.consecutiveFailures} consecutive failures`); }
    const preferredIndex = normalizedPreferred.indexOf(provider.id);
    const preference = preferredIndex >= 0 ? Math.max(4, 20 - preferredIndex * 4) : 0;
    if (preference) reasons.push(`profile preference +${preference}`);
    const pronunciation = resolved.highRiskTerms && capability === "tts" ? (provider.stats.pronunciationAccuracy ?? 0.5) * 16 : 0;
    if (pronunciation) reasons.push(`pronunciation ${(provider.stats.pronunciationAccuracy ?? 0.5).toFixed(2)}`);
    const memoryPenalty = provider.id === "f5" && (resolved.memoryPressure || provider.stats.recentCudaOomCount > 0) ? 35 : 0;
    if (memoryPenalty) reasons.push(`GPU memory pressure -${memoryPenalty}`);
    const score = eliminated ? 0 : 100 * (
      provider.quality * weights.quality
      + provider.stats.successRate * weights.success
      + (1 - provider.latency) * weights.latency
      + (1 - provider.cost) * weights.cost
      + healthValue(provider.health) * weights.health
    ) + preference + pronunciation - memoryPenalty;
    reasons.push(`success ${(provider.stats.successRate * 100).toFixed(1)}%`);
    reasons.push(`latency p50=${provider.stats.p50LatencyMs || "prior"} p95=${provider.stats.p95LatencyMs || "prior"}`);
    reasons.push(`health ${provider.health}`);
    return { providerId: provider.id, enabled: provider.enabled, eliminated, score: Number(Math.max(0, score).toFixed(2)), reasons, stats: provider.stats };
  }).sort((left, right) => Number(left.eliminated) - Number(right.eliminated) || right.score - left.score || left.providerId.localeCompare(right.providerId));
  return candidates;
}

export function selectProviderWithAudit(capability: ProviderCapability, preferred: string[] = [], context: Partial<ProviderSelectionContext> = {}) {
  const resolved = resolvedContext(context);
  const candidates = rankProviders(capability, preferred, resolved);
  const selectedCandidate = candidates.find((candidate) => !candidate.eliminated);
  const selected = selectedCandidate ? listProviders(resolved).find((provider) => provider.id === selectedCandidate.providerId) : undefined;
  const audit: ProviderSelectionAudit = {
    capability,
    profile: resolved.profile,
    selectedProviderId: selected?.id,
    context: resolved,
    candidates,
    createdAt: new Date().toISOString(),
  };
  return { selected, audit };
}

export function selectProvider(capability: ProviderCapability, preferred: string[] = [], context: Partial<ProviderSelectionContext> = {}) {
  return selectProviderWithAudit(capability, preferred, context).selected;
}
