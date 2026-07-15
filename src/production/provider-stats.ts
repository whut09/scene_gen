import { appendFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { fromRoot } from "../pipeline/utils";
import type { ProviderCapability } from "./types";

export type ProviderHealth = "healthy" | "degraded" | "unhealthy" | "unknown";

export interface ProviderSelectionContext {
  profile: string;
  language?: string;
  domain?: string;
  device?: string;
  highRiskTerms?: boolean;
  memoryPressure?: boolean;
}

export interface ProviderStats {
  samples: number;
  successRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  timeoutRate: number;
  retryRate: number;
  actualCostPer1000Chars?: number;
  actualCostPerImage?: number;
  actualCostPerSecond?: number;
  qualityScore: number;
  pronunciationAccuracy?: number;
  health: ProviderHealth;
  consecutiveFailures: number;
  lastOutcomeAt?: string;
  recentCudaOomCount: number;
}

const providerOutcomeSchema = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  runId: z.string().optional(),
  providerId: z.string().min(1),
  capability: z.enum(["programmatic", "browser", "stock-video", "image", "video", "tts", "music", "alignment", "llm"]),
  operation: z.string().min(1),
  success: z.boolean(),
  latencyMs: z.number().nonnegative(),
  timeout: z.boolean().default(false),
  retryCount: z.number().int().nonnegative().default(0),
  cost: z.number().nonnegative().default(0),
  unitKind: z.enum(["chars", "images", "seconds", "requests"]),
  unitCount: z.number().nonnegative(),
  qualityScore: z.number().min(0).max(1).optional(),
  pronunciationAccurate: z.boolean().optional(),
  language: z.string().optional(),
  domain: z.string().optional(),
  device: z.string().optional(),
  errorType: z.string().optional(),
});

export type ProviderOutcome = z.infer<typeof providerOutcomeSchema>;

export function providerOutcomeFilePath() {
  return process.env.PROVIDER_OUTCOME_FILE
    ? path.resolve(process.env.PROVIDER_OUTCOME_FILE)
    : fromRoot("data", "provider-stats", "outcomes.jsonl");
}

export function readProviderOutcomes() {
  const filePath = providerOutcomeFilePath();
  if (!existsSync(filePath)) return [] as ProviderOutcome[];
  return readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const parsed = providerOutcomeSchema.safeParse(JSON.parse(line));
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
}

export async function recordProviderOutcome(outcome: Omit<ProviderOutcome, "version" | "createdAt"> & Partial<Pick<ProviderOutcome, "version" | "createdAt">>) {
  if (process.env.PROVIDER_HISTORY_DISABLED === "1") return { recorded: false, filePath: providerOutcomeFilePath() };
  const parsed = providerOutcomeSchema.parse({ version: 1, createdAt: new Date().toISOString(), ...outcome });
  const filePath = providerOutcomeFilePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(parsed)}\n`, "utf8");
  return { recorded: true, filePath };
}

function percentile(values: number[], ratio: number) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function contextQualityOutcomes(outcomes: ProviderOutcome[], context: ProviderSelectionContext) {
  const exact = outcomes.filter((outcome) => (!context.language || !outcome.language || outcome.language === context.language)
    && (!context.domain || !outcome.domain || outcome.domain === context.domain)
    && (!context.device || !outcome.device || outcome.device === context.device));
  return exact.length >= 2 ? exact : outcomes;
}

export function calculateProviderStats(
  providerId: string,
  context: ProviderSelectionContext,
  priors: { quality: number; latency: number; cost: number; pronunciationAccuracy?: number },
  allOutcomes = readProviderOutcomes(),
): ProviderStats {
  const windowSize = Math.max(10, Number(process.env.PROVIDER_STATS_WINDOW ?? 100));
  const outcomes = allOutcomes.filter((outcome) => outcome.providerId === providerId).slice(-windowSize);
  const samples = outcomes.length;
  const qualityOutcomes = contextQualityOutcomes(outcomes, context).filter((outcome) => outcome.qualityScore !== undefined);
  const successRate = samples ? (outcomes.filter((outcome) => outcome.success).length + priors.quality * 4) / (samples + 4) : priors.quality;
  const qualityScore = qualityOutcomes.length
    ? (qualityOutcomes.reduce((sum, outcome) => sum + (outcome.qualityScore ?? priors.quality), 0) + priors.quality * 3) / (qualityOutcomes.length + 3)
    : priors.quality;
  let consecutiveFailures = 0;
  for (const outcome of outcomes.slice().reverse()) {
    if (outcome.success) break;
    consecutiveFailures += 1;
  }
  const timeoutRate = samples ? outcomes.filter((outcome) => outcome.timeout).length / samples : 0;
  const retryRate = samples ? outcomes.filter((outcome) => outcome.retryCount > 0).length / samples : 0;
  const pronunciation = outcomes.filter((outcome) => outcome.pronunciationAccurate !== undefined);
  const recentCudaOomCount = outcomes.slice(-10).filter((outcome) => outcome.errorType === "cuda_oom").length;
  const health: ProviderHealth = consecutiveFailures >= 3 || successRate < 0.5
    ? "unhealthy"
    : consecutiveFailures >= 2 || timeoutRate > 0.25 || recentCudaOomCount > 0
      ? "degraded"
      : samples ? "healthy" : "unknown";
  const unitCost = (kind: ProviderOutcome["unitKind"], scale: number) => {
    const relevant = outcomes.filter((outcome) => outcome.unitKind === kind && outcome.unitCount > 0);
    return relevant.length ? relevant.reduce((sum, outcome) => sum + outcome.cost / outcome.unitCount * scale, 0) / relevant.length : undefined;
  };
  return {
    samples,
    successRate: Number(successRate.toFixed(4)),
    p50LatencyMs: percentile(outcomes.map((outcome) => outcome.latencyMs).filter((value) => value > 0), 0.5),
    p95LatencyMs: percentile(outcomes.map((outcome) => outcome.latencyMs).filter((value) => value > 0), 0.95),
    timeoutRate: Number(timeoutRate.toFixed(4)),
    retryRate: Number(retryRate.toFixed(4)),
    actualCostPer1000Chars: unitCost("chars", 1000),
    actualCostPerImage: unitCost("images", 1),
    actualCostPerSecond: unitCost("seconds", 1),
    qualityScore: Number(qualityScore.toFixed(4)),
    pronunciationAccuracy: pronunciation.length
      ? Number((pronunciation.filter((outcome) => outcome.pronunciationAccurate).length / pronunciation.length).toFixed(4))
      : priors.pronunciationAccuracy,
    health,
    consecutiveFailures,
    lastOutcomeAt: outcomes.at(-1)?.createdAt,
    recentCudaOomCount,
  };
}

export function providerCostMetric(stats: ProviderStats, capability: ProviderCapability, prior: number) {
  if (capability === "tts" && stats.actualCostPer1000Chars !== undefined) return Math.min(1, stats.actualCostPer1000Chars / Math.max(0.001, Number(process.env.PROVIDER_TTS_COST_REFERENCE ?? 0.03)));
  if (capability === "image" && stats.actualCostPerImage !== undefined) return Math.min(1, stats.actualCostPerImage / Math.max(0.001, Number(process.env.PROVIDER_IMAGE_COST_REFERENCE ?? 0.5)));
  if (capability === "video" && stats.actualCostPerSecond !== undefined) return Math.min(1, stats.actualCostPerSecond / Math.max(0.001, Number(process.env.PROVIDER_VIDEO_COST_REFERENCE ?? 0.2)));
  return prior;
}
