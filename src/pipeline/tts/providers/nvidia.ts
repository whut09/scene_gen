import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getRuntimeConfig, type RuntimeConfig } from "../../../config/runtime-config";
import { getOrCreateMediaCache } from "../../../cache/media-cache";
import { loadTtsPronunciationLexicon } from "../../tts-pronunciation";
import { replaceAcronymsWithSpelledLetters } from "../../pronunciation/provider-adapters";
import type { PronunciationPlan } from "../../pronunciation/schema";
import { probeDuration, run } from "../process";
import type { AzureTtsResult } from "./azure";

export interface NvidiaTtsResult {
  requestId: string;
  status: "succeeded";
  outputPath: string;
  requestMs: number;
  synthesisText?: string;
  appliedPronunciationPhrases?: string[];
  transport?: "grpc" | "http";
  continuousStream?: boolean;
  synthesisUnitCount?: number;
  retryCount?: number;
}

export interface NvidiaWorkerRequest {
  requestId: string;
  text: string;
  textChunks?: string[];
  httpText?: string;
  httpTextChunks?: string[];
  outputPath: string;
  customDictionary?: Record<string, string>;
  continuous?: boolean;
}

export const NVIDIA_TTS_FRONTEND_VERSION = "nvidia-magpie-mandarin-grpc-continuous-narration-v30";
export const NVIDIA_TTS_BATCH_FRONTEND_VERSION = `${NVIDIA_TTS_FRONTEND_VERSION}-batch-v1`;
export const NVIDIA_TTS_MAX_CHUNK_CHARACTERS = 80;
export const NVIDIA_TTS_NORMALIZE_FILTER = "silenceremove=start_periods=1:start_duration=0.025:start_threshold=-52dB,areverse,silenceremove=start_periods=1:start_duration=0.04:start_threshold=-52dB,areverse,afade=t=in:st=0:d=0.015,areverse,afade=t=in:st=0:d=0.04,areverse,loudnorm=I=-19:TP=-2:LRA=7";

export function isRetryableNvidiaTtsError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/longer than maximum|maximum sequence length|invalid pronunciation|unsupported voice|invalid request/i.test(message)) return false;
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

export function nvidiaStableSynthesisText(plan: PronunciationPlan, text = plan.synthesisText) {
  return replaceAcronymsWithSpelledLetters(nvidiaHttpFallbackText(plan, text));
}

function joinNvidiaContinuousTexts(texts: string[]) {
  return texts
    .map((text) => text.trim().replace(/[。！？!?；;]+$/u, ""))
    .filter(Boolean)
    .map((text, index, values) => index === values.length - 1 ? `${text}。` : `${text}。`)
    .join("");
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
    synthesisText: nvidiaStableSynthesisText(input.plan),
    pronunciationPlanHash: input.plan.planHash,
    frontendVersion: NVIDIA_TTS_FRONTEND_VERSION,
    cacheSalt: input.cacheSalt ?? "",
  };
}

