import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NarrationSegment, VideoProject } from "./types";
import { ensureDir, fromRoot, writeJsonAtomic } from "./utils";
import { createF5NarrationCacheMetadata } from "./tts-cache";
import { loadTtsPronunciationLexicon } from "./tts-pronunciation";
import { BoundedTaskQueue, mapWithConcurrency } from "./bounded-task-queue";
import { F5WorkerPool, resolveF5WorkerDevices } from "./f5-worker-pool";
import { getOrCreateMediaCache } from "../cache/media-cache";
import { recordProviderOutcome } from "../production/provider-stats";
import type { ProviderSelectionAudit } from "../production/types";
import { routeTtsProvider, type PronunciationStrategy } from "../production/tts-routing";
import { getRuntimeConfig } from "../config/runtime-config";
import { AzureTtsError, azureTts, type AzureTtsResult } from "./tts/providers/azure";
import { nvidiaTts } from "./tts/providers/nvidia";
import { openAiTts } from "./tts/providers/openai";
import { windowsTts } from "./tts/providers/windows";
import { cloudflareMeloTts } from "./tts/providers/cloudflare-melotts";
import { edgeTts } from "./tts/providers/edge";
import { mockTts } from "./tts/providers/mock";
import { probeDuration, run } from "./tts/process";
import { prepareF5SynthesisText } from "./tts/text-normalization";
import { audioGenerationKey, narrationSynthesisText, splitTitleNarration } from "./tts/segmentation";
import { concatNarrationSegments, fitNarrationSegmentsToTarget, silentAudio } from "./tts/postprocess";
import { compilePronunciationPlan } from "./pronunciation/compiler";
import { G2pwWorkerClient } from "./pronunciation/g2pw-client";
import { f5PronunciationInput } from "./pronunciation/provider-adapters";
import { pronunciationPlanHash, type PronunciationPlan } from "./pronunciation/schema";
export { prepareF5SynthesisText, removeLoneSurrogates } from "./tts/text-normalization";

const DEFAULT_F5_REF_TEXT = "对，这就是我，万人敬仰的太乙真人。";
const BAD_REF_TEXT = /太乙真人|万人敬仰|这就是我/;
const MOJIBAKE_MARKERS = /銆|锛|锟|杩|绔|鐨|妯|浠|浜|鍦|鏄|姣|鍙|浼|棰|勭/g;

export type TtsProvider = "nvidia" | "azure" | "cloudflare-melotts" | "edge" | "openai" | "f5" | "local" | "mock";
const F5_FRONTEND_VERSION = "scene-gen-pypinyin-lexicon-v1";
let warnedDeprecatedF5Cli = false;
let g2pwClient: G2pwWorkerClient | undefined;
let pypinyinClient: G2pwWorkerClient | undefined;
let pronunciationWorkerUsers = 0;

async function releasePronunciationWorkers() {
  pronunciationWorkerUsers = Math.max(0, pronunciationWorkerUsers - 1);
  if (pronunciationWorkerUsers > 0) return;
  await Promise.all([g2pwClient?.dispose(), pypinyinClient?.dispose()]);
  g2pwClient = undefined;
  pypinyinClient = undefined;
}

type TtsSynthesisMetrics = NonNullable<NonNullable<VideoProject["audio"]>["metrics"]>;

interface F5Runtime {
  pool: F5WorkerPool;
  refAudio: string;
  refText: string;
  pronunciationLexiconHash: string;
}

function emptySynthesisMetrics(): TtsSynthesisMetrics {
  return {
    workerStartCount: 0,
    workerStartupMs: 0,
    modelLoadMs: 0,
    queueWaitMs: 0,
    synthesisMs: 0,
    cacheHitCount: 0,
    cacheMissCount: 0,
    generatedSceneCount: 0,
    reusedSceneCount: 0,
    forcedAudioSceneIndexes: "",
    generatedAudioSceneIndexes: "",
    reusedAudioSceneIndexes: "",
    concatenatedAudio: false,
    audioGenerationKey: "",
    providerSelection: "{}",
  };
}

function resolveF5Python() {
  return getRuntimeConfig().tts.f5.python;
}

function resolveF5RefAudio() {
  return getRuntimeConfig().tts.f5.refAudio ?? "";
}

function normalizeFilePath(filePath: string) {
  return path.normalize(filePath).toLowerCase();
}

function isDefaultF5RefAudio(refAudio: string) {
  return normalizeFilePath(refAudio).endsWith(path.normalize("infer/examples/basic/basic_ref_zh.wav").toLowerCase());
}

async function resolveF5RefText(refAudio: string) {
  if (Object.hasOwn(process.env, "F5_TTS_REF_TEXT")) {
    return getRuntimeConfig().tts.f5.refText;
  }

  const textPath = refAudio.replace(/\.[^.]+$/, ".txt");
  if (existsSync(textPath)) return (await readFile(textPath, "utf8")).trim();
  return isDefaultF5RefAudio(refAudio) ? DEFAULT_F5_REF_TEXT : "";
}

function assertCleanTtsText(text: string, refAudio: string, refText: string) {
  if (BAD_REF_TEXT.test(text)) {
    throw new Error("TTS input contains the default F5 reference sentence; refusing to synthesize.");
  }
  const mojibakeHits = text.match(MOJIBAKE_MARKERS)?.length ?? 0;
  if (mojibakeHits >= 8) {
    throw new Error("TTS input looks like mojibake/corrupted Chinese; refusing to synthesize.");
  }
  if (!isDefaultF5RefAudio(refAudio) && BAD_REF_TEXT.test(refText)) {
    throw new Error("Custom F5 reference audio is paired with the default reference text; refusing to synthesize.");
  }
}

