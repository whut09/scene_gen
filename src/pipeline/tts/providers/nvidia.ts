import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { getRuntimeConfig, type RuntimeConfig } from "../../../config/runtime-config";
import { getOrCreateMediaCache } from "../../../cache/media-cache";
import { loadTtsPronunciationLexicon } from "../../tts-pronunciation";
import type { PronunciationPlan } from "../../pronunciation/schema";
import { concatNarrationSegments } from "../postprocess";
import { probeDuration, run } from "../process";
import type { AzureTtsResult } from "./azure";

export interface NvidiaTtsResult {
  requestId: string;
  status: "succeeded";
  outputPath: string;
  requestMs: number;
  synthesisText?: string;
  appliedPronunciationPhrases?: string[];
}

export interface NvidiaWorkerRequest {
  requestId: string;
  text: string;
  httpText?: string;
  outputPath: string;
  customDictionary?: Record<string, string>;
}

export const NVIDIA_TTS_FRONTEND_VERSION = "nvidia-magpie-mandarin-acoustic-stability-v18";
export const NVIDIA_TTS_MAX_CHUNK_CHARACTERS = 20;

export function isRetryableNvidiaTtsError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /unavailable|resource_exhausted|deadline_exceeded|stream removed|stream has been closed|triton model failed|timeout/i.test(message);
}

export function splitNvidiaSynthesisText(text: string, maximumCharacters = NVIDIA_TTS_MAX_CHUNK_CHARACTERS) {
  const chunks: string[] = [];
  let pending = "";
  const flush = () => {
    if (pending.trim()) chunks.push(pending.trim());
    pending = "";
  };
  const append = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const characters = [...trimmed];
    if (characters.length > maximumCharacters) {
      flush();
      for (let index = 0; index < characters.length; index += maximumCharacters) {
        chunks.push(characters.slice(index, index + maximumCharacters).join(""));
      }
      return;
    }
    if ([...pending, ...characters].length <= maximumCharacters) {
      pending += trimmed;
      return;
    }
    flush();
    pending = trimmed;
  };
  for (const sentence of text.split(/(?<=[。！？!?；;])/u)) {
    if ([...sentence].length <= maximumCharacters) {
      append(sentence);
      continue;
    }
    for (const clause of sentence.split(/(?<=[，,、：:])/u)) append(clause);
  }
  flush();
  return chunks;
}

export function encodeNvidiaWorkerRequest(input: NvidiaWorkerRequest) {
  return Buffer.from(`${JSON.stringify(input)}\n`, "utf8");
}

export function nvidiaPronunciationDictionary(plan: PronunciationPlan, text = plan.synthesisText) {
  return Object.fromEntries(
    plan.spans
      .filter((span) => (span.risk === "medium" || span.risk === "high") && text.includes(span.phrase))
      .map((span) => [span.phrase, span.expectedPinyin.join(" ")]),
  );
}

export function nvidiaHttpFallbackText(plan: PronunciationPlan, text = plan.synthesisText) {
  return plan.spans.reduceRight((output, span) => {
    if (!text.includes(span.phrase) || !span.spokenFallback || (span.risk !== "medium" && span.risk !== "high")) return output;
    return output.replaceAll(span.phrase, span.spokenFallback);
  }, text);
}

export function nvidiaTtsCacheIdentity(input: { plan: PronunciationPlan; cacheSalt?: string }, config: RuntimeConfig) {
  return {
    provider: "nvidia",
    model: config.tts.nvidia.model,
    voice: config.tts.nvidia.voice,
    language: config.tts.nvidia.language,
    sampleRateHz: config.tts.nvidia.sampleRateHz,
    transport: config.tts.nvidia.transport,
    speed: config.tts.nvidia.speed,
    synthesisText: input.plan.synthesisText,
    httpFallbackText: nvidiaHttpFallbackText(input.plan),
    pronunciationPlanHash: input.plan.planHash,
    frontendVersion: NVIDIA_TTS_FRONTEND_VERSION,
    cacheSalt: input.cacheSalt ?? "",
  };
}

