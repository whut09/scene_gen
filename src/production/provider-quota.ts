import type { RuntimeConfig } from "../config/runtime-config";
import { getRuntimeConfig } from "../config/runtime-config";
import { readAzureUsage } from "../pipeline/tts/providers/azure";

export interface ProviderQuotaStatus {
  providerId: string;
  quotaType: "none" | "monthly-characters" | "daily-neurons" | "credits" | "local";
  consumed: number;
  remaining?: number;
  hardLimitReached: boolean;
  configuredForPaidUsage: boolean;
}

function numericEnv(name: string, fallback = 0) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export async function providerQuotaStatus(providerId: string, config: RuntimeConfig = getRuntimeConfig()): Promise<ProviderQuotaStatus> {
  if (providerId === "azure") {
    const usage = await readAzureUsage(config);
    const budget = config.tts.azure.monthlyCharacterBudget;
    return { providerId, quotaType: "monthly-characters", consumed: usage.usedCharacters, remaining: Math.max(0, budget - usage.usedCharacters), hardLimitReached: usage.usedCharacters >= budget, configuredForPaidUsage: false };
  }
  if (providerId === "cloudflare-melotts") {
    const budget = numericEnv("CLOUDFLARE_DAILY_NEURON_BUDGET");
    const consumed = numericEnv("CLOUDFLARE_DAILY_NEURONS_USED");
    return { providerId, quotaType: "daily-neurons", consumed, remaining: budget > 0 ? Math.max(0, budget - consumed) : undefined, hardLimitReached: budget <= 0 || consumed >= budget, configuredForPaidUsage: process.env.CLOUDFLARE_ALLOW_PAID_USAGE === "1" };
  }
  if (providerId === "openai") {
    const budget = numericEnv("OPENAI_TTS_FREE_CHARACTER_BUDGET");
    const consumed = numericEnv("OPENAI_TTS_CHARACTERS_USED");
    const paid = process.env.OPENAI_TTS_ALLOW_PAID_USAGE === "1";
    return { providerId, quotaType: "credits", consumed, remaining: budget > 0 ? Math.max(0, budget - consumed) : undefined, hardLimitReached: !paid && (budget <= 0 || consumed >= budget), configuredForPaidUsage: paid };
  }
  if (["google-tts", "aws-polly", "elevenlabs"].includes(providerId)) {
    const prefix = providerId.replaceAll("-", "_").toUpperCase();
    const budget = numericEnv(`${prefix}_FREE_BUDGET`);
    const consumed = numericEnv(`${prefix}_BUDGET_USED`);
    return { providerId, quotaType: "credits", consumed, remaining: budget > 0 ? Math.max(0, budget - consumed) : undefined, hardLimitReached: budget <= 0 || consumed >= budget, configuredForPaidUsage: process.env[`${prefix}_ALLOW_PAID_USAGE`] === "1" };
  }
  return { providerId, quotaType: providerId === "f5" || providerId === "windows" || providerId === "mock" ? "local" : "none", consumed: 0, hardLimitReached: false, configuredForPaidUsage: false };
}

export async function quotaAllowsProvider(providerId: string, config: RuntimeConfig = getRuntimeConfig()) {
  const quota = await providerQuotaStatus(providerId, config);
  return { quota, allowed: !quota.hardLimitReached || quota.configuredForPaidUsage };
}