export function nvidiaBatchTtsCacheIdentity(input: { plans: PronunciationPlan[]; cacheSalt?: string }, config: RuntimeConfig) {
  const synthesisTexts = input.plans.map((plan) => nvidiaStableSynthesisText(plan));
  return {
    provider: "nvidia",
    mode: "continuous-whole-narration",
    model: config.tts.nvidia.model,
    voice: config.tts.nvidia.voice,
    language: config.tts.nvidia.language,
    sampleRateHz: config.tts.nvidia.sampleRateHz,
    transport: config.tts.nvidia.transport,
    speed: config.tts.nvidia.speed,
    synthesisText: joinNvidiaContinuousTexts(synthesisTexts),
    sceneSynthesisTexts: synthesisTexts,
    pronunciationPlanHashes: input.plans.map((plan) => plan.planHash),
    frontendVersion: NVIDIA_TTS_BATCH_FRONTEND_VERSION,
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
  async synthesize(text: string, outputPath: string, customDictionary?: Record<string, string>, signal?: AbortSignal, httpText?: string, textChunks?: string[], httpTextChunks?: string[], continuous = false) {
    await this.start();
    if (signal?.aborted) throw signal.reason;
    const requestId = randomUUID();
    return new Promise<NvidiaTtsResult>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); this.child?.kill(); reject(new Error("NVIDIA TTS request timeout.")); }, this.config.tts.nvidia.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.child!.stdin.write(encodeNvidiaWorkerRequest({ requestId, text, textChunks, httpText, httpTextChunks, outputPath, customDictionary, continuous }));
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
      const synthesisText = nvidiaStableSynthesisText(input.plan);
      const synthesisUnits = splitNvidiaSynthesisText(synthesisText);
      const partPaths = [`${targetPath}.part-01.wav`];
      const naturalPath = `${targetPath}.natural.wav`;
      let requestMs = 0;
      let retryCount = 0;
      try {
        const customDictionary = nvidiaPronunciationDictionary(input.plan, synthesisText);
        let result: NvidiaTtsResult | undefined;
        let lastError: Error | undefined;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            result = await worker.synthesize(synthesisText, partPaths[0], customDictionary, input.signal, synthesisText, synthesisUnits, synthesisUnits);
            break;
          } catch (error) {
            lastError = error as Error;
            if (!isRetryableNvidiaTtsError(lastError) || attempt === 2) throw lastError;
            retryCount += 1;
            worker.restart();
            await new Promise((resolve) => setTimeout(resolve, 750 * (2 ** attempt) + Math.floor(Math.random() * 250)));
          }
        }
        if (!result) throw lastError ?? new Error("NVIDIA TTS request failed without a result.");
        requestMs += result.requestMs;
        const duration = await probeDuration(partPaths[0]);
        if (duration <= 0) throw new Error("NVIDIA TTS continuous stream is empty or invalid.");
        const spokenCharacters = [...synthesisText].filter((character) => /[\p{L}\p{N}]/u.test(character)).length;
        const minimumExpectedDuration = Math.max(0.35, spokenCharacters / 14);
        if (duration < minimumExpectedDuration) throw new Error(`NVIDIA TTS continuous stream was truncated: ${duration.toFixed(2)}s for ${spokenCharacters} spoken characters.`);
        await normalizeNvidiaPart(partPaths[0], naturalPath);
        const normalizedDuration = await probeDuration(naturalPath);
        if (normalizedDuration < minimumExpectedDuration) throw new Error(`NVIDIA TTS postprocessing truncated the continuous stream: ${normalizedDuration.toFixed(2)}s for ${spokenCharacters} spoken characters.`);
        if (config.tts.nvidia.speed === 1) await renamePart(naturalPath, targetPath);
        else await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", naturalPath, "-filter:a", `atempo=${config.tts.nvidia.speed}`, "-c:a", "pcm_s16le", targetPath]);
        generated = { ...result, requestId: result.requestId || randomUUID(), status: "succeeded", outputPath: targetPath, requestMs, retryCount, synthesisText, appliedPronunciationPhrases: Object.keys(customDictionary) };
        return { requestMs, retryCount, synthesisText, chunkCount: synthesisUnits.length, voice: config.tts.nvidia.voice, transport: generated.transport, continuousStream: generated.continuousStream, synthesisUnitCount: generated.synthesisUnitCount, appliedPronunciationPhrases: generated.appliedPronunciationPhrases };
      } finally {
        await Promise.all([...partPaths, naturalPath].map((partPath) => rm(partPath, { force: true }).catch(() => undefined)));
      }
    },
  });
  const raw = generated ?? { requestId: `cache-${cacheKey.slice(0, 12)}`, status: "succeeded" as const, outputPath: input.outputPath, requestMs: 0, retryCount: 0, transport: config.tts.nvidia.transport === "auto" ? undefined : config.tts.nvidia.transport, continuousStream: config.tts.nvidia.transport === "grpc" };
  return { reused: !cached.generated, cacheKey, result: { requestId: raw.requestId, sceneIndex: 0, status: "succeeded", outputPath: input.outputPath, durationSeconds: await probeDuration(input.outputPath), requestMs: raw.requestMs, retryCount: raw.retryCount ?? 0, billedCharacters: [...input.plan.synthesisText].length, voice: config.tts.nvidia.voice, region: config.tts.nvidia.endpoint, retryable: false, providerRequestId: raw.requestId, budgetUsedCharacters: 0, budgetRemainingCharacters: Number.MAX_SAFE_INTEGER, budgetWarning: false, transport: raw.transport, continuousStream: raw.continuousStream, synthesisUnitCount: raw.synthesisUnitCount } };
}

