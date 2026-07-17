import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import { getRuntimeConfig, runWithRuntimeConfig, type RuntimeConfig } from "../../../config/runtime-config";
import { getOrCreateMediaCache } from "../../../cache/media-cache";
import { runExternalProcess } from "../../external-operation";
import { ensureDir, readJson, writeJsonAtomic } from "../../utils";
import { BoundedTaskQueue } from "../../bounded-task-queue";
import { probeDuration } from "../process";
import type { PronunciationPlan } from "../../pronunciation/schema";
import {
  AZURE_MANDARIN_PHONEME_VERSION,
  AzureSsmlError,
  azureSpokenFallbackText,
  buildAzurePlainSsml,
  buildAzurePronunciationSsml,
  runAzureSsmlSelfTest,
} from "./azure-ssml";

export const AZURE_TTS_FRONTEND_VERSION = "scene-gen-azure-rest-v1";

const azureUsageSchema = z.object({
  version: z.literal(1),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  usedCharacters: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
}).strict();

export interface AzureTtsInput {
  sceneIndex: number;
  displayText: string;
  synthesisText: string;
  ssml?: string;
  pronunciationPlan?: PronunciationPlan;
  voice?: string;
  outputPath: string;
  rate?: string;
  pitch?: string;
  volume?: string;
  style?: string;
  role?: string;
  pronunciationPlanHash: string;
  pronunciationStrategy?: "phoneme" | "spoken-fallback" | "plain";
  cacheSalt?: string;
  force?: boolean;
  signal?: AbortSignal;
}

export interface AzureTtsResult {
  requestId: string;
  sceneIndex: number;
  status: "succeeded" | "failed";
  outputPath: string;
  durationSeconds: number;
  requestMs: number;
  retryCount: number;
  billedCharacters: number;
  voice: string;
  region: string;
  errorType?: string;
  retryable: boolean;
  error?: string;
  providerRequestId?: string;
  budgetUsedCharacters: number;
  budgetRemainingCharacters: number;
  budgetWarning: boolean;
}

export class AzureTtsError extends Error {
  constructor(readonly result: AzureTtsResult) {
    super(result.error ?? "Azure Speech TTS failed.");
    this.name = "AzureTtsError";
  }
}

function escapeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function buildAzureSsml(input: Pick<AzureTtsInput, "synthesisText" | "voice" | "rate" | "pitch" | "volume" | "style" | "role">, config: RuntimeConfig = getRuntimeConfig()) {
  const voice = input.voice ?? config.tts.azure.voice;
  const rate = input.rate ?? "+0%";
  const pitch = input.pitch ?? "+0Hz";
  const volume = input.volume ?? "+0%";
  const style = input.style ?? config.tts.azure.style;
  const role = input.role ?? config.tts.azure.role;
  const prosody = `<prosody rate="${escapeXml(rate)}" pitch="${escapeXml(pitch)}" volume="${escapeXml(volume)}">${escapeXml(input.synthesisText)}</prosody>`;
  const body = style || role
    ? `<mstts:express-as${style ? ` style="${escapeXml(style)}"` : ""}${role ? ` role="${escapeXml(role)}"` : ""}>${prosody}</mstts:express-as>`
    : prosody;
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-CN"><voice name="${escapeXml(voice)}">${body}</voice></speak>`;
}

export function normalizeAzureSsml(ssml: string) {
  return ssml.replace(/>\s+</g, "><").replace(/\s+/g, " ").trim();
}

function assertValidSsml(ssml: string) {
  const validation = XMLValidator.validate(ssml);
  if (validation !== true || !/^<speak\b/i.test(ssml.trim()) || /<!DOCTYPE/i.test(ssml)) {
    const reason = validation === true ? "Expected a speak root without DOCTYPE." : validation.err.msg;
    throw new Error(`Invalid Azure SSML: ${reason}`);
  }
}

export function azureBillableCharacters(text: string) {
  return [...text].reduce((total, character) => total + (/\p{Script=Han}/u.test(character) ? 2 : /\s/u.test(character) ? 0 : 1), 0);
}

