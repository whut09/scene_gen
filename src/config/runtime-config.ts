import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { defaultOutputDir } from "../runtime/runtime-paths";
import { resolveF5PythonCommand, resolveF5ReferenceAudio } from "../runtime/runtime-paths";
import { fromRoot } from "../pipeline/utils";
import { loadConfigProfile } from "./config-profiles";

const positiveNumber = z.number().finite().positive();
const nonnegativeNumber = z.number().finite().nonnegative();
const positiveInteger = z.number().int().positive();

export const runtimeConfigSchema = z.object({
  version: z.literal(1),
  profile: z.string().min(1),
  llm: z.object({
    news: z.object({ apiKey: z.string().optional(), baseUrl: z.string().optional(), model: z.string().optional() }),
    quality: z.object({ enabled: z.boolean(), apiKey: z.string().optional(), baseUrl: z.string().optional(), model: z.string().optional(), timeoutMs: positiveInteger, samples: z.number().int().min(1).max(2), maxScoreDelta: positiveNumber }),
    revisionFallbackModel: z.string().optional(),
  }),
  tts: z.object({
    provider: z.enum(["nvidia", "azure", "cloudflare-melotts", "edge", "openai", "f5", "local", "mock"]),
    providerFallback: z.enum(["nvidia", "azure", "cloudflare-melotts", "edge", "openai", "f5", "local", "mock"]).optional(),
    failFast: z.boolean(), durationPolicy: z.enum(["natural", "fit"]), fitTarget: z.boolean(), forceRebuild: z.boolean(), leadingSilenceSeconds: z.number().finite().min(0).max(3).default(1.2),
    fetchTimeoutMs: positiveInteger, minTempo: positiveNumber, maxTempo: positiveNumber, preprocessConcurrency: positiveInteger, ffmpegConcurrency: positiveInteger,
    azure: z.object({
      endpoint: z.string().url().optional(), region: z.string().optional(), apiKey: z.string().optional(), voice: z.string().min(1), outputFormat: z.string().min(1),
      style: z.string().optional(), role: z.string().optional(), timeoutMs: positiveInteger, maxRetries: z.number().int().nonnegative(),
      monthlyCharacterBudget: positiveInteger, budgetWarningRatio: z.number().min(0).max(1), concurrency: positiveInteger, requestsPerMinute: positiveInteger,
    }).default({ voice: "zh-CN-XiaoxiaoNeural", outputFormat: "riff-24khz-16bit-mono-pcm", timeoutMs: 120_000, maxRetries: 2, monthlyCharacterBudget: 500_000, budgetWarningRatio: 0.8, concurrency: 2, requestsPerMinute: 20 }),
    nvidia: z.object({ apiKey: z.string().optional(), endpoint: z.string().min(1), functionId: z.string().uuid(), model: z.string().min(1), voice: z.string().min(1), language: z.string().min(1), sampleRateHz: positiveInteger, speed: z.number().finite().min(0.5).max(2).default(1), concurrency: positiveInteger, timeoutMs: positiveInteger, readyTimeoutMs: positiveInteger, python: z.string().min(1), workerScript: z.string().min(1), transport: z.enum(["auto", "grpc", "http"]).default("auto") }),
    openai: z.object({ apiKey: z.string().optional(), baseUrl: z.string(), model: z.string(), voice: z.string(), speed: positiveNumber, concurrency: positiveInteger, costPer1kChars: nonnegativeNumber }),
    cloudflare: z.object({ accountId: z.string().optional(), apiToken: z.string().optional(), model: z.string(), concurrency: positiveInteger, dailyNeuronBudget: nonnegativeNumber }).default({ model: "@cf/myshell-ai/melotts", concurrency: 2, dailyNeuronBudget: 0 }),
    edge: z.object({ command: z.string().optional(), voice: z.string(), concurrency: positiveInteger }).default({ voice: "zh-CN-XiaoxiaoNeural", concurrency: 2 }),
    f5: z.object({ python: z.string().min(1).default(process.platform === "win32" ? "python" : "python3"), model: z.string(), device: z.string(), refAudio: z.string().optional(), refText: z.string(), speed: positiveNumber, uniformSpeed: positiveNumber, nfeStep: positiveInteger, seed: z.number().int(), hfOffline: z.boolean(), workerMode: z.enum(["worker", "cli"]), workerScript: z.string().optional(), workerReadyTimeoutMs: positiveInteger, workerRequestTimeoutMs: positiveInteger, workerMaxRestarts: z.number().int().nonnegative(), gpuMemoryPressure: z.boolean() }),
    local: z.object({ concurrency: positiveInteger, voice: z.string().min(1).default("Microsoft Huihui Desktop"), rate: z.number().int().min(-10).max(10).default(6) }),
    pronunciation: z.object({
      domain: z.string().min(1), g2pwEnabled: z.boolean(), g2pwPython: z.string().min(1), g2pwScript: z.string().min(1),
      g2pwModelDir: z.string().optional(), g2pwReadyTimeoutMs: positiveInteger, g2pwRequestTimeoutMs: positiveInteger,
      g2pwMinimumConfidence: z.number().min(0).max(1),
    }).default({ domain: "software", g2pwEnabled: false, g2pwPython: process.platform === "win32" ? "python" : "python3", g2pwScript: "scripts/g2pw-worker.py", g2pwReadyTimeoutMs: 30_000, g2pwRequestTimeoutMs: 10_000, g2pwMinimumConfidence: 0.75 }),
  }),
  asr: z.object({
    disabled: z.boolean(), provider: z.enum(["whisper", "sensevoice", "funasr", "mock"]).default("whisper"), python: z.string().optional(), model: z.string(), language: z.string(), languageConfidenceMin: z.number().min(0).max(1).default(0.5), titleCoverageMin: z.number().min(0).max(1),
    pronunciation: z.object({
      provider: z.enum(["azure", "mock", "disabled"]), endpoint: z.string().url().optional(), region: z.string().optional(), apiKey: z.string().optional(), timeoutMs: positiveInteger,
      confidenceMin: z.number().min(0).max(1), monthlySecondsBudget: nonnegativeNumber, budgetWarningRatio: z.number().min(0).max(1), minimumAudioMs: positiveInteger,
    }).default({ provider: "disabled", timeoutMs: 45_000, confidenceMin: 0.7, monthlySecondsBudget: 0, budgetWarningRatio: 0.8, minimumAudioMs: 300 }),
  }),
  rendering: z.object({
    engine: z.enum(["remotion", "html-video"]), outputDir: z.string().min(1), screenshotLimit: z.number().int().nonnegative(), motionSceneThreshold: nonnegativeNumber, processTimeoutMs: positiveInteger,
    html: z.object({ concurrency: positiveInteger, memoryPerJobMb: positiveInteger, preset: z.enum(["ultrafast", "veryfast", "medium"]), sceneTimeoutMs: positiveInteger, syncCueCacheBucketMs: positiveInteger }).default({ concurrency: 2, memoryPerJobMb: 1536, preset: "veryfast", sceneTimeoutMs: 300_000, syncCueCacheBucketMs: 120 }),
    visual: z.object({ blankLumaRangeMin: positiveNumber, blankEdgeDensityMin: z.number().min(0).max(1) }).default({ blankLumaRangeMin: 8, blankEdgeDensityMin: 0.006 }),
    templateLearning: z.object({ disabled: z.boolean(), explorationRate: z.number().min(0).max(0.25) }).default({ disabled: false, explorationRate: 0.07 }),
    ocr: z.object({ enabled: z.boolean(), command: z.string(), language: z.string(), keyTextMin: z.number().min(0).max(1) }),
    htmlTemplateExclusions: z.record(z.string(), z.array(z.string())),
  }),
  quality: z.object({ profile: z.enum(["balanced", "strict", "lenient"]), blockingWarningCodes: z.array(z.string()), minDurationFactor: positiveNumber, maxDurationFactor: positiveNumber, minCharsPerSecond: positiveNumber, maxCharsPerSecond: positiveNumber, maxSegmentSpeedRatio: positiveNumber, maxSegmentSpeedCv: nonnegativeNumber }),
  cache: z.object({ rootDir: z.string().min(1), huggingFaceHome: z.string().min(1).default(fromRoot("dist", ".cache", "huggingface")), huggingFaceOffline: z.boolean().default(false), lockTimeoutMs: positiveInteger, staleLockMs: positiveInteger }),
  retry: z.object({ maxIterations: z.number().int().min(1).max(8), videoIterations: z.number().int().min(1).max(3), stageTimeoutMs: z.object({ draft: positiveInteger, draftGate: positiveInteger, revision: positiveInteger, synthesize: positiveInteger, audioGate: positiveInteger, render: positiveInteger, videoGate: positiveInteger }) }),
});

