import { createHash } from "node:crypto";
import { z } from "zod";
import type { PronunciationPlan } from "../pipeline/pronunciation/schema";
import { selectProviderWithAudit } from "./provider-registry";
import { quotaAllowsProvider, type ProviderQuotaStatus } from "./provider-quota";
import type { ProviderCandidateDecision } from "./types";
import type { ProviderSelectionAudit } from "./types";

export const pronunciationStrategySchema = z.enum(["retry-verifier", "switch-pronunciation-mode", "use-spoken-fallback", "switch-tts-provider", "manual-confirmation"]);
export type PronunciationStrategy = z.infer<typeof pronunciationStrategySchema>;

export interface PronunciationAttemptIdentity {
  phraseFingerprint: string;
  provider: string;
  pronunciationStrategy: PronunciationStrategy;
  pronunciationPlanHash: string;
}

export interface PronunciationAttemptLedgerState {
  attempts: string[];
  sceneGenerationCounts: Record<string, number>;
  sceneProviderSwitchCounts: Record<string, number>;
  sceneVerificationCounts: Record<string, number>;
  avoidedTtsRegenerationCount: number;
}

export interface TtsRoutingDecision {
  selectedProvider?: string;
  candidates: ProviderCandidateDecision[];
  pronunciationStrategy: PronunciationStrategy;
  quota?: ProviderQuotaStatus;
  manualConfirmationRequired: boolean;
  phraseFingerprint: string;
  audit: ProviderSelectionAudit;
}

export function phraseFingerprint(phrases: string[]) {
  return createHash("sha256").update([...new Set(phrases.map((item) => item.trim()).filter(Boolean))].sort().join("\n")).digest("hex");
}