function monthKey(now = new Date()) {
  return now.toISOString().slice(0, 7);
}

export function azureUsagePath(config: RuntimeConfig = getRuntimeConfig()) {
  return path.join(config.cache.rootDir, "metadata", "azure-tts-usage.json");
}

async function acquireUsageLock(filePath: string, signal?: AbortSignal) {
  const lockPath = `${filePath}.lock`;
  await ensureDir(path.dirname(lockPath));
  const startedAt = Date.now();
  while (true) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Azure budget wait aborted.");
    try {
      const handle = await open(lockPath, "wx");
      return async () => {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lockStat = await stat(lockPath).catch(() => undefined);
      if (lockStat && Date.now() - lockStat.mtimeMs > 60_000) {
        await rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() - startedAt > 30_000) throw new Error("Timed out waiting for Azure usage budget lock.");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

export async function readAzureUsage(config: RuntimeConfig = getRuntimeConfig()) {
  const fallback = { version: 1 as const, month: monthKey(), usedCharacters: 0, updatedAt: new Date().toISOString() };
  const parsed = await readJson<unknown>(azureUsagePath(config)).then((value) => azureUsageSchema.parse(value)).catch(() => fallback);
  return parsed.month === monthKey() ? parsed : fallback;
}

async function changeAzureUsage(delta: number, config: RuntimeConfig, signal?: AbortSignal) {
  const filePath = azureUsagePath(config);
  const release = await acquireUsageLock(filePath, signal);
  try {
    const current = await readAzureUsage(config);
    const nextUsed = Math.max(0, current.usedCharacters + delta);
    if (delta > 0 && nextUsed > config.tts.azure.monthlyCharacterBudget) {
      return { accepted: false as const, usage: current };
    }
    const usage = azureUsageSchema.parse({ version: 1, month: monthKey(), usedCharacters: nextUsed, updatedAt: new Date().toISOString() });
    await writeJsonAtomic(filePath, usage);
    return { accepted: true as const, usage };
  } finally {
    await release();
  }
}

function budgetStatus(usedCharacters: number, config: RuntimeConfig) {
  const budget = config.tts.azure.monthlyCharacterBudget;
  return {
    budgetUsedCharacters: usedCharacters,
    budgetRemainingCharacters: Math.max(0, budget - usedCharacters),
    budgetWarning: usedCharacters / budget >= config.tts.azure.budgetWarningRatio,
  };
}

function azureEndpoint(config: RuntimeConfig) {
  if (config.tts.azure.endpoint) return config.tts.azure.endpoint;
  if (!config.tts.azure.region) throw new Error("Azure Speech region is not configured.");
  return `https://${config.tts.azure.region}.tts.speech.microsoft.com/cognitiveservices/v1`;
}

export function azureVoicesEndpoint(config: RuntimeConfig = getRuntimeConfig()) {
  if (config.tts.azure.endpoint) {
    const url = new URL(config.tts.azure.endpoint);
    url.pathname = "/cognitiveservices/voices/list";
    url.search = "";
    return url.toString();
  }
  if (!config.tts.azure.region) throw new Error("Azure Speech region is not configured.");
  return `https://${config.tts.azure.region}.tts.speech.microsoft.com/cognitiveservices/voices/list`;
}

function regionLabel(config: RuntimeConfig) {
  return config.tts.azure.region ?? new URL(azureEndpoint(config)).host.split(".")[0] ?? "custom";
}

function sanitizeAzureError(value: string, apiKey?: string) {
  const withoutKey = apiKey ? value.split(apiKey).join("[redacted]") : value;
  return withoutKey.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

function networkErrorType(error: unknown) {
  const code = (error as NodeJS.ErrnoException)?.code ?? (error as { cause?: NodeJS.ErrnoException })?.cause?.code;
  if (code === "ECONNRESET") return { errorType: "connection_reset", retryable: true };
  if (["EAI_AGAIN", "ENOTFOUND", "ETIMEDOUT"].includes(code ?? "")) return { errorType: "network_error", retryable: true };
  return { errorType: "network_error", retryable: false };
}

function responseErrorType(status: number, body: string) {
  if (status === 408) return { errorType: "request_timeout", retryable: true };
  if (status === 429) return { errorType: "rate_limit", retryable: true };
  if (status >= 500) return { errorType: "server_error", retryable: true };
  if (status === 401 || status === 403) return { errorType: "authentication_error", retryable: false };
  if (status === 400 && /phoneme|phonetic|alphabet|pronunciation/i.test(body)) return { errorType: "unsupported_phoneme", retryable: false };
  if (status === 400 && /ssml|xml|voice/i.test(body)) return { errorType: /voice/i.test(body) ? "unsupported_voice" : "invalid_ssml", retryable: false };
  return { errorType: "invalid_request", retryable: false };
}

function delay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Azure retry wait aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  }).finally(() => undefined);
}

let rateLimitSerial = Promise.resolve();
let requestTimestamps: number[] = [];

async function waitForRateLimit(config: RuntimeConfig, signal?: AbortSignal) {
  const task = rateLimitSerial.then(async () => {
    const windowMs = 60_000;
    const now = Date.now();
    requestTimestamps = requestTimestamps.filter((timestamp) => now - timestamp < windowMs);
    if (requestTimestamps.length >= config.tts.azure.requestsPerMinute) {
      await delay(Math.max(1, windowMs - (now - requestTimestamps[0])), signal);
    }
    requestTimestamps = requestTimestamps.filter((timestamp) => Date.now() - timestamp < windowMs);
    requestTimestamps.push(Date.now());
  });
  rateLimitSerial = task.catch(() => undefined);
  await task;
}

function audioExtension(outputFormat: string) {
  if (/mp3/i.test(outputFormat)) return ".mp3";
  if (/ogg|opus/i.test(outputFormat)) return ".ogg";
  return ".raw";
}

async function writeAzureAudio(bytes: Buffer, outputFormat: string, outputPath: string, signal?: AbortSignal) {
  await ensureDir(path.dirname(outputPath));
  if (/^riff-/i.test(outputFormat)) {
    await writeFile(outputPath, bytes);
    return;
  }
  const temporaryPath = `${outputPath}.${randomUUID()}${audioExtension(outputFormat)}`;
  try {
    await writeFile(temporaryPath, bytes);
    const rawMatch = outputFormat.match(/^raw-(\d+)khz-(\d+)bit-mono-pcm$/i);
    const inputArgs = rawMatch
      ? ["-f", `s${rawMatch[2]}le`, "-ar", String(Number(rawMatch[1]) * 1000), "-ac", "1", "-i", temporaryPath]
      : ["-i", temporaryPath];
    await runExternalProcess("ffmpeg", ["-y", "-v", "error", ...inputArgs, "-ac", "1", outputPath], { signal, timeoutMs: 120_000 });
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function resultFailure(input: AzureTtsInput, requestId: string, startedAt: number, retryCount: number, billedCharacters: number, voice: string, config: RuntimeConfig, errorType: string, retryable: boolean, error: string, providerRequestId?: string, usedCharacters = 0): AzureTtsResult {
  return {
    requestId, sceneIndex: input.sceneIndex, status: "failed", outputPath: input.outputPath, durationSeconds: 0,
    requestMs: Date.now() - startedAt, retryCount, billedCharacters, voice, region: regionLabel(config), errorType, retryable, error,
    providerRequestId, ...budgetStatus(usedCharacters, config),
  };
}

async function synthesizeAzureSpeechInternal(input: AzureTtsInput, config: RuntimeConfig): Promise<AzureTtsResult> {
  await runAzureSsmlSelfTest();
  const requestId = randomUUID();
  const startedAt = Date.now();
  const voice = input.voice ?? config.tts.azure.voice;
  let ssml: string;
  try {
    ssml = normalizeAzureSsml(input.ssml ?? (input.pronunciationPlan
      ? buildAzurePronunciationSsml(input.pronunciationPlan, { voice, rate: input.rate, pitch: input.pitch, volume: input.volume, style: input.style ?? config.tts.azure.style, role: input.role ?? config.tts.azure.role })
      : buildAzureSsml({ ...input, voice }, config)));
    assertValidSsml(ssml);
  } catch (error) {
    const usage = await readAzureUsage(config);
    const errorType = error instanceof AzureSsmlError ? error.errorType : "invalid_ssml";
    throw new AzureTtsError(resultFailure(input, requestId, startedAt, 0, 0, voice, config, errorType, false, (error as Error).message, undefined, usage.usedCharacters));
  }
  const apiKey = config.tts.azure.apiKey;
  if (!apiKey) {
    const usage = await readAzureUsage(config);
    throw new AzureTtsError(resultFailure(input, requestId, startedAt, 0, 0, voice, config, "configuration_error", false, "Azure Speech API key is not configured.", undefined, usage.usedCharacters));
  }
  const billedCharacters = azureBillableCharacters(input.synthesisText);
  const reservation = await changeAzureUsage(billedCharacters, config, input.signal);
  if (!reservation.accepted) {
    throw new AzureTtsError(resultFailure(input, requestId, startedAt, 0, 0, voice, config, "budget_exceeded", false, `Azure monthly character budget would be exceeded (${reservation.usage.usedCharacters}/${config.tts.azure.monthlyCharacterBudget}).`, undefined, reservation.usage.usedCharacters));
  }

  let retryCount = 0;
  let providerRequestId: string | undefined;
  try {
    for (let attempt = 0; attempt <= config.tts.azure.maxRetries; attempt += 1) {
      if (input.signal?.aborted) throw input.signal.reason instanceof Error ? input.signal.reason : new Error("Azure Speech request aborted.");
      await waitForRateLimit(config, input.signal);
      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(new Error(`Azure Speech request timed out after ${config.tts.azure.timeoutMs}ms.`)), config.tts.azure.timeoutMs);
      const signal = input.signal ? AbortSignal.any([input.signal, timeoutController.signal]) : timeoutController.signal;
      try {
        const response = await fetch(azureEndpoint(config), {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": apiKey,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": config.tts.azure.outputFormat,
            "User-Agent": "scene-gen",
            "X-Scene-Gen-Request-Id": requestId,
          },
          body: ssml,
          signal,
        });
        providerRequestId = response.headers.get("x-requestid") ?? response.headers.get("x-microsoft-requestid") ?? undefined;
        if (!response.ok) {
          const body = sanitizeAzureError(await response.text(), apiKey);
          const classification = responseErrorType(response.status, body);
          if (classification.retryable && attempt < config.tts.azure.maxRetries) {
            retryCount += 1;
            await delay(300 * 2 ** attempt + Math.floor(Math.random() * 150), input.signal);
            continue;
          }
          throw new AzureTtsError(resultFailure(input, requestId, startedAt, retryCount, billedCharacters, voice, config, classification.errorType, classification.retryable, `Azure Speech request failed with HTTP ${response.status}${body ? `: ${body}` : ""}.`, providerRequestId, reservation.usage.usedCharacters));
        }
        await writeAzureAudio(Buffer.from(await response.arrayBuffer()), config.tts.azure.outputFormat, input.outputPath, input.signal);
        const durationSeconds = await probeDuration(input.outputPath);
        if (durationSeconds <= 0) throw new Error("Azure Speech returned invalid or empty audio.");
        return {
          requestId, sceneIndex: input.sceneIndex, status: "succeeded", outputPath: input.outputPath, durationSeconds,
          requestMs: Date.now() - startedAt, retryCount, billedCharacters, voice, region: regionLabel(config), retryable: false,
          providerRequestId, ...budgetStatus(reservation.usage.usedCharacters, config),
        };
      } catch (error) {
        if (error instanceof AzureTtsError) throw error;
        if (input.signal?.aborted) throw new AzureTtsError(resultFailure(input, requestId, startedAt, retryCount, billedCharacters, voice, config, "cancelled", false, "Azure Speech request was cancelled.", providerRequestId, reservation.usage.usedCharacters));
        const timedOut = timeoutController.signal.aborted;
        const classification = timedOut ? { errorType: "timeout", retryable: true } : networkErrorType(error);
        if (classification.retryable && attempt < config.tts.azure.maxRetries) {
          retryCount += 1;
          await delay(300 * 2 ** attempt + Math.floor(Math.random() * 150), input.signal);
          continue;
        }
        const message = timedOut ? `Azure Speech request timed out after ${config.tts.azure.timeoutMs}ms.` : sanitizeAzureError((error as Error).message, apiKey);
        throw new AzureTtsError(resultFailure(input, requestId, startedAt, retryCount, billedCharacters, voice, config, classification.errorType, classification.retryable, message, providerRequestId, reservation.usage.usedCharacters));
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error("Azure Speech retry loop ended unexpectedly.");
  } catch (error) {
    await changeAzureUsage(-billedCharacters, config).catch(() => undefined);
    if (error instanceof AzureTtsError) throw error;
    const usage = await readAzureUsage(config);
    const cancelled = input.signal?.aborted;
    throw new AzureTtsError(resultFailure(input, requestId, startedAt, retryCount, billedCharacters, voice, config, cancelled ? "cancelled" : "operation_failed", false, cancelled ? "Azure Speech request was cancelled." : sanitizeAzureError((error as Error).message, apiKey), providerRequestId, usage.usedCharacters));
  }
}

const concurrencyQueues = new Map<number, BoundedTaskQueue>();

export function synthesizeAzureSpeech(input: AzureTtsInput, config: RuntimeConfig = getRuntimeConfig()): Promise<AzureTtsResult> {
  if (input.signal?.aborted) {
    return readAzureUsage(config).then((usage) => {
      const voice = input.voice ?? config.tts.azure.voice;
      throw new AzureTtsError(resultFailure(input, randomUUID(), Date.now(), 0, 0, voice, config, "cancelled", false, "Azure Speech request was cancelled.", undefined, usage.usedCharacters));
    });
  }
  let queue = concurrencyQueues.get(config.tts.azure.concurrency);
  if (!queue) {
    queue = new BoundedTaskQueue(config.tts.azure.concurrency);
    concurrencyQueues.set(config.tts.azure.concurrency, queue);
  }
  return queue.run(() => synthesizeAzureSpeechInternal(input, config));
}

export function azureCacheIdentity(input: AzureTtsInput, config: RuntimeConfig = getRuntimeConfig()) {
  const voice = input.voice ?? config.tts.azure.voice;
  const strategy = input.pronunciationStrategy ?? (input.pronunciationPlan ? "phoneme" : "plain");
  const ssml = normalizeAzureSsml(input.ssml ?? (input.pronunciationPlan
    ? buildAzurePronunciationSsml(input.pronunciationPlan, { voice, rate: input.rate, pitch: input.pitch, volume: input.volume, style: input.style ?? config.tts.azure.style, role: input.role ?? config.tts.azure.role })
    : buildAzureSsml({ ...input, voice }, config)));
  return {
    provider: "azure",
    voice,
    outputFormat: config.tts.azure.outputFormat,
    normalizedSsml: ssml,
    pronunciationPlanHash: input.pronunciationPlanHash,
    pronunciationStrategy: strategy,
    azureMandarinPhonemeVersion: AZURE_MANDARIN_PHONEME_VERSION,
    rate: input.rate ?? "+0%",
    pitch: input.pitch ?? "+0Hz",
    volume: input.volume ?? "+0%",
    style: input.style ?? config.tts.azure.style ?? "",
    role: input.role ?? config.tts.azure.role ?? "",
    providerFrontendVersion: AZURE_TTS_FRONTEND_VERSION,
    cacheSalt: input.cacheSalt ?? "",
  };
}

export function azureCacheKey(input: AzureTtsInput, config: RuntimeConfig = getRuntimeConfig()) {
  return createHash("sha256").update(JSON.stringify(azureCacheIdentity(input, config))).digest("hex");
}

async function azureTtsWithConfig(input: AzureTtsInput, config: RuntimeConfig) {
  const identity = azureCacheIdentity(input, config);
  const cacheKey = azureCacheKey(input, config);
  let generatedResult: AzureTtsResult | undefined;
  const cache = await getOrCreateMediaCache({
    kind: "audio",
    cacheKey,
    extension: ".wav",
    targetPath: input.outputPath,
    identity,
    force: input.force || config.tts.forceRebuild,
    signal: input.signal,
    generate: async (cacheOutputPath) => {
      generatedResult = await synthesizeAzureSpeech({ ...input, outputPath: cacheOutputPath }, config);
      return {
        requestMs: generatedResult.requestMs,
        retryCount: generatedResult.retryCount,
        billedCharacters: generatedResult.billedCharacters,
        providerRequestId: generatedResult.providerRequestId ?? "",
        voice: generatedResult.voice,
        region: generatedResult.region,
      };
    },
  });
  if (generatedResult) return { result: { ...generatedResult, outputPath: input.outputPath }, reused: false, cacheKey };
  const usage = await readAzureUsage(config);
  const details = cache.metadata.details;
  return {
    result: {
      requestId: `cache-${cacheKey.slice(0, 12)}`, sceneIndex: input.sceneIndex, status: "succeeded" as const, outputPath: input.outputPath,
      durationSeconds: await probeDuration(input.outputPath), requestMs: 0, retryCount: 0, billedCharacters: 0,
      voice: String(details.voice ?? input.voice ?? config.tts.azure.voice), region: String(details.region ?? regionLabel(config)), retryable: false,
      providerRequestId: undefined, ...budgetStatus(usage.usedCharacters, config),
    },
    reused: true,
    cacheKey,
  };
}

export function azureTts(input: AzureTtsInput, config: RuntimeConfig = getRuntimeConfig()) {
  return runWithRuntimeConfig(config, async () => {
    try {
      return await azureTtsWithConfig(input, config);
    } catch (error) {
      if (error instanceof AzureSsmlError) {
        const usage = await readAzureUsage(config);
        throw new AzureTtsError(resultFailure(input, randomUUID(), Date.now(), 0, 0, input.voice ?? config.tts.azure.voice, config, error.errorType, false, error.message, undefined, usage.usedCharacters));
      }
      if (!(error instanceof AzureTtsError) || error.result.errorType !== "unsupported_phoneme" || !input.pronunciationPlan) throw error;
      const fallbackText = azureSpokenFallbackText(input.pronunciationPlan);
      if (!fallbackText) throw error;
      return azureTtsWithConfig({
        ...input,
        synthesisText: fallbackText,
        ssml: buildAzurePlainSsml(fallbackText, { voice: input.voice ?? config.tts.azure.voice, rate: input.rate, pitch: input.pitch, volume: input.volume, style: input.style ?? config.tts.azure.style, role: input.role ?? config.tts.azure.role }),
        pronunciationPlan: undefined,
        pronunciationStrategy: "spoken-fallback",
      }, config);
    }
  });
}

export async function inspectAzureVoice(config: RuntimeConfig = getRuntimeConfig(), signal?: AbortSignal) {
  if (!config.tts.azure.apiKey) throw new Error("Azure Speech API key is not configured.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(15_000, config.tts.azure.timeoutMs));
  try {
    const response = await fetch(azureVoicesEndpoint(config), {
      headers: { "Ocp-Apim-Subscription-Key": config.tts.azure.apiKey },
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    });
    if (!response.ok) throw new Error(`Azure voices endpoint returned HTTP ${response.status}.`);
    const voices = z.array(z.object({ ShortName: z.string(), Locale: z.string().optional() }).passthrough()).parse(await response.json());
    return { voiceFound: voices.some((voice) => voice.ShortName === config.tts.azure.voice), voiceCount: voices.length };
  } finally {
    clearTimeout(timer);
  }
}

export function resetAzureProviderStateForTests() {
  rateLimitSerial = Promise.resolve();
  requestTimestamps = [];
  concurrencyQueues.clear();
}
