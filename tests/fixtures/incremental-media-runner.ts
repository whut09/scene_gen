import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Browser } from "playwright";
import { renderHtmlVideoProject, type HtmlVideoRenderOptions, type SceneRecordInput } from "../../src/html-video/render-html-video";
import type { HtmlRenderBudget } from "../../src/html-video/render-budget";
import { dirtyPlanFromIssues } from "../../src/harness/dirty-plan";
import { attachNarrationAudio } from "../../src/pipeline/tts";
import { fromRoot } from "../../src/pipeline/utils";
import { resolvePythonCommand } from "../../src/runtime/runtime-paths";
import { createIncrementalMediaProject } from "./incremental-media-project";

interface MockWorkerMetrics {
  workerStarts: number;
  modelLoads: number;
  activeRequests: number;
  maxConcurrency: number;
  videoMaxConcurrency: number;
  sceneRequests: Record<string, number>;
}

export interface IncrementalScenarioReport {
  elapsedMs: number;
  ttsCalls: number;
  workerStarts: number;
  modelLoads: number;
  maxConcurrency: number;
  recordedVideoScenes: number[];
  generatedAudioScenes: number[];
  reusedAudioScenes: number[];
  forceSceneIndexes: number[];
  concatAudio: boolean;
  concatVideo: boolean;
  mux: boolean;
  outputComplete: boolean;
}

export interface IncrementalMediaBenchmarkReport {
  coldRunMs: number;
  warmRunMs: number;
  modelLoadMs: number;
  audioGenerationMs: number;
  videoGenerationMs: number;
  concatMs: number;
  muxMs: number;
  cacheHitRatio: number;
  regeneratedAudioScenes: number[];
  regeneratedVideoScenes: number[];
  scenarios: Record<"cold" | "warm" | "audioRepair" | "videoRepair" | "remuxOnly" | "lexiconChange", IncrementalScenarioReport>;
}

const renderBudget: HtmlRenderBudget = {
  renderConcurrency: 2,
  ffmpegThreadsPerJob: 1,
  encodingPreset: "ultrafast",
  cpuCount: 4,
  availableMemoryBytes: 8 * 1024 ** 3,
};

function indexes(value: string | undefined) {
  return value ? value.split(",").filter(Boolean).map(Number) : [];
}

async function workerMetrics(filePath: string): Promise<MockWorkerMetrics> {
  return readFile(filePath, "utf8")
    .then((value) => JSON.parse(value) as MockWorkerMetrics)
    .catch(() => ({ workerStarts: 0, modelLoads: 0, activeRequests: 0, maxConcurrency: 0, sceneRequests: {} }));
}

function requestCount(metrics: MockWorkerMetrics) {
  return Object.values(metrics.sceneRequests).reduce((sum, value) => sum + value, 0);
}

function metricDelta(before: MockWorkerMetrics, after: MockWorkerMetrics) {
  const ttsCalls = requestCount(after) - requestCount(before);
  return {
    ttsCalls,
    workerStarts: after.workerStarts - before.workerStarts,
    modelLoads: after.modelLoads - before.modelLoads,
    maxConcurrency: ttsCalls > 0 ? after.maxConcurrency : 0,
  };
}

function createRenderRuntime() {
  const state = { recordedScenes: [] as number[], active: 0, peak: 0, concatCount: 0, muxCount: 0 };
  const browser = {
    async newContext() {
      state.active += 1;
      state.peak = Math.max(state.peak, state.active);
      let closed = false;
      return {
        async close() {
          if (closed) return;
          closed = true;
          state.active -= 1;
        },
      };
    },
    async close() {},
  } as unknown as Pick<Browser, "newContext" | "close">;
  const browserLauncher = async () => browser;
  const sceneRecorder = async (input: SceneRecordInput) => {
    const context = await input.browser.newContext();
    const startedAt = Date.now();
    state.recordedScenes.push(input.sceneIndex);
    try {
      await new Promise((resolve) => setTimeout(resolve, 8));
      await writeFile(input.outputPath, `video-scene-${input.sceneIndex}`, "utf8");
      return { detectedMotionSec: 0.2, recordMs: Date.now() - startedAt, encodeMs: 1 };
    } finally {
      await context.close();
    }
  };
  const concatRenderer = async (frames: Array<{ sceneIndex: number }>, outputPath: string) => {
    state.concatCount += 1;
    await writeFile(outputPath, `concat:${frames.map((frame) => frame.sceneIndex).join(",")}`, "utf8");
  };
  const audioMuxer = async (_project: unknown, _videoPath: string, outputPath: string) => {
    state.muxCount += 1;
    await writeFile(outputPath, "muxed-video", "utf8");
  };
  return { state, browserLauncher, sceneRecorder, concatRenderer, audioMuxer };
}