class NvidiaWorker {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private buffer = "";
  private pending = new Map<string, { resolve: (value: NvidiaTtsResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private readonly config: RuntimeConfig) {}
  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const cfg = this.config.tts.nvidia;
      const child = spawn(cfg.python, [cfg.workerScript, "--endpoint", cfg.endpoint, "--function-id", cfg.functionId, "--voice", cfg.voice, "--language", cfg.language, "--sample-rate", String(cfg.sampleRateHz), "--lexicon", loadTtsPronunciationLexicon().filePath, "--transport", cfg.transport], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", NVIDIA_API_KEY: cfg.apiKey } });
      this.child = child;
      child.unref();
      (child.stdin as NodeJS.WritableStream & { unref?: () => void }).unref?.();
      (child.stdout as NodeJS.ReadableStream & { unref?: () => void }).unref?.();
      (child.stderr as NodeJS.ReadableStream & { unref?: () => void }).unref?.();
      const readyTimer = setTimeout(() => reject(new Error("NVIDIA TTS worker ready timeout.")), cfg.readyTimeoutMs);
      child.stdout.on("data", (chunk) => {
        this.buffer += chunk.toString();
        let newline = this.buffer.indexOf("\n");
        while (newline >= 0) {
          const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1); newline = this.buffer.indexOf("\n");
          if (!line) continue;
          const message = JSON.parse(line);
          if (message.type === "ready") { clearTimeout(readyTimer); resolve(); continue; }
          const pending = this.pending.get(message.requestId); if (!pending) continue;
          clearTimeout(pending.timer); this.pending.delete(message.requestId);
          message.status === "succeeded" ? pending.resolve(message) : pending.reject(new Error(`${message.errorType}: ${message.error}`));
        }
      });
      let stderr = ""; child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
      child.on("exit", (code) => { const error = new Error(`NVIDIA TTS worker exited ${code}: ${stderr}`); reject(error); for (const item of this.pending.values()) item.reject(error); this.pending.clear(); this.child = undefined; this.ready = undefined; });
      child.on("error", reject);
    });
    return this.ready;
  }
  async synthesize(text: string, outputPath: string, customDictionary?: Record<string, string>, signal?: AbortSignal, httpText?: string) {
    await this.start();
    if (signal?.aborted) throw signal.reason;
    const requestId = randomUUID();
    return new Promise<NvidiaTtsResult>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); this.child?.kill(); reject(new Error("NVIDIA TTS request timeout.")); }, this.config.tts.nvidia.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.child!.stdin.write(encodeNvidiaWorkerRequest({ requestId, text, httpText, outputPath, customDictionary }));
    });
  }
  restart() {
    const error = new Error("NVIDIA TTS worker restarted after a transient stream failure.");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.buffer = "";
    const child = this.child;
    this.child = undefined;
    this.ready = undefined;
    if (child && !child.killed) child.kill();
  }
}

let worker: NvidiaWorker | undefined;