async function f5TtsCli(text: string, outputPath: string, speedOverride?: string) {
  if (!warnedDeprecatedF5Cli) {
    console.warn("[tts] F5_TTS_WORKER_MODE=cli is deprecated; use the persistent worker mode.");
    warnedDeprecatedF5Cli = true;
  }
  const python = resolveF5Python();
  const refAudio = resolveF5RefAudio();
  if (!refAudio) throw new Error("F5 reference audio is not configured. Set F5_TTS_REF_AUDIO or use a virtual environment containing the F5-TTS example audio.");
  const refText = await resolveF5RefText(refAudio);
  const config = getRuntimeConfig().tts.f5;
  const model = config.model;
  const speed = speedOverride ?? String(config.speed);
  const nfeStep = String(config.nfeStep);
  const device = config.device;
  const outputDir = path.dirname(outputPath);
  const outputFile = path.basename(outputPath);
  const textPath = path.join(outputDir, `${path.basename(outputPath, path.extname(outputPath))}.txt`);
  const pronunciationLexicon = loadTtsPronunciationLexicon();

  const synthesisText = prepareF5SynthesisText(text);
  assertCleanTtsText(synthesisText, refAudio, refText);
  await writeFile(textPath, synthesisText, "utf8");
  await writeFile(`${textPath}.ref.txt`, refText, "utf8");
  await run(python, [
    fromRoot("scripts", "f5-infer-with-lexicon.py"),
    "--lexicon",
    pronunciationLexicon.filePath,
    "--model",
    model,
    "--ref_audio",
    refAudio,
    "--ref_text",
    refText,
    "--gen_file",
    textPath,
    "--output_dir",
    outputDir,
    "--output_file",
    outputFile,
    "--speed",
    speed,
    "--nfe_step",
    nfeStep,
    "--device",
    device,
  ], {
    env: {
      HF_HUB_OFFLINE: config.hfOffline ? "1" : "0",
      TRANSFORMERS_OFFLINE: config.hfOffline ? "1" : "0",
    },
  });
}

async function createF5Runtime(limitToSingleWorker = false) {
  const config = getRuntimeConfig().tts.f5;
  const refAudio = resolveF5RefAudio();
  if (!refAudio) throw new Error("F5 reference audio is not configured. Set F5_TTS_REF_AUDIO or F5_TTS_VENV.");
  const refText = await resolveF5RefText(refAudio);
  const pronunciationLexicon = loadTtsPronunciationLexicon();
  const pool = new F5WorkerPool({
    pythonCommand: resolveF5Python(),
    workerScript: config.workerScript,
    model: config.model,
    devices: limitToSingleWorker ? resolveF5WorkerDevices().slice(0, 1) : resolveF5WorkerDevices(),
    refAudio,
    refText,
    lexiconPath: pronunciationLexicon.filePath,
    pronunciationLexiconHash: pronunciationLexicon.hash,
    defaultNfeStep: config.nfeStep,
    readyTimeoutMs: config.workerReadyTimeoutMs,
    requestTimeoutMs: config.workerRequestTimeoutMs,
    maxRestarts: config.workerMaxRestarts,
    env: {
      HF_HUB_OFFLINE: config.hfOffline ? "1" : "0",
      TRANSFORMERS_OFFLINE: config.hfOffline ? "1" : "0",
    },
  });
  return { pool, refAudio, refText, pronunciationLexiconHash: pronunciationLexicon.hash } satisfies F5Runtime;
}

function positiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function providerConcurrency(provider: TtsProvider, f5Runtime?: F5Runtime) {
  if (provider === "f5") return f5Runtime?.pool.concurrency ?? 1;
  if (provider === "nvidia") return getRuntimeConfig().tts.nvidia.concurrency;
  if (provider === "azure") return getRuntimeConfig().tts.azure.concurrency;
  if (provider === "cloudflare-melotts") return getRuntimeConfig().tts.cloudflare.concurrency;
  if (provider === "edge") return getRuntimeConfig().tts.edge.concurrency;
  if (provider === "openai") return getRuntimeConfig().tts.openai.concurrency;
  if (provider === "mock") return 4;
  return getRuntimeConfig().tts.local.concurrency;
}

async function f5TtsWorker(
  plan: PronunciationPlan,
  outputPath: string,
  sceneIndex: number,
  runtime: F5Runtime,
  speedOverride?: string,
  signal?: AbortSignal,
) {
  const synthesisText = prepareF5SynthesisText(plan.synthesisText);
  assertCleanTtsText(synthesisText, runtime.refAudio, runtime.refText);
  const textPath = path.join(path.dirname(outputPath), `${path.basename(outputPath, path.extname(outputPath))}.txt`);
  await Promise.all([
    writeFile(textPath, synthesisText, "utf8"),
    writeFile(`${textPath}.ref.txt`, runtime.refText, "utf8"),
  ]);
  return runtime.pool.synthesize({
    sceneIndex,
    text: synthesisText,
    outputPath,
    speed: Number(speedOverride ?? getRuntimeConfig().tts.f5.speed),
    nfeStep: getRuntimeConfig().tts.f5.nfeStep,
    seed: getRuntimeConfig().tts.f5.seed,
    pronunciationLexiconHash: runtime.pronunciationLexiconHash,
    pronunciationPhrasesBase64: Buffer.from(JSON.stringify(f5PronunciationInput(plan).phraseDictionary), "utf8").toString("base64"),
    signal,
  });
}