export function pronunciationAttemptKey(identity: PronunciationAttemptIdentity) {
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export class PronunciationAttemptLedger {
  private readonly attempts = new Set<string>();
  private readonly sceneGenerationCounts = new Map<number, number>();
  private readonly sceneProviderSwitchCounts = new Map<number, number>();
  private readonly sceneVerificationCounts = new Map<number, number>();
  avoidedTtsRegenerationCount = 0;

  constructor(state?: Partial<PronunciationAttemptLedgerState>) {
    for (const key of state?.attempts ?? []) this.attempts.add(key);
    for (const [key, value] of Object.entries(state?.sceneGenerationCounts ?? {})) this.sceneGenerationCounts.set(Number(key), value);
    for (const [key, value] of Object.entries(state?.sceneProviderSwitchCounts ?? {})) this.sceneProviderSwitchCounts.set(Number(key), value);
    for (const [key, value] of Object.entries(state?.sceneVerificationCounts ?? {})) this.sceneVerificationCounts.set(Number(key), value);
    this.avoidedTtsRegenerationCount = state?.avoidedTtsRegenerationCount ?? 0;
  }

  claim(sceneIndex: number, identity: PronunciationAttemptIdentity) {
    const key = pronunciationAttemptKey(identity);
    if (this.attempts.has(key) || (this.sceneGenerationCounts.get(sceneIndex) ?? 0) >= 2) {
      this.avoidedTtsRegenerationCount += 1;
      return false;
    }
    this.attempts.add(key);
    this.sceneGenerationCounts.set(sceneIndex, (this.sceneGenerationCounts.get(sceneIndex) ?? 0) + 1);
    return true;
  }

  claimProviderSwitch(sceneIndex: number) {
    const count = this.sceneProviderSwitchCounts.get(sceneIndex) ?? 0;
    if (count >= 1) return false;
    this.sceneProviderSwitchCounts.set(sceneIndex, count + 1);
    return true;
  }

  claimVerification(sceneIndex: number) {
    const count = this.sceneVerificationCounts.get(sceneIndex) ?? 0;
    if (count >= 1) return false;
    this.sceneVerificationCounts.set(sceneIndex, count + 1);
    return true;
  }

  metrics() {
    return {
      providerSwitchCount: [...this.sceneProviderSwitchCounts.values()].reduce((sum, value) => sum + value, 0),
      verifierRetryCount: [...this.sceneVerificationCounts.values()].reduce((sum, value) => sum + value, 0),
      avoidedTtsRegenerationCount: this.avoidedTtsRegenerationCount,
    };
  }

  snapshot(): PronunciationAttemptLedgerState {
    return {
      attempts: [...this.attempts].sort(),
      sceneGenerationCounts: Object.fromEntries(this.sceneGenerationCounts),
      sceneProviderSwitchCounts: Object.fromEntries(this.sceneProviderSwitchCounts),
      sceneVerificationCounts: Object.fromEntries(this.sceneVerificationCounts),
      avoidedTtsRegenerationCount: this.avoidedTtsRegenerationCount,
    };
  }
}

function preferredProviders(profile: string, highRisk: boolean) {
  if (profile === "ci-offline") return ["mock"];
  if (profile === "indextts-local" || profile === "production") return ["indextts", "nvidia", "f5", "openai", "windows"];
  if (profile === "fast-preview") return ["cloudflare-melotts", "edge", "f5", "windows"];
  if (profile === "local-f5") return ["f5", "nvidia", "openai", "windows"];
  return ["indextts", "nvidia", "openai", "f5", "windows"];
}

export async function routeTtsProvider(input: { profile: string; plan: PronunciationPlan; domain?: string; device?: string; memoryPressure?: boolean; explicitProvider?: string }): Promise<TtsRoutingDecision> {
  const highRisk = input.plan.spans.some((span) => span.risk === "high");
  const phrases = input.plan.spans.filter((span) => span.risk !== "low").map((span) => span.phrase);
  const defaults = preferredProviders(input.profile, highRisk);
  const preferred = input.explicitProvider ? [input.explicitProvider, ...defaults.filter((provider) => provider !== input.explicitProvider)] : defaults;
  const result = selectProviderWithAudit("tts", preferred, { profile: input.profile, language: "zh-CN", domain: input.domain, device: input.device, highRiskTerms: highRisk, memoryPressure: input.memoryPressure });
  if (input.explicitProvider) {
    const explicitCandidate = result.audit.candidates.find((candidate) => candidate.providerId === input.explicitProvider);
    if (explicitCandidate?.enabled && (explicitCandidate.reasons.includes("reserved as fallback while a primary provider is healthy") || explicitCandidate.reasons.some((reason) => reason.startsWith("unhealthy after ")))) {
      explicitCandidate.eliminated = false;
      explicitCandidate.score = Math.max(explicitCandidate.score, 1_000);
      explicitCandidate.reasons.unshift("explicit provider requests one bounded health probe");
    }
    for (const candidate of result.audit.candidates) {
      if (candidate.providerId !== input.explicitProvider && !candidate.eliminated) {
        candidate.eliminated = true;
        candidate.reasons.push(`explicit provider ${input.explicitProvider} requested`);
      }
    }
    explicitCandidate?.reasons.unshift("explicit provider option");
  }
  if (input.profile === "production" && highRisk) {
    for (const candidate of result.audit.candidates) {
      if (!["indextts", "nvidia", "azure", "f5"].includes(candidate.providerId) && !candidate.eliminated) {
        candidate.eliminated = true;
        candidate.reasons.push("production high-risk pronunciation requires explicit phoneme, custom lexicon, or manual confirmation");
      }
    }
  }
  if (highRisk && !input.plan.spans.some((span) => span.risk === "high" && span.spokenFallback)) {
    const edge = result.audit.candidates.find((candidate) => candidate.providerId === "edge");
    if (edge && !edge.eliminated) {
      edge.eliminated = true;
      edge.reasons.push("high-risk pronunciation has no spoken fallback");
    }
  }
  for (const candidate of result.audit.candidates.filter((item) => !item.eliminated)) {
    const quota = await quotaAllowsProvider(candidate.providerId);
    if (!quota.allowed) {
      candidate.eliminated = true;
      candidate.reasons.push(`free quota hard limit reached (${quota.quota.consumed})`);
    }
  }
  const ranked = result.audit.candidates.filter((candidate) => !candidate.eliminated).sort((left, right) => right.score - left.score);
  for (const candidate of ranked) {
    const quota = await quotaAllowsProvider(candidate.providerId);
    result.audit.selectedProviderId = candidate.providerId;
    return {
      selectedProvider: candidate.providerId,
      candidates: result.audit.candidates,
      pronunciationStrategy: highRisk && candidate.providerId === "f5" && input.plan.spans.some((span) => span.spokenFallback) ? "use-spoken-fallback" : highRisk ? "switch-pronunciation-mode" : "switch-tts-provider",
      quota: quota.quota,
      manualConfirmationRequired: false,
      phraseFingerprint: phraseFingerprint(phrases),
      audit: result.audit,
    };
  }
  return { selectedProvider: undefined, candidates: result.audit.candidates, pronunciationStrategy: "manual-confirmation", manualConfirmationRequired: true, phraseFingerprint: phraseFingerprint(phrases), audit: result.audit };
}