interface Pcm16Wav {
  sampleRate: number;
  channels: number;
  data: Buffer;
}

function parsePcm16Wav(buffer: Buffer): Pcm16Wav {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") throw new Error("NVIDIA continuous narration returned an unsupported WAV container.");
  let offset = 12;
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let data: Buffer | undefined;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    const bodyEnd = Math.min(buffer.length, bodyStart + chunkSize);
    if (chunkId === "fmt " && bodyEnd - bodyStart >= 16) {
      audioFormat = buffer.readUInt16LE(bodyStart);
      channels = buffer.readUInt16LE(bodyStart + 2);
      sampleRate = buffer.readUInt32LE(bodyStart + 4);
      bitsPerSample = buffer.readUInt16LE(bodyStart + 14);
    }
    if (chunkId === "data") {
      data = buffer.subarray(bodyStart, bodyEnd);
      break;
    }
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }
  if (audioFormat !== 1 || channels !== 1 || bitsPerSample !== 16 || sampleRate <= 0 || !data?.length || data.length % 2 !== 0) {
    throw new Error("NVIDIA continuous narration must be mono PCM 16-bit WAV audio.");
  }
  return { sampleRate, channels, data };
}

function encodePcm16Wav(input: Pcm16Wav, data: Buffer) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(input.channels, 22);
  header.writeUInt32LE(input.sampleRate, 24);
  header.writeUInt32LE(input.sampleRate * input.channels * 2, 28);
  header.writeUInt16LE(input.channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function nvidiaSceneTextWeight(text: string) {
  return Math.max(1, [...text].filter((character) => /[\p{L}\p{N}]/u.test(character)).length);
}

export function nvidiaContinuousTextWeights(texts: string[]) {
  return texts.map(nvidiaSceneTextWeight);
}

function windowRms(data: Buffer, startFrame: number, endFrame: number) {
  const start = Math.max(0, startFrame);
  const end = Math.min(Math.floor(data.length / 2), Math.max(start + 1, endFrame));
  let energy = 0;
  for (let frame = start; frame < end; frame += 1) {
    const sample = data.readInt16LE(frame * 2) / 32768;
    energy += sample * sample;
  }
  return Math.sqrt(energy / Math.max(1, end - start));
}

function findNvidiaBoundary(data: Buffer, sampleRate: number, expectedFrame: number, lowerFrame: number, upperFrame: number) {
  if (upperFrame <= lowerFrame) return Math.max(0, Math.min(Math.floor(data.length / 2), expectedFrame));
  const windowFrames = Math.max(240, Math.round(sampleRate * 0.045));
  const radius = Math.min(Math.round(sampleRate * 0.8), Math.floor((upperFrame - lowerFrame) / 2));
  const start = Math.max(lowerFrame, expectedFrame - radius);
  const end = Math.min(upperFrame, expectedFrame + radius);
  const step = Math.max(1, Math.round(sampleRate * 0.02));
  let selected = Math.max(start, Math.min(end, expectedFrame));
  let selectedScore = Number.POSITIVE_INFINITY;
  for (let candidate = start; candidate <= end; candidate += step) {
    const rms = windowRms(data, candidate - Math.floor(windowFrames / 2), candidate + Math.ceil(windowFrames / 2));
    const distancePenalty = Math.min(0.02, Math.abs(candidate - expectedFrame) / sampleRate * 0.002);
    const score = rms + distancePenalty;
    if (score < selectedScore) {
      selected = candidate;
      selectedScore = score;
    }
  }
  return selected;
}

export async function splitNvidiaContinuousWav(inputPath: string, outputPaths: string[], sceneTexts: string[]) {
  if (outputPaths.length !== sceneTexts.length || outputPaths.length === 0) throw new Error("NVIDIA continuous narration scene split inputs are inconsistent.");
  const wav = parsePcm16Wav(await readFile(inputPath));
  const totalFrames = Math.floor(wav.data.length / 2);
  const weights = nvidiaContinuousTextWeights(sceneTexts);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const boundaries = [0];
  let cumulativeWeight = 0;
  for (let index = 0; index < weights.length - 1; index += 1) {
    cumulativeWeight += weights[index];
    const expectedFrame = Math.round(totalFrames * cumulativeWeight / totalWeight);
    const minimumFrame = Math.round(wav.sampleRate * 0.22);
    const lowerFrame = boundaries[index] + minimumFrame;
    const upperFrame = totalFrames - (weights.length - index - 2) * minimumFrame;
    boundaries.push(findNvidiaBoundary(wav.data, wav.sampleRate, expectedFrame, lowerFrame, upperFrame));
  }
  boundaries.push(totalFrames);
  const durations: number[] = [];
  for (let index = 0; index < outputPaths.length; index += 1) {
    const startFrame = boundaries[index];
    const endFrame = boundaries[index + 1];
    if (endFrame <= startFrame) throw new Error(`NVIDIA continuous narration scene ${index + 1} is empty after boundary detection.`);
    await mkdir(path.dirname(outputPaths[index]), { recursive: true });
    await writeFile(outputPaths[index], encodePcm16Wav(wav, wav.data.subarray(startFrame * 2, endFrame * 2)));
    durations.push((endFrame - startFrame) / wav.sampleRate);
  }
  return durations;
}

export interface NvidiaBatchTtsInput {
  plans: PronunciationPlan[];
  outputPath: string;
  sceneOutputPaths: string[];
  force?: boolean;
  cacheSalt?: string;
  signal?: AbortSignal;
}

export async function nvidiaTtsBatch(input: NvidiaBatchTtsInput, config = getRuntimeConfig()): Promise<{ reused: boolean; cacheKey: string; results: AzureTtsResult[] }> {
  if (!config.tts.nvidia.apiKey) throw new Error("NVIDIA_API_KEY is not configured.");
  if (input.plans.length === 0 || input.plans.length !== input.sceneOutputPaths.length) throw new Error("NVIDIA continuous narration requires one output per pronunciation plan.");
  const identity = nvidiaBatchTtsCacheIdentity({ plans: input.plans, cacheSalt: input.cacheSalt }, config);
  const cacheKey = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const stableTexts = input.plans.map((plan) => nvidiaStableSynthesisText(plan));
  const continuousText = joinNvidiaContinuousTexts(stableTexts);
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
      const rawPath = `${targetPath}.raw.wav`;
      const naturalPath = `${targetPath}.natural.wav`;
      const customDictionary = Object.assign({}, ...input.plans.map((plan, index) => nvidiaPronunciationDictionary(plan, stableTexts[index])));
      let requestMs = 0;
      let retryCount = 0;
      try {
        let result: NvidiaTtsResult | undefined;
        let lastError: Error | undefined;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            result = await worker.synthesize(continuousText, rawPath, customDictionary, input.signal, continuousText, splitNvidiaSynthesisText(continuousText), undefined, true);
            break;
          } catch (error) {
            lastError = error as Error;
            if (!isRetryableNvidiaTtsError(lastError) || attempt === 2) throw lastError;
            retryCount += 1;
            worker.restart();
            await new Promise((resolve) => setTimeout(resolve, 750 * (2 ** attempt) + Math.floor(Math.random() * 250)));
          }
        }
        if (!result) throw lastError ?? new Error("NVIDIA continuous narration failed without a result.");
        requestMs = result.requestMs;
        const naturalDuration = await probeDuration(rawPath);
        const spokenCharacters = [...continuousText].filter((character) => /[\p{L}\p{N}]/u.test(character)).length;
        const minimumExpectedDuration = Math.max(0.35, spokenCharacters / 14);
        if (naturalDuration <= 0 || naturalDuration < minimumExpectedDuration) throw new Error(`NVIDIA continuous narration was truncated: ${naturalDuration.toFixed(2)}s for ${spokenCharacters} spoken characters.`);
        await normalizeNvidiaPart(rawPath, naturalPath);
        const normalizedDuration = await probeDuration(naturalPath);
        if (normalizedDuration < minimumExpectedDuration) throw new Error(`NVIDIA continuous narration postprocessing truncated the audio: ${normalizedDuration.toFixed(2)}s for ${spokenCharacters} spoken characters.`);
        if (config.tts.nvidia.speed === 1) await renamePart(naturalPath, targetPath);
        else await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", naturalPath, "-filter:a", `atempo=${config.tts.nvidia.speed}`, "-c:a", "pcm_s16le", targetPath]);
        generated = { ...result, requestId: result.requestId || randomUUID(), status: "succeeded", outputPath: targetPath, requestMs, retryCount, synthesisText: continuousText, appliedPronunciationPhrases: Object.keys(customDictionary) };
        return { requestMs, retryCount, synthesisText: continuousText, sceneCount: input.plans.length, voice: config.tts.nvidia.voice, transport: generated.transport, continuousStream: generated.continuousStream, synthesisUnitCount: 1, appliedPronunciationPhrases: generated.appliedPronunciationPhrases };
      } finally {
        await Promise.all([rawPath, naturalPath].map((filePath) => rm(filePath, { force: true }).catch(() => undefined)));
      }
    },
  });
  const durations = await splitNvidiaContinuousWav(input.outputPath, input.sceneOutputPaths, stableTexts);
  const raw = generated ?? { requestId: `cache-${cacheKey.slice(0, 12)}`, status: "succeeded" as const, outputPath: input.outputPath, requestMs: 0, retryCount: 0, transport: config.tts.nvidia.transport === "http" ? "http" as const : "grpc" as const, continuousStream: config.tts.nvidia.transport !== "http", synthesisUnitCount: 1 };
  const results = input.plans.map((plan, index) => ({
    requestId: raw.requestId,
    sceneIndex: index,
    status: "succeeded" as const,
    outputPath: input.sceneOutputPaths[index],
    durationSeconds: durations[index],
    requestMs: index === 0 ? raw.requestMs : 0,
    retryCount: index === 0 ? raw.retryCount ?? 0 : 0,
    billedCharacters: [...stableTexts[index]].length,
    voice: config.tts.nvidia.voice,
    region: config.tts.nvidia.endpoint,
    retryable: false,
    providerRequestId: index === 0 ? raw.requestId : undefined,
    budgetUsedCharacters: 0,
    budgetRemainingCharacters: Number.MAX_SAFE_INTEGER,
    budgetWarning: false,
    transport: raw.transport,
    continuousStream: raw.continuousStream,
    synthesisUnitCount: raw.synthesisUnitCount,
  } satisfies AzureTtsResult));
  return { reused: !cached.generated, cacheKey, results };
}

async function renamePart(partPath: string, targetPath: string) {
  const { rename } = await import("node:fs/promises");
  await rename(partPath, targetPath);
}

async function normalizeNvidiaPart(partPath: string, targetPath: string) {
  await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-i", partPath,
    "-af", NVIDIA_TTS_NORMALIZE_FILTER,
    "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", targetPath,
  ]);
}

export async function inspectNvidiaTts(config = getRuntimeConfig()) { if (!config.tts.nvidia.apiKey) throw new Error("NVIDIA_API_KEY is not configured."); worker ??= new NvidiaWorker(config); await worker.start(); return { endpoint: config.tts.nvidia.endpoint, voice: config.tts.nvidia.voice }; }