function ttsProviderId(provider: TtsProvider) {
  return provider === "local" ? "windows" : provider;
}

function providerFromId(providerId?: string): TtsProvider {
  if (providerId === "windows") return "local";
  if (providerId === "nvidia" || providerId === "azure" || providerId === "cloudflare-melotts" || providerId === "edge" || providerId === "openai" || providerId === "f5" || providerId === "mock") return providerId;
  return "local";
}

function ttsDomain(project: VideoProject) {
  const source = project.sources[0];
  if (source?.kind === "github" || source?.repo) return "software";
  return source?.domain ?? source?.tags?.[0] ?? "general";
}

async function resolveTtsProvider(project: VideoProject, plan: PronunciationPlan, explicit?: TtsProvider) {
  const runtime = getRuntimeConfig();
  const routed = await routeTtsProvider({
    profile: runtime.profile,
    plan,
    domain: ttsDomain(project),
    device: runtime.tts.f5.device,
    memoryPressure: runtime.tts.f5.gpuMemoryPressure,
    explicitProvider: ttsProviderId(explicit ?? runtime.tts.provider),
  });
  if (!routed.selectedProvider) throw new Error("No TTS provider satisfies pronunciation capability and free-quota constraints; manual confirmation is required.");
  return { provider: providerFromId(routed.selectedProvider), audit: routed.audit, routing: routed };
}

function providerErrorType(error: unknown) {
  if (error instanceof AzureTtsError) return error.result.errorType ?? "operation_failed";
  const message = error instanceof Error ? error.message : String(error);
  if (/out of memory|cuda oom|cuda.*memory/i.test(message)) return "cuda_oom";
  if (/timed?\s*out|timeout/i.test(message)) return "timeout";
  if (/429/.test(message)) return "rate_limit";
  if (/5\d\d/.test(message)) return "server_error";
  return "operation_failed";
}

function providerCost(provider: TtsProvider, characters: number) {
  if (provider !== "openai") return 0;
  return characters / 1000 * getRuntimeConfig().tts.openai.costPer1kChars;
}

async function recordTtsProviderResult(input: { provider: TtsProvider; project: VideoProject; startedAt: number; success: boolean; error?: unknown; retryCount?: number; billedCharacters?: number }) {
  await recordProviderOutcome({
    providerId: ttsProviderId(input.provider), capability: "tts", operation: "narration-synthesis", success: input.success,
    latencyMs: Date.now() - input.startedAt, timeout: providerErrorType(input.error) === "timeout", retryCount: input.retryCount ?? 0,
    cost: input.success ? providerCost(input.provider, input.billedCharacters ?? [...input.project.narration].length) : 0,
    unitKind: "chars", unitCount: input.billedCharacters ?? [...input.project.narration].length,
    language: "zh-CN", domain: ttsDomain(input.project), device: input.provider === "f5" ? getRuntimeConfig().tts.f5.device : undefined,
    errorType: input.success ? undefined : providerErrorType(input.error),
  }).catch(() => undefined);
}

function providerExtension(provider: TtsProvider) {
  return provider === "openai" || provider === "cloudflare-melotts" || provider === "edge" ? "mp3" : "wav";
}

async function synthesizeNarration(
  provider: TtsProvider,
  plan: PronunciationPlan,
  outputPath: string,
  options?: { f5Speed?: string; sceneIndex?: number; f5Runtime?: F5Runtime; signal?: AbortSignal; forceRebuild?: boolean; cacheSalt?: string },
): Promise<{ reused: boolean; result?: AzureTtsResult; cacheKey?: string }> {
  if (provider === "nvidia") return nvidiaTts({ plan, outputPath, force: options?.forceRebuild, cacheSalt: options?.cacheSalt, signal: options?.signal });
  if (provider === "azure") {
    return azureTts({
      sceneIndex: options?.sceneIndex ?? 0,
      displayText: plan.displayText,
      synthesisText: plan.synthesisText,
      pronunciationPlan: plan,
      outputPath,
      pronunciationPlanHash: plan.planHash,
      force: options?.forceRebuild,
      cacheSalt: options?.cacheSalt,
      signal: options?.signal,
    });
  }
  if (provider === "openai") {
    await openAiTts(plan.synthesisText, outputPath);
  } else if (provider === "cloudflare-melotts") {
    await cloudflareMeloTts(plan.synthesisText, outputPath, options?.signal);
  } else if (provider === "edge") {
    if (plan.spans.some((span) => span.risk === "high" && !span.spokenFallback)) throw new Error("Edge TTS cannot synthesize high-risk pronunciation without a spoken fallback.");
    await edgeTts(plan.spans.some((span) => span.risk === "high") ? plan.spans.reduce((text, span) => span.spokenFallback ? text.replace(span.phrase, span.spokenFallback) : text, plan.synthesisText) : plan.synthesisText, outputPath);
  } else if (provider === "f5") {
    if (getRuntimeConfig().tts.f5.workerMode === "cli") {
      await f5TtsCli(plan.synthesisText, outputPath, options?.f5Speed);
    } else {
      if (!options?.f5Runtime) throw new Error("Persistent F5 worker runtime is unavailable.");
      await f5TtsWorker(plan, outputPath, options.sceneIndex ?? 0, options.f5Runtime, options.f5Speed, options.signal);
    }
  } else if (provider === "local") {
    await windowsTts(plan.synthesisText, outputPath);
  } else {
    await mockTts(plan.synthesisText, outputPath);
  }
  return { reused: false as const };
}