type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T : T extends readonly (infer Item)[] ? readonly DeepReadonly<Item>[] : T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> } : T;

export type RuntimeConfig = DeepReadonly<z.infer<typeof runtimeConfigSchema>>;
export type RuntimeConfigSnapshot = z.infer<typeof runtimeConfigSchema>;

function stringValue(env: NodeJS.ProcessEnv, key: string, fallback?: string) {
  const value = env[key]?.trim();
  return value || fallback;
}

function numberValue(env: NodeJS.ProcessEnv, key: string, fallback: number) {
  const value = Number(env[key] ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

function booleanValue(env: NodeJS.ProcessEnv, key: string, fallback = false) {
  const value = env[key]?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function providerValue(value: string | undefined, fallback: "nvidia" | "azure" | "cloudflare-melotts" | "edge" | "openai" | "f5" | "local" | "mock") {
  return value === "nvidia" || value === "azure" || value === "cloudflare-melotts" || value === "edge" || value === "openai" || value === "f5" || value === "local" || value === "mock" ? value : fallback;
}

function parseTemplateExclusions(value: string | undefined) {
  if (!value) return {};
  try {
    return z.record(z.string(), z.array(z.string())).parse(JSON.parse(value));
  } catch {
    return {};
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function buildRuntimeConfig(env: NodeJS.ProcessEnv = process.env, profile = stringValue(env, "SCENE_GEN_PROFILE", "custom") ?? "custom"): RuntimeConfig {
  const serialized = stringValue(env, "SCENE_GEN_RUNTIME_CONFIG");
  if (serialized) return deepFreeze(runtimeConfigSchema.parse(JSON.parse(serialized))) as RuntimeConfig;
  const qualityApiKey = stringValue(env, "QUALITY_LLM_API_KEY") ?? stringValue(env, "NEWS_LLM_API_KEY") ?? stringValue(env, "OPENAI_API_KEY");
  const qualityBaseUrl = stringValue(env, "QUALITY_LLM_BASE_URL") ?? stringValue(env, "NEWS_LLM_BASE_URL") ?? stringValue(env, "OPENAI_BASE_URL");
  const qualityModel = stringValue(env, "QUALITY_LLM_MODEL") ?? stringValue(env, "NEWS_LLM_MODEL") ?? stringValue(env, "OPENAI_MODEL");
  const qualityProfileValue = stringValue(env, "QUALITY_GATE_PROFILE", "balanced");
  const qualityProfile = qualityProfileValue === "strict" || qualityProfileValue === "lenient" ? qualityProfileValue : "balanced";
  const config = runtimeConfigSchema.parse({
    version: 1,
    profile,
    llm: {
      news: { apiKey: stringValue(env, "NEWS_LLM_API_KEY") ?? stringValue(env, "OPENAI_API_KEY"), baseUrl: stringValue(env, "NEWS_LLM_BASE_URL") ?? stringValue(env, "OPENAI_BASE_URL"), model: stringValue(env, "NEWS_LLM_MODEL") ?? stringValue(env, "OPENAI_MODEL") },
      quality: { enabled: !booleanValue(env, "QUALITY_LLM_DISABLED"), apiKey: qualityApiKey, baseUrl: qualityBaseUrl, model: qualityModel, timeoutMs: numberValue(env, "QUALITY_LLM_TIMEOUT_MS", 90_000), samples: Math.max(1, Math.min(2, numberValue(env, "QUALITY_JUDGE_SAMPLES", qualityProfile === "strict" ? 2 : 1))), maxScoreDelta: numberValue(env, "QUALITY_JUDGE_MAX_SCORE_DELTA", 15) },
      revisionFallbackModel: stringValue(env, "REVISION_LLM_FALLBACK_MODEL"),
    },
    tts: {
      provider: providerValue(stringValue(env, "TTS_PROVIDER"), profile === "local-f5" ? "f5" : "openai"),
      providerFallback: stringValue(env, "TTS_PROVIDER_FALLBACK") ? providerValue(stringValue(env, "TTS_PROVIDER_FALLBACK"), "local") : undefined,
      failFast: booleanValue(env, "TTS_FAIL_FAST"), durationPolicy: stringValue(env, "TTS_DURATION_POLICY", "natural") === "fit" ? "fit" : "natural", fitTarget: stringValue(env, "TTS_FIT_TARGET") !== "0", forceRebuild: booleanValue(env, "TTS_FORCE_REBUILD"), leadingSilenceSeconds: numberValue(env, "TTS_LEADING_SILENCE_SECONDS", 1.2), fetchTimeoutMs: numberValue(env, "TTS_FETCH_TIMEOUT_MS", 180_000), minTempo: numberValue(env, "TTS_MIN_TEMPO", 0.9), maxTempo: numberValue(env, "TTS_MAX_TEMPO", 1.22), preprocessConcurrency: numberValue(env, "TTS_PREPROCESS_CONCURRENCY", 4), ffmpegConcurrency: numberValue(env, "TTS_FFMPEG_CONCURRENCY", 2),
      azure: {
        endpoint: stringValue(env, "AZURE_SPEECH_ENDPOINT"), region: stringValue(env, "AZURE_SPEECH_REGION"), apiKey: stringValue(env, "AZURE_SPEECH_KEY"),
        voice: stringValue(env, "AZURE_TTS_VOICE", "zh-CN-XiaoxiaoNeural")!, outputFormat: stringValue(env, "AZURE_TTS_OUTPUT_FORMAT", "riff-24khz-16bit-mono-pcm")!,
        style: stringValue(env, "AZURE_TTS_STYLE"), role: stringValue(env, "AZURE_TTS_ROLE"), timeoutMs: numberValue(env, "AZURE_TTS_TIMEOUT_MS", 120_000),
        maxRetries: Math.max(0, numberValue(env, "AZURE_TTS_MAX_RETRIES", 2)), monthlyCharacterBudget: Math.max(1, numberValue(env, "AZURE_TTS_MONTHLY_CHARACTER_BUDGET", 500_000)),
        budgetWarningRatio: Math.max(0, Math.min(1, numberValue(env, "AZURE_TTS_BUDGET_WARNING_RATIO", 0.8))), concurrency: Math.max(1, numberValue(env, "AZURE_TTS_CONCURRENCY", 2)),
        requestsPerMinute: Math.max(1, numberValue(env, "AZURE_TTS_REQUESTS_PER_MINUTE", 20)),
      },
      nvidia: { apiKey: stringValue(env, "NVIDIA_API_KEY"), endpoint: stringValue(env, "NVIDIA_TTS_ENDPOINT", "grpc.nvcf.nvidia.com:443")!, functionId: stringValue(env, "NVIDIA_TTS_FUNCTION_ID", "877104f7-e885-42b9-8de8-f6e4c6303969")!, model: stringValue(env, "NVIDIA_TTS_MODEL", "magpie-tts-multilingual")!, voice: stringValue(env, "NVIDIA_TTS_VOICE", "Magpie-Multilingual.ZH-CN.Siwei")!, language: stringValue(env, "NVIDIA_TTS_LANGUAGE", "zh-CN")!, sampleRateHz: numberValue(env, "NVIDIA_TTS_SAMPLE_RATE_HZ", 44100), speed: numberValue(env, "NVIDIA_TTS_SPEED", 1.25), concurrency: numberValue(env, "NVIDIA_TTS_CONCURRENCY", 1), timeoutMs: numberValue(env, "NVIDIA_TTS_TIMEOUT_MS", 180000), readyTimeoutMs: numberValue(env, "NVIDIA_TTS_READY_TIMEOUT_MS", 30000), python: stringValue(env, "NVIDIA_TTS_PYTHON", process.platform === "win32" ? "python" : "python3")!, workerScript: stringValue(env, "NVIDIA_TTS_WORKER_SCRIPT", fromRoot("scripts", "nvidia-tts-worker.py"))!, transport: stringValue(env, "NVIDIA_TTS_TRANSPORT", "auto") === "http" ? "http" : stringValue(env, "NVIDIA_TTS_TRANSPORT") === "grpc" ? "grpc" : "auto" },
      openai: { apiKey: stringValue(env, "OPENAI_TTS_API_KEY") ?? stringValue(env, "OPENAI_API_KEY"), baseUrl: stringValue(env, "OPENAI_TTS_BASE_URL") ?? stringValue(env, "OPENAI_BASE_URL", "https://api.openai.com/v1")!, model: stringValue(env, "OPENAI_TTS_MODEL", "gpt-4o-mini-tts")!, voice: stringValue(env, "OPENAI_TTS_VOICE", "alloy")!, speed: numberValue(env, "OPENAI_TTS_SPEED", 1.12), concurrency: numberValue(env, "OPENAI_TTS_CONCURRENCY", 4), costPer1kChars: numberValue(env, "OPENAI_TTS_COST_PER_1K_CHARS", 0.015) },
      cloudflare: { accountId: stringValue(env, "CLOUDFLARE_ACCOUNT_ID"), apiToken: stringValue(env, "CLOUDFLARE_API_TOKEN"), model: stringValue(env, "CLOUDFLARE_TTS_MODEL", "@cf/myshell-ai/melotts")!, concurrency: Math.max(1, numberValue(env, "CLOUDFLARE_TTS_CONCURRENCY", 2)), dailyNeuronBudget: Math.max(0, numberValue(env, "CLOUDFLARE_DAILY_NEURON_BUDGET", 0)) },
      edge: { command: stringValue(env, "EDGE_TTS_COMMAND"), voice: stringValue(env, "EDGE_TTS_VOICE", "zh-CN-XiaoxiaoNeural")!, concurrency: Math.max(1, numberValue(env, "EDGE_TTS_CONCURRENCY", 2)) },
      f5: { python: resolveF5PythonCommand(env), model: stringValue(env, "F5_TTS_MODEL", "F5TTS_v1_Base")!, device: stringValue(env, "F5_TTS_DEVICE", "cuda")!, refAudio: stringValue(env, "F5_TTS_REF_AUDIO") ?? (resolveF5ReferenceAudio(env) || undefined), refText: stringValue(env, "F5_TTS_REF_TEXT", "")!, speed: numberValue(env, "F5_TTS_SPEED", 1.12), uniformSpeed: numberValue(env, "F5_TTS_UNIFORM_SPEED", 1.25), nfeStep: numberValue(env, "F5_TTS_NFE_STEP", 16), seed: numberValue(env, "F5_TTS_SEED", -1), hfOffline: booleanValue(env, "F5_TTS_HF_OFFLINE", true), workerMode: stringValue(env, "F5_TTS_WORKER_MODE", "worker") === "cli" ? "cli" : "worker", workerScript: stringValue(env, "F5_TTS_WORKER_SCRIPT"), workerReadyTimeoutMs: numberValue(env, "F5_TTS_WORKER_READY_TIMEOUT_MS", 120_000), workerRequestTimeoutMs: numberValue(env, "F5_TTS_WORKER_REQUEST_TIMEOUT_MS", 600_000), workerMaxRestarts: numberValue(env, "F5_TTS_WORKER_MAX_RESTARTS", 1), gpuMemoryPressure: booleanValue(env, "F5_GPU_MEMORY_PRESSURE") },
      local: { concurrency: numberValue(env, "LOCAL_TTS_CONCURRENCY", 1), voice: stringValue(env, "LOCAL_TTS_VOICE", "Microsoft Huihui Desktop")!, rate: numberValue(env, "LOCAL_TTS_RATE", 6) },
      pronunciation: { domain: stringValue(env, "TTS_PRONUNCIATION_DOMAIN", "software")!, g2pwEnabled: booleanValue(env, "G2PW_ENABLED"), g2pwPython: stringValue(env, "G2PW_PYTHON", process.platform === "win32" ? "python" : "python3")!, g2pwScript: stringValue(env, "G2PW_WORKER_SCRIPT", "scripts/g2pw-worker.py")!, g2pwModelDir: stringValue(env, "G2PW_MODEL_DIR"), g2pwReadyTimeoutMs: numberValue(env, "G2PW_READY_TIMEOUT_MS", 30_000), g2pwRequestTimeoutMs: numberValue(env, "G2PW_REQUEST_TIMEOUT_MS", 10_000), g2pwMinimumConfidence: numberValue(env, "G2PW_MIN_CONFIDENCE", 0.75) },
    },
    asr: {
      disabled: booleanValue(env, "ASR_DISABLED"), provider: ["sensevoice", "funasr", "mock"].includes(stringValue(env, "ASR_PROVIDER", "whisper")!) ? stringValue(env, "ASR_PROVIDER") as "sensevoice" | "funasr" | "mock" : "whisper", python: stringValue(env, "ASR_PYTHON"), model: stringValue(env, "ASR_MODEL", "openai/whisper-tiny")!, language: stringValue(env, "ASR_LANGUAGE", "chinese")!, languageConfidenceMin: numberValue(env, "ASR_LANGUAGE_CONFIDENCE_MIN", 0.5), titleCoverageMin: numberValue(env, "ASR_TITLE_COVERAGE_MIN", 0.58),
      pronunciation: {
        provider: stringValue(env, "PRONUNCIATION_VERIFIER_PROVIDER", "disabled") === "azure" ? "azure" : stringValue(env, "PRONUNCIATION_VERIFIER_PROVIDER") === "mock" ? "mock" : "disabled",
        endpoint: stringValue(env, "AZURE_PRONUNCIATION_ENDPOINT"), region: stringValue(env, "AZURE_PRONUNCIATION_REGION", stringValue(env, "AZURE_SPEECH_REGION")), apiKey: stringValue(env, "AZURE_PRONUNCIATION_KEY", stringValue(env, "AZURE_SPEECH_KEY")), timeoutMs: numberValue(env, "PRONUNCIATION_VERIFIER_TIMEOUT_MS", 45_000), confidenceMin: numberValue(env, "PRONUNCIATION_VERIFIER_CONFIDENCE_MIN", 0.7), monthlySecondsBudget: numberValue(env, "AZURE_PRONUNCIATION_MONTHLY_SECONDS_BUDGET", 0), budgetWarningRatio: numberValue(env, "AZURE_PRONUNCIATION_BUDGET_WARNING_RATIO", 0.8), minimumAudioMs: numberValue(env, "PRONUNCIATION_VERIFIER_MIN_AUDIO_MS", 300),
      },
    },
    rendering: { engine: stringValue(env, "VIDEO_RENDER_ENGINE", "html-video") === "remotion" ? "remotion" : "html-video", outputDir: path.resolve(stringValue(env, "VIDEO_OUTPUT_DIR", defaultOutputDir())!), screenshotLimit: numberValue(env, "SCREENSHOT_LIMIT", 0), motionSceneThreshold: numberValue(env, "MOTION_SCENE_THRESHOLD", 0.0005), processTimeoutMs: numberValue(env, "QUALITY_PROCESS_TIMEOUT_MS", 300_000), html: { concurrency: numberValue(env, "HTML_RENDER_CONCURRENCY", 2), memoryPerJobMb: numberValue(env, "HTML_RENDER_MEMORY_PER_JOB_MB", 1536), preset: stringValue(env, "HTML_RENDER_PRESET") === "ultrafast" || stringValue(env, "HTML_RENDER_PRESET") === "medium" ? stringValue(env, "HTML_RENDER_PRESET") : "veryfast", sceneTimeoutMs: numberValue(env, "HTML_RENDER_SCENE_TIMEOUT_MS", 300_000), syncCueCacheBucketMs: numberValue(env, "HTML_SYNC_CUE_CACHE_BUCKET_MS", 120) }, visual: { blankLumaRangeMin: numberValue(env, "VIDEO_BLANK_LUMA_RANGE_MIN", 8), blankEdgeDensityMin: numberValue(env, "VIDEO_BLANK_EDGE_DENSITY_MIN", 0.006) }, templateLearning: { disabled: booleanValue(env, "TEMPLATE_LEARNING_DISABLED"), explorationRate: numberValue(env, "TEMPLATE_EXPLORATION_RATE", 0.07) }, ocr: { enabled: booleanValue(env, "VIDEO_OCR_ENABLED"), command: stringValue(env, "VIDEO_OCR_COMMAND", "tesseract")!, language: stringValue(env, "VIDEO_OCR_LANGUAGE", "chi_sim+eng")!, keyTextMin: numberValue(env, "VIDEO_OCR_KEY_TEXT_MIN", 0.45) }, htmlTemplateExclusions: parseTemplateExclusions(stringValue(env, "HTML_TEMPLATE_EXCLUSIONS")) },
    quality: { profile: qualityProfile, blockingWarningCodes: (stringValue(env, "QUALITY_BLOCKING_WARNING_CODES", "") ?? "").split(",").map((item) => item.trim()).filter(Boolean), minDurationFactor: numberValue(env, "QUALITY_MIN_DURATION_FACTOR", 0.7), maxDurationFactor: numberValue(env, "QUALITY_MAX_DURATION_FACTOR", 1.65), minCharsPerSecond: numberValue(env, "QUALITY_MIN_CHARS_PER_SECOND", 6.3), maxCharsPerSecond: numberValue(env, "QUALITY_MAX_CHARS_PER_SECOND", 11.5), maxSegmentSpeedRatio: numberValue(env, "QUALITY_MAX_SEGMENT_SPEED_RATIO", 1.35), maxSegmentSpeedCv: numberValue(env, "QUALITY_MAX_SEGMENT_SPEED_CV", 0.16) },
    cache: { rootDir: path.resolve(stringValue(env, "SCENE_GEN_CACHE_DIR", fromRoot("dist", "cache"))!), huggingFaceHome: path.resolve(stringValue(env, "HF_HOME", path.join(env.USERPROFILE ?? env.HOME ?? fromRoot("dist"), ".cache", "huggingface"))!), huggingFaceOffline: booleanValue(env, "HF_HUB_OFFLINE"), lockTimeoutMs: numberValue(env, "MEDIA_CACHE_LOCK_TIMEOUT_MS", 600_000), staleLockMs: numberValue(env, "MEDIA_CACHE_STALE_LOCK_MS", 900_000) },
    retry: { maxIterations: Math.max(1, Math.min(8, numberValue(env, "HARNESS_MAX_ITERATIONS", 4))), videoIterations: Math.max(1, Math.min(3, numberValue(env, "HARNESS_VIDEO_ITERATIONS", 2))), stageTimeoutMs: { draft: numberValue(env, "HARNESS_DRAFT_TIMEOUT_MS", 330_000), draftGate: numberValue(env, "HARNESS_DRAFT_GATE_TIMEOUT_MS", 150_000), revision: numberValue(env, "HARNESS_REVISION_TIMEOUT_MS", 180_000), synthesize: numberValue(env, "HARNESS_SYNTHESIZE_TIMEOUT_MS", 930_000), audioGate: numberValue(env, "HARNESS_AUDIO_GATE_TIMEOUT_MS", 360_000), render: numberValue(env, "HARNESS_RENDER_TIMEOUT_MS", 1_830_000), videoGate: numberValue(env, "HARNESS_VIDEO_GATE_TIMEOUT_MS", 480_000) } },
  });
  return deepFreeze(config) as RuntimeConfig;
}

export async function createRuntimeConfig(profileName: string, env: NodeJS.ProcessEnv = process.env) {
  const profile = await loadConfigProfile(profileName);
  return buildRuntimeConfig({ ...profile.env, ...env, SCENE_GEN_PROFILE: profile.name }, profile.name);
}

export function runtimeConfigSnapshot(config: RuntimeConfig): RuntimeConfigSnapshot {
  const snapshot = structuredClone(config) as RuntimeConfigSnapshot;
  snapshot.llm.news.apiKey = undefined;
  snapshot.llm.quality.apiKey = undefined;
  snapshot.tts.azure.apiKey = undefined;
  snapshot.tts.nvidia.apiKey = undefined;
  snapshot.tts.openai.apiKey = undefined;
  snapshot.tts.cloudflare.apiToken = undefined;
  snapshot.asr.pronunciation.apiKey = undefined;
  return runtimeConfigSchema.parse(snapshot);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stableValue(child)]));
  return value;
}

export function runtimeConfigHash(config: RuntimeConfig) {
  return createHash("sha256").update(JSON.stringify(stableValue(runtimeConfigSnapshot(config)))).digest("hex");
}

export function storedRuntimeConfigSnapshotHash(snapshot: unknown) {
  return createHash("sha256").update(JSON.stringify(stableValue(snapshot))).digest("hex");
}

export function compatibleStoredRuntimeConfigSnapshotHashes(snapshot: RuntimeConfigSnapshot) {
  const legacy = structuredClone(snapshot) as unknown as { asr: Record<string, unknown> };
  delete legacy.asr.languageConfidenceMin;
  return new Set([storedRuntimeConfigSnapshotHash(snapshot), storedRuntimeConfigSnapshotHash(legacy)]);
}

export function restoreRuntimeConfig(snapshot: unknown, env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const parsed = runtimeConfigSchema.parse(snapshot);
  const restored = structuredClone(parsed);
  restored.llm.news.apiKey = stringValue(env, "NEWS_LLM_API_KEY") ?? stringValue(env, "OPENAI_API_KEY");
  restored.llm.quality.apiKey = stringValue(env, "QUALITY_LLM_API_KEY") ?? stringValue(env, "NEWS_LLM_API_KEY") ?? stringValue(env, "OPENAI_API_KEY");
  restored.tts.azure.apiKey = stringValue(env, "AZURE_SPEECH_KEY");
  restored.tts.nvidia.apiKey = stringValue(env, "NVIDIA_API_KEY");
  restored.tts.openai.apiKey = stringValue(env, "OPENAI_TTS_API_KEY") ?? stringValue(env, "OPENAI_API_KEY");
  restored.tts.cloudflare.apiToken = stringValue(env, "CLOUDFLARE_API_TOKEN");
  restored.tts.cloudflare.accountId = stringValue(env, "CLOUDFLARE_ACCOUNT_ID") ?? restored.tts.cloudflare.accountId;
  restored.asr.pronunciation.apiKey = stringValue(env, "AZURE_PRONUNCIATION_KEY") ?? stringValue(env, "AZURE_SPEECH_KEY");
  return deepFreeze(runtimeConfigSchema.parse(restored)) as RuntimeConfig;
}

const runtimeConfigStorage = new AsyncLocalStorage<RuntimeConfig>();
let defaultRuntimeConfig: RuntimeConfig | undefined;

export function setDefaultRuntimeConfig(config: RuntimeConfig) {
  defaultRuntimeConfig = config;
}

export function getRuntimeConfig() {
  return runtimeConfigStorage.getStore() ?? defaultRuntimeConfig ?? buildRuntimeConfig();
}

export function runWithRuntimeConfig<T>(config: RuntimeConfig, task: () => T): T {
  return runtimeConfigStorage.run(config, task);
}

export function runtimeConfigProcessEnv(config: RuntimeConfig, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, SCENE_GEN_RUNTIME_CONFIG: JSON.stringify(config), SCENE_GEN_PROFILE: config.profile };
}

export function runtimeConfigWithTemplateExclusions(config: RuntimeConfig, exclusions: Record<string, string[]>): RuntimeConfig {
  const next = structuredClone(config) as RuntimeConfigSnapshot;
  next.rendering.htmlTemplateExclusions = structuredClone(exclusions);
  return deepFreeze(runtimeConfigSchema.parse(next)) as RuntimeConfig;
}

export function runtimeConfigWithRunOverrides(config: RuntimeConfig, overrides: {
  engine?: "remotion" | "html-video";
  outputDir?: string;
  screenshotLimit?: number;
  qualityProfile?: "balanced" | "strict" | "lenient";
  maxIterations?: number;
  videoIterations?: number;
}): RuntimeConfig {
  const next = structuredClone(config) as RuntimeConfigSnapshot;
  if (overrides.engine) next.rendering.engine = overrides.engine;
  if (overrides.outputDir) next.rendering.outputDir = path.resolve(overrides.outputDir);
  if (overrides.screenshotLimit !== undefined) next.rendering.screenshotLimit = overrides.screenshotLimit;
  if (overrides.qualityProfile) next.quality.profile = overrides.qualityProfile;
  if (overrides.maxIterations !== undefined) next.retry.maxIterations = overrides.maxIterations;
  if (overrides.videoIterations !== undefined) next.retry.videoIterations = overrides.videoIterations;
  return deepFreeze(runtimeConfigSchema.parse(next)) as RuntimeConfig;
}