async function outputComplete(filePath: string) {
  return readFile(filePath).then((value) => value.length > 0).catch(() => false);
}

export async function runIncrementalMediaBenchmark(rootDir: string): Promise<IncrementalMediaBenchmarkReport> {
  await mkdir(rootDir, { recursive: true });
  const cacheDir = path.join(rootDir, "cache");
  const refAudio = path.join(rootDir, "reference.wav");
  const requestFile = path.join(rootDir, "requests.txt");
  const startFile = path.join(rootDir, "starts.txt");
  const metricsFile = path.join(rootDir, "worker-metrics.json");
  const lexiconV1 = path.join(rootDir, "lexicon-v1.json");
  const lexiconV2 = path.join(rootDir, "lexicon-v2.json");
  const lexicon = JSON.parse(await readFile(fromRoot("config", "tts", "zh-CN.json"), "utf8")) as {
    version: number;
    entries: Array<{ phrase: string; spokenFallback: string }>;
  };
  const targetPhrase = "重构";
  await Promise.all([
    writeFile(refAudio, "fixture", "utf8"),
    writeFile(lexiconV1, JSON.stringify(lexicon), "utf8"),
    writeFile(lexiconV2, JSON.stringify({
      ...lexicon,
      version: lexicon.version + 1,
      entries: lexicon.entries.map((entry) => entry.phrase === targetPhrase
        ? { ...entry, spokenFallback: `${entry.spokenFallback}升级` }
        : entry),
    }), "utf8"),
  ]);
  const envNames = [
    "F5_TTS_PYTHON", "F5_TTS_WORKER_SCRIPT", "F5_TTS_REF_AUDIO", "F5_TTS_REF_TEXT",
    "F5_TTS_WORKER_MODE", "F5_TTS_DEVICE", "F5_TTS_CONCURRENCY", "MOCK_F5_REQUEST_COUNT_FILE",
    "MOCK_F5_START_COUNT_FILE", "MOCK_F5_METRICS_FILE", "TTS_DURATION_POLICY", "SCENE_GEN_CACHE_DIR",
    "TTS_PRONUNCIATION_LEXICON",
  ] as const;
  const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    F5_TTS_PYTHON: resolvePythonCommand(),
    F5_TTS_WORKER_SCRIPT: fromRoot("tests", "fixtures", "mock-f5-worker.py"),
    F5_TTS_REF_AUDIO: refAudio,
    F5_TTS_REF_TEXT: "reference",
    F5_TTS_WORKER_MODE: "worker",
    F5_TTS_DEVICE: "cuda:0",
    F5_TTS_CONCURRENCY: "1",
    MOCK_F5_REQUEST_COUNT_FILE: requestFile,
    MOCK_F5_START_COUNT_FILE: startFile,
    MOCK_F5_METRICS_FILE: metricsFile,
    TTS_DURATION_POLICY: "natural",
    SCENE_GEN_CACHE_DIR: cacheDir,
    TTS_PRONUNCIATION_LEXICON: lexiconV1,
  });
  const fingerprint = {
    assetContentHash: "a".repeat(64), fontBundleHash: "b".repeat(64), globalCssHash: "c".repeat(64),
    browserVersion: "mock-browser-v1", encoderProfile: "fixture-ultrafast", rendererVersion: "fixture-renderer-v1",
  };
  const project = createIncrementalMediaProject();
  const scenario = async (input: {
    name: string;
    sourceProject: typeof project;
    synthesize?: { forceSceneIndexes?: number[]; cacheSalt?: string };
    render: { workDir: string; forceSceneIndexes?: number[]; remuxOnly?: boolean };
  }) => {
    const before = await workerMetrics(metricsFile);
    const runtime = createRenderRuntime();
    const startedAt = Date.now();
    const audioStartedAt = Date.now();
    const withAudio = input.synthesize === undefined
      ? input.sourceProject
      : await attachNarrationAudio(input.sourceProject, `${input.name}-narration`, {
        generatedDir: path.join(rootDir, input.name, "audio"), provider: "f5",
        forceAudioRebuild: Boolean(input.synthesize.forceSceneIndexes?.length),
        forceSceneIndexes: input.synthesize.forceSceneIndexes,
        cacheSalt: input.synthesize.cacheSalt,
      });
    const audioMs = Date.now() - audioStartedAt;
    const outputPath = path.join(rootDir, input.name, "final.mp4");
    const renderResult = await renderHtmlVideoProject(withAudio, outputPath, {
      workDir: input.render.workDir,
      forceSceneIndexes: input.render.forceSceneIndexes,
      remuxOnly: input.render.remuxOnly,
      renderBudget,
      cacheFingerprint: fingerprint,
      browserLauncher: runtime.browserLauncher,
      sceneRecorder: runtime.sceneRecorder,
      concatRenderer: runtime.concatRenderer as HtmlVideoRenderOptions["concatRenderer"],
      audioMuxer: runtime.audioMuxer as HtmlVideoRenderOptions["audioMuxer"],
    });
    const after = await workerMetrics(metricsFile);
    const delta = metricDelta(before, after);
    return {
      project: withAudio,
      audioMs,
      renderResult,
      report: {
        elapsedMs: Date.now() - startedAt,
        ...delta,
        videoMaxConcurrency: runtime.state.peak,
        recordedVideoScenes: [...runtime.state.recordedScenes].sort((left, right) => left - right),
        generatedAudioScenes: input.synthesize ? indexes(withAudio.audio?.metrics?.generatedAudioSceneIndexes) : [],
        reusedAudioScenes: input.synthesize ? indexes(withAudio.audio?.metrics?.reusedAudioSceneIndexes) : [],
        forceSceneIndexes: input.synthesize?.forceSceneIndexes ?? input.render.forceSceneIndexes ?? [],
        concatAudio: Boolean(input.synthesize && withAudio.audio?.metrics?.concatenatedAudio),
        concatVideo: runtime.state.concatCount > 0,
        mux: runtime.state.muxCount > 0,
        outputComplete: await outputComplete(outputPath),
      } satisfies IncrementalScenarioReport,
    };
  };

  try {
    const coldWorkDir = path.join(rootDir, "cold", "video");
    const warmWorkDir = path.join(rootDir, "warm", "video");
    const cold = await scenario({ name: "cold", sourceProject: project, synthesize: {}, render: { workDir: coldWorkDir } });
    const warm = await scenario({ name: "warm", sourceProject: project, synthesize: {}, render: { workDir: warmWorkDir } });
    const audioPlan = dirtyPlanFromIssues([{
      code: "audio_pronunciation_mismatch", stage: "audio", severity: "error", message: "重构读音错误",
      sceneIndex: 2, issueClass: "hard", evidence: {}, repairAction: "resynthesize-audio", retryable: true,
    }], 5);
    const audioRepair = await scenario({
      name: "audio-repair", sourceProject: warm.project,
      synthesize: { forceSceneIndexes: audioPlan.audioSceneIndexes, cacheSalt: "benchmark-pronunciation-scene-2" },
      render: { workDir: warmWorkDir, remuxOnly: audioPlan.remux },
    });
    const videoPlan = dirtyPlanFromIssues([{
      code: "blank_frame", stage: "video", severity: "error", message: "blank",
      sceneIndex: 3, issueClass: "hard", evidence: {}, repairAction: "rerender-scenes", retryable: true,
    }], 5);
    const videoRepair = await scenario({
      name: "video-repair", sourceProject: audioRepair.project,
      render: { workDir: warmWorkDir, forceSceneIndexes: videoPlan.videoSceneIndexes },
    });
    const remuxPlan = dirtyPlanFromIssues([{
      code: "stream_duration_drift", stage: "video", severity: "error", message: "drift",
      issueClass: "hard", evidence: {}, repairAction: "remux", retryable: true,
    }], 5);
    const remuxOnly = await scenario({
      name: "remux-only", sourceProject: audioRepair.project,
      render: { workDir: warmWorkDir, remuxOnly: remuxPlan.remux },
    });
    process.env.TTS_PRONUNCIATION_LEXICON = lexiconV2;
    const lexiconChange = await scenario({
      name: "lexicon-change", sourceProject: warm.project, synthesize: {}, render: { workDir: path.join(rootDir, "lexicon-change", "video") },
    });
    const warmHits = (warm.project.audio?.metrics?.cacheHitCount ?? 0) + warm.renderResult.metrics.cacheHitScenes.length;
    return {
      coldRunMs: cold.report.elapsedMs,
      warmRunMs: warm.report.elapsedMs,
      modelLoadMs: cold.project.audio?.metrics?.modelLoadMs ?? 0,
      audioGenerationMs: cold.audioMs,
      videoGenerationMs: cold.renderResult.metrics.totalRenderMs,
      concatMs: cold.renderResult.metrics.concatMs,
      muxMs: cold.renderResult.metrics.muxMs,
      cacheHitRatio: warmHits / 10,
      regeneratedAudioScenes: audioRepair.report.generatedAudioScenes,
      regeneratedVideoScenes: videoRepair.report.recordedVideoScenes,
      scenarios: {
        cold: cold.report,
        warm: warm.report,
        audioRepair: audioRepair.report,
        videoRepair: videoRepair.report,
        remuxOnly: remuxOnly.report,
        lexiconChange: lexiconChange.report,
      },
    };
  } finally {
    for (const name of envNames) {
      const value = previous[name];
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(path.join(rootDir, "worker-metrics.json.tmp"), { force: true }).catch(() => undefined);
  }
}