export async function nvidiaTts(input: { plan: PronunciationPlan; outputPath: string; force?: boolean; cacheSalt?: string; signal?: AbortSignal }, config = getRuntimeConfig()): Promise<{ reused: boolean; cacheKey: string; result: AzureTtsResult }> {
  if (!config.tts.nvidia.apiKey) throw new Error("NVIDIA_API_KEY is not configured.");
  const identity = nvidiaTtsCacheIdentity(input, config);
  const cacheKey = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  let generated: NvidiaTtsResult | undefined;
  const cached = await getOrCreateMediaCache({
    kind: "audio",
    cacheKey,
    extension: ".wav",
    targetPath: input.outputPath,
    identity,
    force: input.force,
    signal: input.signal,
    generate: async (targetPath) => {
      worker ??= new NvidiaWorker(config);
      const chunks = splitNvidiaSynthesisText(input.plan.synthesisText);
      const partPaths = chunks.map((_, index) => `${targetPath}.part-${String(index + 1).padStart(2, "0")}.wav`);
      const naturalPath = `${targetPath}.natural.wav`;
      const partDurations: number[] = [];
      let requestMs = 0;
      try {
        for (let index = 0; index < chunks.length; index += 1) {
          const customDictionary = nvidiaPronunciationDictionary(input.plan, chunks[index]);
          let result: NvidiaTtsResult | undefined;
          let lastError: Error | undefined;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              result = await worker.synthesize(chunks[index], partPaths[index], customDictionary, input.signal, nvidiaHttpFallbackText(input.plan, chunks[index]));
              break;
            } catch (error) {
              lastError = error as Error;
              if (!isRetryableNvidiaTtsError(lastError) || attempt === 2) throw lastError;
              worker.restart();
              await new Promise((resolve) => setTimeout(resolve, 750 * (2 ** attempt) + Math.floor(Math.random() * 250)));
            }
          }
          if (!result) throw lastError ?? new Error("NVIDIA TTS request failed without a result.");
          const missingHighRiskPhrase = input.plan.spans.find((span) =>
            (span.risk === "medium" || span.risk === "high") &&
            chunks[index].includes(span.phrase) &&
            !Object.hasOwn(customDictionary, span.phrase),
          );
          if (missingHighRiskPhrase) throw new Error(`NVIDIA pronunciation dictionary omitted phrase: ${missingHighRiskPhrase.phrase}`);
          requestMs += result.requestMs;
          const duration = await probeDuration(partPaths[index]);
          if (duration <= 0) throw new Error(`NVIDIA TTS chunk ${index + 1} is empty or invalid.`);
          const spokenCharacters = [...chunks[index]].filter((character) => /[\p{L}\p{N}]/u.test(character)).length;
          const minimumExpectedDuration = Math.max(0.35, spokenCharacters / 14);
          if (duration < minimumExpectedDuration) throw new Error(`NVIDIA TTS chunk ${index + 1} was truncated: ${duration.toFixed(2)}s for ${spokenCharacters} spoken characters.`);
          partDurations.push(duration);
        }
        if (partPaths.length === 1) await normalizeNvidiaPart(partPaths[0], naturalPath);
        else {
          const normalizedPaths = partPaths.map((partPath) => `${partPath}.normalized.wav`);
          for (let index = 0; index < partPaths.length; index += 1) await normalizeNvidiaPart(partPaths[index], normalizedPaths[index]);
          const normalizedDurations = await Promise.all(normalizedPaths.map(probeDuration));
          await concatNarrationSegments(normalizedPaths, normalizedDurations, normalizedDurations.map((_, index) => index === normalizedDurations.length - 1 ? 0 : 0.06), naturalPath);
          await Promise.all(normalizedPaths.map((partPath) => rm(partPath, { force: true }).catch(() => undefined)));
        }
        if (config.tts.nvidia.speed === 1) await renamePart(naturalPath, targetPath);
        else await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", naturalPath, "-filter:a", `atempo=${config.tts.nvidia.speed}`, "-c:a", "pcm_s16le", targetPath]);
        generated = { requestId: randomUUID(), status: "succeeded", outputPath: targetPath, requestMs, synthesisText: input.plan.synthesisText, appliedPronunciationPhrases: Object.keys(nvidiaPronunciationDictionary(input.plan)) };
        return { requestMs, synthesisText: input.plan.synthesisText, chunkCount: chunks.length, voice: config.tts.nvidia.voice, appliedPronunciationPhrases: generated.appliedPronunciationPhrases };
      } finally {
        await Promise.all([...partPaths, naturalPath].map((partPath) => rm(partPath, { force: true }).catch(() => undefined)));
      }
    },
  });
  const raw = generated ?? { requestId: `cache-${cacheKey.slice(0, 12)}`, status: "succeeded" as const, outputPath: input.outputPath, requestMs: 0 };
  return { reused: !cached.generated, cacheKey, result: { requestId: raw.requestId, sceneIndex: 0, status: "succeeded", outputPath: input.outputPath, durationSeconds: await probeDuration(input.outputPath), requestMs: raw.requestMs, retryCount: 0, billedCharacters: [...input.plan.synthesisText].length, voice: config.tts.nvidia.voice, region: config.tts.nvidia.endpoint, retryable: false, providerRequestId: raw.requestId, budgetUsedCharacters: 0, budgetRemainingCharacters: Number.MAX_SAFE_INTEGER, budgetWarning: false } };
}

async function renamePart(partPath: string, targetPath: string) {
  const { rename } = await import("node:fs/promises");
  await rename(partPath, targetPath);
}

async function normalizeNvidiaPart(partPath: string, targetPath: string) {
  await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-i", partPath,
    "-af", "silenceremove=start_periods=1:start_duration=0.025:start_threshold=-52dB:stop_periods=1:stop_duration=0.04:stop_threshold=-52dB,afade=t=in:st=0:d=0.015,areverse,afade=t=in:st=0:d=0.04,areverse,loudnorm=I=-19:TP=-2:LRA=7",
    "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", targetPath,
  ]);
}

export async function inspectNvidiaTts(config = getRuntimeConfig()) { if (!config.tts.nvidia.apiKey) throw new Error("NVIDIA_API_KEY is not configured."); worker ??= new NvidiaWorker(config); await worker.start(); return { endpoint: config.tts.nvidia.endpoint, voice: config.tts.nvidia.voice }; }