function hashText(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

async function hashFile(filePath: string) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function currentF5CacheMetadata(plan: PronunciationPlan, expectedSpeed?: string, cacheSalt?: string) {
  const refAudio = resolveF5RefAudio();
  if (!refAudio) throw new Error("F5 reference audio is not configured.");
  const refText = await resolveF5RefText(refAudio);
  return createF5NarrationCacheMetadata({
    provider: "f5",
    model: getRuntimeConfig().tts.f5.model,
    normalizedTtsText: prepareF5SynthesisText(plan.synthesisText).trim(),
    pronunciationLexiconHash: loadTtsPronunciationLexicon().hash,
    pronunciationPlanHash: plan.planHash,
    refAudioHash: await hashFile(refAudio),
    refTextHash: hashText(refText.trim()),
    speed: expectedSpeed ?? String(getRuntimeConfig().tts.f5.speed),
    nfeStep: String(getRuntimeConfig().tts.f5.nfeStep),
    frontendVersion: F5_FRONTEND_VERSION,
    cacheSalt,
  });
}

async function synthesizeF5WithGlobalCache(input: {
  plan: PronunciationPlan;
  outputPath: string;
  expectedSpeed?: string;
  cacheSalt?: string;
  forceRebuild?: boolean;
  sceneIndex: number;
  f5Runtime?: F5Runtime;
  signal?: AbortSignal;
}) {
  const metadata = await currentF5CacheMetadata(input.plan, input.expectedSpeed, input.cacheSalt);
  const result = await getOrCreateMediaCache({
    kind: "audio",
    cacheKey: metadata.cacheKey,
    extension: path.extname(input.outputPath) || ".wav",
    targetPath: input.outputPath,
    identity: metadata,
    force: input.forceRebuild || getRuntimeConfig().tts.forceRebuild,
    signal: input.signal,
    generate: async (cacheOutputPath) => {
      await synthesizeNarration("f5", input.plan, cacheOutputPath, {
        f5Speed: input.expectedSpeed,
        sceneIndex: input.sceneIndex,
        f5Runtime: input.f5Runtime,
        signal: input.signal,
      });
    },
  });
  await writeJsonAtomic(narrationCacheMetadataPath(input.outputPath), metadata);
  return { reused: !result.generated, cacheKey: metadata.cacheKey };
}

async function pronunciationPlanFor(text: string, segment?: NarrationSegment, signal?: AbortSignal) {
  const config = getRuntimeConfig().tts.pronunciation;
  if (config.g2pwEnabled && !g2pwClient) g2pwClient = new G2pwWorkerClient({ python: config.g2pwPython, script: config.g2pwScript, modelDir: config.g2pwModelDir, readyTimeoutMs: config.g2pwReadyTimeoutMs, requestTimeoutMs: config.g2pwRequestTimeoutMs });
  if (!pypinyinClient) pypinyinClient = new G2pwWorkerClient({ python: config.g2pwPython, script: config.g2pwScript, readyTimeoutMs: config.g2pwReadyTimeoutMs, requestTimeoutMs: config.g2pwRequestTimeoutMs, pypinyinOnly: true });
  return compilePronunciationPlan({
    displayText: segment?.text ?? text,
    semanticText: segment?.text ?? text,
    synthesisText: prepareF5SynthesisText(segment?.ttsText ?? text),
    overrides: segment?.pronunciationOverrides,
    domain: config.domain,
    g2pw: config.g2pwEnabled ? g2pwClient : undefined,
    g2pwMinimumConfidence: config.g2pwMinimumConfidence,
    pypinyinFallback: async (value) => (await pypinyinClient!.pypinyin(value, { signal })).map((prediction) => ({ phrase: prediction.phrase, start: prediction.start, end: prediction.end, expectedPinyin: prediction.pinyin, source: "pypinyin", confidence: prediction.confidence, risk: "low", providerOverrides: {} })),
    signal,
  });
}

function narrationCacheMetadataPath(segmentPath: string) {
  return `${segmentPath}.cache.json`;
}

async function synthesizeF5TitleScene(
  project: VideoProject,
  narration: string,
  segmentPath: string,
  sceneIndex: number,
  f5Runtime: F5Runtime | undefined,
  forceRebuild: boolean,
  cacheSalt: string | undefined,
  signal?: AbortSignal,
) {
  const { titleText, bodyText } = splitTitleNarration(project.meta.title, narration);
  const extension = path.extname(segmentPath);
  const stem = segmentPath.slice(0, -extension.length);
  const partTexts = [titleText, bodyText].filter(Boolean);
  const partPaths = partTexts.map((_, index) => `${stem}-${index === 0 ? "title" : "body"}${extension}`);
  const partResults = await mapWithConcurrency(partTexts, Math.max(1, f5Runtime?.pool.concurrency ?? 1), async (partText, index) => {
    const partPath = partPaths[index];
    const uniformSpeed = String(getRuntimeConfig().tts.f5.uniformSpeed);
    const synthesisText = index === 0 ? `。 。 。 ${partText}` : partText;
    const { plan } = await pronunciationPlanFor(synthesisText, undefined, signal);
    const { reused } = await synthesizeF5WithGlobalCache({
      plan,
      outputPath: partPath,
      expectedSpeed: uniformSpeed,
      cacheSalt,
      forceRebuild,
      sceneIndex,
      f5Runtime,
      signal,
    });
    const duration = await probeDuration(partPath);
    if (duration <= 0) throw new Error(`Title narration part ${index + 1} is invalid.`);
    return { duration, reused };
  });
  const partDurations = partResults.map((result) => result.duration);
  const gaps = partTexts.map((_, index) => (index === 0 && partTexts.length > 1 ? 0.32 : 0));
  await concatNarrationSegments(partPaths, partDurations, gaps, segmentPath);
  return {
    cacheHitCount: partResults.filter((result) => result.reused).length,
    cacheMissCount: partResults.filter((result) => !result.reused).length,
    generated: partResults.some((result) => !result.reused),
  };
}
async function attachSegmentedNarration(
  project: VideoProject,
  basename: string,
  provider: TtsProvider,
  generatedDir: string,
  f5Runtime?: F5Runtime,
  signal?: AbortSignal,
  forceSceneIndexes: number[] = [],
  cacheSalt?: string,
  previousProvider?: TtsProvider,
  pronunciationStrategy?: PronunciationStrategy,
) {
  const segments = [...(project.narrationSegments ?? [])].sort((a, b) => a.sceneIndex - b.sceneIndex);
  const uniformF5Speed = String(getRuntimeConfig().tts.f5.uniformSpeed);
  if (segments.length !== project.scenes.length) {
    throw new Error(`Narration segment count ${segments.length} does not match scene count ${project.scenes.length}.`);
  }

  const extension = providerExtension(provider);
  const taskConcurrency = getRuntimeConfig().tts.preprocessConcurrency;
  const synthesisQueue = new BoundedTaskQueue(providerConcurrency(provider, f5Runtime));
  const forcedScenes = new Set(forceSceneIndexes);
  const existingSceneCacheSalts = project.audio?.sceneCacheSalts ?? {};
  const results = await mapWithConcurrency(segments, taskConcurrency, async (segment, index) => {
    if (segment.sceneIndex !== index || !segment.text.trim()) {
      throw new Error(`Invalid narration segment at scene ${index}.`);
    }
    const segmentPath = path.join(
      generatedDir,
      `${basename}-scene-${String(index + 1).padStart(2, "0")}.${extension}`,
    );
    const synthesisText = narrationSynthesisText(segment);
    const pronunciation = await pronunciationPlanFor(synthesisText, segment, signal);
    let plan = pronunciation.plan;
    const forceRebuild = forcedScenes.has(index);
    const effectiveCacheSalt = forceRebuild ? cacheSalt : existingSceneCacheSalts[String(index)];
    if (forceRebuild && pronunciationStrategy === "use-spoken-fallback") {
      const synthesisTextWithFallback = plan.spans.reduce((text, span) => span.spokenFallback ? text.replace(span.phrase, span.spokenFallback) : text, plan.synthesisText);
      const base = { ...plan, synthesisText: synthesisTextWithFallback };
      plan = { ...base, planHash: pronunciationPlanHash({ displayText: base.displayText, semanticText: base.semanticText, synthesisText: base.synthesisText, spans: base.spans, frontendVersion: base.frontendVersion }) };
    }
    if (!forceRebuild && previousProvider && previousProvider !== provider) {
      const previousPath = path.join(generatedDir, `${basename}-scene-${String(index + 1).padStart(2, "0")}.${providerExtension(previousProvider)}`);
      if (existsSync(previousPath)) {
        if (path.resolve(previousPath) !== path.resolve(segmentPath)) await copyFile(previousPath, segmentPath);
        const duration = await probeDuration(segmentPath);
        if (duration > 0) return { segmentPath, duration, cacheHitCount: 1, cacheMissCount: 0, generated: false, sceneIndex: index, cacheSalt: effectiveCacheSalt, pronunciationPlan: plan, pronunciationIssues: pronunciation.issues, pronunciationIssueCount: pronunciation.issues.length };
      }
    }
    if (provider === "f5" && index === 0) {
      const titleResult = await synthesizeF5TitleScene(project, synthesisText, segmentPath, index, f5Runtime, forceRebuild, effectiveCacheSalt, signal);
      const duration = await probeDuration(segmentPath);
      if (duration <= 0) throw new Error(`Narration segment ${index + 1} is empty or invalid.`);
      return { segmentPath, duration, sceneIndex: index, cacheSalt: effectiveCacheSalt, pronunciationPlan: plan, pronunciationIssues: pronunciation.issues, pronunciationIssueCount: pronunciation.issues.length, ...titleResult };
    }
    let reused = false;
    let azureResult: AzureTtsResult | undefined;
    if (provider === "f5") {
      ({ reused } = await synthesizeF5WithGlobalCache({
        plan,
        outputPath: segmentPath,
        expectedSpeed: uniformF5Speed,
        cacheSalt: effectiveCacheSalt,
        forceRebuild,
        sceneIndex: index,
        f5Runtime,
        signal,
      }));
    }
    if (!reused && provider !== "f5") {
      const synthesis = await synthesisQueue.run(() => synthesizeNarration(provider, plan, segmentPath, {
        f5Speed: undefined,
        sceneIndex: index,
        f5Runtime,
        signal,
        forceRebuild,
        cacheSalt: effectiveCacheSalt,
      }));
      if (provider === "azure") {
        reused = synthesis.reused;
        azureResult = synthesis.result;
        if (!azureResult) throw new Error("Azure Speech synthesis result is missing.");
      }
    }
    const duration = await probeDuration(segmentPath);
    if (duration <= 0) throw new Error(`Narration segment ${index + 1} is empty or invalid.`);
    return {
      segmentPath,
      duration,
      cacheHitCount: reused ? 1 : 0,
      cacheMissCount: reused ? 0 : 1,
      generated: !reused,
      sceneIndex: index,
      cacheSalt: effectiveCacheSalt,
      azureResult,
      pronunciationPlan: plan,
      pronunciationIssues: pronunciation.issues,
      pronunciationIssueCount: pronunciation.issues.length,
    };
  });
  const segmentPaths = results.map((result) => result.segmentPath);
  const durations = results.map((result) => result.duration);

  const gaps = durations.map((_, index) => (index === durations.length - 1 ? 0.8 : 0.28));
  const leadingSilenceSeconds = getRuntimeConfig().tts.leadingSilenceSeconds;
  const totalGapSeconds = gaps.reduce((sum, gap) => sum + gap, leadingSilenceSeconds);
  const fitted = await fitNarrationSegmentsToTarget(segmentPaths, durations, project.meta.durationSeconds, totalGapSeconds);
  const playbackPaths = fitted.paths;
  const playbackDurations = fitted.durations;
  const outputPath = path.join(generatedDir, `${basename}.wav`);
  await concatNarrationSegments(playbackPaths, playbackDurations, gaps, outputPath, leadingSilenceSeconds);

  let audioStartSeconds = 0;
  const alignedSegments = segments.map((segment, index) => {
    const durationSeconds = playbackDurations[index] + gaps[index] + (index === 0 ? leadingSilenceSeconds : 0);
    const aligned = {
      ...segment,
      pronunciationPlan: results[index].pronunciationPlan,
      audioStartSeconds,
      durationSeconds,
    };
    audioStartSeconds += durationSeconds;
    return aligned;
  });
  const combinedDuration = await probeDuration(outputPath);
  if (combinedDuration <= 0) throw new Error("Combined narration audio is empty or invalid.");
  const durationDelta = combinedDuration - audioStartSeconds;
  if (alignedSegments.length > 0 && Math.abs(durationDelta) > 0.001) {
    const last = alignedSegments[alignedSegments.length - 1];
    last.durationSeconds = Math.max(0.1, (last.durationSeconds ?? 0) + durationDelta);
  }
  const scenes = project.scenes.map((scene, index) => ({
    ...scene,
    duration: alignedSegments[index].durationSeconds ?? scene.duration,
  }));
  const workerMetrics = f5Runtime?.pool.metrics() ?? emptySynthesisMetrics();
  const generatedAudioSceneIndexes = results.filter((result) => result.generated).map((result) => result.sceneIndex);
  const reusedAudioSceneIndexes = results.filter((result) => !result.generated).map((result) => result.sceneIndex);
  const sceneCacheSalts = { ...existingSceneCacheSalts };
  for (const result of results) {
    if (result.cacheSalt) sceneCacheSalts[String(result.sceneIndex)] = result.cacheSalt;
  }
  const metrics: TtsSynthesisMetrics = {
    ...emptySynthesisMetrics(),
    ...workerMetrics,
    cacheHitCount: results.reduce((sum, result) => sum + result.cacheHitCount, 0),
    cacheMissCount: results.reduce((sum, result) => sum + result.cacheMissCount, 0),
    generatedSceneCount: results.filter((result) => result.generated).length,
    reusedSceneCount: results.filter((result) => !result.generated).length,
    forcedAudioSceneIndexes: [...forcedScenes].sort((left, right) => left - right).join(","),
    generatedAudioSceneIndexes: generatedAudioSceneIndexes.join(","),
    reusedAudioSceneIndexes: reusedAudioSceneIndexes.join(","),
    concatenatedAudio: true,
    leadingSilenceSeconds,
    audioGenerationKey: audioGenerationKey(sceneCacheSalts),
    requestMs: results.reduce((sum, result) => sum + (result.azureResult?.requestMs ?? 0), 0),
    retryCount: results.reduce((sum, result) => sum + (result.azureResult?.retryCount ?? 0), 0),
    billedCharacters: results.reduce((sum, result) => sum + (result.azureResult?.billedCharacters ?? 0), 0),
    providerRequestIds: results.map((result) => result.azureResult?.providerRequestId).filter(Boolean).join(","),
    budgetUsedCharacters: Math.max(0, ...results.map((result) => result.azureResult?.budgetUsedCharacters ?? 0)),
    budgetRemainingCharacters: Math.min(...results.map((result) => result.azureResult?.budgetRemainingCharacters ?? Number.MAX_SAFE_INTEGER)),
    budgetWarning: results.some((result) => result.azureResult?.budgetWarning),
    pronunciationPlanCount: results.length,
    pronunciationUncertainCount: results.reduce((sum, result) => sum + result.pronunciationIssueCount, 0),
  };
  if (metrics.budgetRemainingCharacters === Number.MAX_SAFE_INTEGER) delete metrics.budgetRemainingCharacters;

  const pronunciationPlansPath = path.join(generatedDir, `${basename}-pronunciation-plans.json`);
  await writeJsonAtomic(pronunciationPlansPath, results.map((result) => ({ sceneIndex: result.sceneIndex, plan: result.pronunciationPlan, issues: result.pronunciationIssues })));
  return {
    ...project,
    meta: {
      ...project.meta,
      durationSeconds: combinedDuration,
    },
    narration: alignedSegments.map((segment) => segment.text).join("\n"),
    narrationSegments: alignedSegments,
    scenes,
    audio: {
      src: `/generated/${basename}.wav`,
      durationSeconds: combinedDuration,
      provider,
      metrics,
      sceneCacheSalts,
      pronunciationPlansPath,
    },
  } satisfies VideoProject;
}

export interface AttachNarrationAudioOptions {
  generatedDir?: string;
  provider?: TtsProvider;
  signal?: AbortSignal;
  forceSceneIndexes?: number[];
  forceAudioRebuild?: boolean;
  cacheSalt?: string;
  reason?: string;
  pronunciationStrategy?: PronunciationStrategy;
}

export async function attachNarrationAudio(project: VideoProject, basename = "narration", options: AttachNarrationAudioOptions = {}) {
  pronunciationWorkerUsers += 1;
  const startedAt = Date.now();
  const generatedDir = options.generatedDir ?? fromRoot("public", "generated");
  await ensureDir(generatedDir);
  const projectPronunciation = await pronunciationPlanFor(project.narration, undefined, options.signal);
  const selection = await resolveTtsProvider(project, projectPronunciation.plan, options.provider);
  const provider = selection.provider;
  const allSceneIndexes = project.scenes.map((_, index) => index);
  const forceSceneIndexes = options.forceAudioRebuild
    ? options.forceSceneIndexes?.length ? options.forceSceneIndexes : allSceneIndexes
    : options.forceSceneIndexes ?? [];
  const cacheSalt = forceSceneIndexes.length ? options.cacheSalt ?? options.reason ?? "forced-audio-rebuild" : undefined;
  const usePersistentF5 = provider === "f5" && getRuntimeConfig().tts.f5.workerMode !== "cli";
  let f5Runtime: F5Runtime | undefined;

  try {
    if (usePersistentF5) {
      const f5Candidate = selection.audit.candidates.find((candidate) => candidate.providerId === "f5");
      const limitToSingleWorker = selection.audit.context.memoryPressure === true || f5Candidate?.stats.health === "degraded" || (f5Candidate?.stats.recentCudaOomCount ?? 0) > 0;
      f5Runtime = await createF5Runtime(limitToSingleWorker);
    }
    if (project.narrationSegments?.length) {
      const attached = await attachSegmentedNarration(project, basename, provider, generatedDir, f5Runtime, options.signal, forceSceneIndexes, cacheSalt, project.audio?.provider === "silent" ? undefined : project.audio?.provider, options.pronunciationStrategy);
      const result = {
        ...attached,
        audio: attached.audio ? { ...attached.audio, metrics: { ...attached.audio.metrics!, providerSelection: JSON.stringify(selection.audit), selectedProvider: provider, providerCandidates: JSON.stringify(selection.routing.candidates), pronunciationStrategy: options.pronunciationStrategy ?? selection.routing.pronunciationStrategy, quotaConsumed: selection.routing.quota?.consumed ?? 0, quotaRemaining: selection.routing.quota?.remaining ?? -1, providerSwitchCount: project.audio?.provider && project.audio.provider !== provider ? 1 : 0, avoidedTtsRegenerationCount: project.audio?.provider && project.audio.provider !== provider ? Math.max(0, project.scenes.length - forceSceneIndexes.length) : 0 } } : attached.audio,
      } satisfies VideoProject;
      if ((result.audio?.metrics?.generatedSceneCount ?? 0) > 0) {
        await recordTtsProviderResult({ provider, project, startedAt, success: true, retryCount: result.audio?.metrics?.retryCount ?? Math.max(0, (result.audio?.metrics?.workerStartCount ?? 1) - 1), billedCharacters: result.audio?.metrics?.billedCharacters });
      }
      return result;
    }

    const extension = providerExtension(provider);
    const outputPath = path.join(generatedDir, `${basename}.${extension}`);
    const forceRebuild = forceSceneIndexes.includes(0);
    const effectiveCacheSalt = forceRebuild ? cacheSalt : project.audio?.sceneCacheSalts?.["0"];
    let reused = false;
    let azureResult: AzureTtsResult | undefined;
    const pronunciation = projectPronunciation;
    if (provider === "f5") {
      ({ reused } = await synthesizeF5WithGlobalCache({
        plan: pronunciation.plan,
        outputPath,
        cacheSalt: effectiveCacheSalt,
        forceRebuild,
        sceneIndex: 0,
        f5Runtime,
        signal: options.signal,
      }));
    }
    if (!reused && provider !== "f5") {
      const synthesis = await synthesizeNarration(provider, pronunciation.plan, outputPath, { sceneIndex: 0, f5Runtime, signal: options.signal, forceRebuild, cacheSalt: effectiveCacheSalt });
      if (provider === "azure") {
        reused = synthesis.reused;
        azureResult = synthesis.result;
        if (!azureResult) throw new Error("Azure Speech synthesis result is missing.");
      }
    }
    const fileSize = await stat(outputPath).then((file) => file.size).catch(() => 0);
    const duration = await probeDuration(outputPath);
    if (fileSize === 0 || duration <= 0) throw new Error("TTS output is empty or invalid");
    const metrics: TtsSynthesisMetrics = {
      ...emptySynthesisMetrics(),
      ...(f5Runtime?.pool.metrics() ?? {}),
      cacheHitCount: reused ? 1 : 0,
      cacheMissCount: reused ? 0 : 1,
      generatedSceneCount: reused ? 0 : 1,
      reusedSceneCount: reused ? 1 : 0,
      forcedAudioSceneIndexes: forceRebuild ? "0" : "",
      generatedAudioSceneIndexes: reused ? "" : "0",
      reusedAudioSceneIndexes: reused ? "0" : "",
      concatenatedAudio: false,
      audioGenerationKey: audioGenerationKey(effectiveCacheSalt ? { ...(project.audio?.sceneCacheSalts ?? {}), "0": effectiveCacheSalt } : project.audio?.sceneCacheSalts ?? {}),
      providerSelection: JSON.stringify(selection.audit),
      selectedProvider: provider,
      providerCandidates: JSON.stringify(selection.routing.candidates),
      pronunciationStrategy: selection.routing.pronunciationStrategy,
      quotaConsumed: selection.routing.quota?.consumed ?? 0,
      quotaRemaining: selection.routing.quota?.remaining ?? -1,
      requestMs: azureResult?.requestMs,
      retryCount: azureResult?.retryCount,
      billedCharacters: azureResult?.billedCharacters,
      providerRequestIds: azureResult?.providerRequestId,
      budgetUsedCharacters: azureResult?.budgetUsedCharacters,
      budgetRemainingCharacters: azureResult?.budgetRemainingCharacters,
      budgetWarning: azureResult?.budgetWarning,
      pronunciationPlanCount: 1,
      pronunciationUncertainCount: pronunciation.issues.length,
    };
    const pronunciationPlansPath = path.join(generatedDir, `${basename}-pronunciation-plans.json`);
    await writeJsonAtomic(pronunciationPlansPath, [{ sceneIndex: 0, plan: pronunciation.plan, issues: pronunciation.issues }]);
    const result = {
      ...project,
      audio: {
        src: `/generated/${basename}.${extension}`,
        durationSeconds: duration,
        provider,
        metrics,
        sceneCacheSalts: effectiveCacheSalt ? { ...(project.audio?.sceneCacheSalts ?? {}), "0": effectiveCacheSalt } : project.audio?.sceneCacheSalts,
        pronunciationPlansPath,
      },
    } satisfies VideoProject;
    if (!reused) await recordTtsProviderResult({ provider, project, startedAt, success: true, retryCount: metrics.retryCount ?? Math.max(0, (metrics.workerStartCount ?? 1) - 1), billedCharacters: metrics.billedCharacters });
    return result;
  } catch (error) {
    await recordTtsProviderResult({ provider, project, startedAt, success: false, error, retryCount: error instanceof AzureTtsError ? error.result.retryCount : Math.max(0, (f5Runtime?.pool.metrics().workerStartCount ?? 1) - 1), billedCharacters: error instanceof AzureTtsError ? error.result.billedCharacters : undefined });
    console.warn(`[tts] primary provider failed: ${(error as Error).message}`);
    if (getRuntimeConfig().tts.failFast) throw error;

    if (provider !== "local") {
      const fallbackLocalPath = path.join(generatedDir, `${basename}.wav`);
      try {
        await windowsTts(project.narration, fallbackLocalPath);
        const fileSize = await stat(fallbackLocalPath).then((file) => file.size).catch(() => 0);
        const duration = await probeDuration(fallbackLocalPath);
        if (fileSize > 0 && duration > 0) {
          const fallbackAudit: ProviderSelectionAudit = {
            ...selection.audit,
            selectedProviderId: "local-tts",
            candidates: selection.audit.candidates.map((candidate) => candidate.providerId === ttsProviderId(provider)
              ? { ...candidate, reasons: [`runtime failure: ${(error as Error).message}`, ...candidate.reasons] }
              : candidate),
          };
          await recordTtsProviderResult({ provider: "local", project, startedAt: Date.now(), success: true });
          return {
            ...project,
            audio: {
              src: `/generated/${basename}.wav`,
              durationSeconds: duration,
              provider: "local",
              metrics: { ...emptySynthesisMetrics(), generatedSceneCount: 1, cacheMissCount: 1, generatedAudioSceneIndexes: "0", providerSelection: JSON.stringify(fallbackAudit) },
            },
          } satisfies VideoProject;
        }
      } catch (fallbackError) {
        console.warn(`[tts] local fallback failed: ${(fallbackError as Error).message}`);
      }
    }

    console.warn("[tts] generating silent track");
    const fallbackPath = path.join(generatedDir, `${basename}.mp3`);
    await silentAudio(fallbackPath, project.meta.durationSeconds);
    const duration = await probeDuration(fallbackPath);
    return {
      ...project,
      audio: {
        src: `/generated/${basename}.mp3`,
        durationSeconds: duration || project.meta.durationSeconds,
        provider: "silent",
      },
    } satisfies VideoProject;
  } finally {
    await f5Runtime?.pool.dispose();
    await releasePronunciationWorkers();
  }
}
