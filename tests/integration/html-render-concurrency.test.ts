import assert from "node:assert/strict";
import { readdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Browser } from "playwright";
import {
  HtmlSceneRenderError,
  renderHtmlVideoProject,
  type HtmlVideoRenderOptions,
  type SceneRecordInput,
} from "../../src/html-video/render-html-video";
import type { HtmlRenderBudget } from "../../src/html-video/render-budget";
import { createFixtureProject } from "../fixtures/project";

function fiveSceneProject() {
  const fixture = createFixtureProject();
  const scenes = Array.from({ length: 5 }, (_, sceneIndex) => ({
    ...fixture.scenes[0],
    headline: `Parallel scene ${sceneIndex}`,
    duration: 0.2,
  }));
  return createFixtureProject({
    meta: { ...fixture.meta, title: "Parallel HTML render", width: 320, height: 240, durationSeconds: 1 },
    narrationSegments: scenes.map((_, sceneIndex) => ({ sceneIndex, text: `Scene ${sceneIndex}`, audioStartSeconds: sceneIndex * 0.2, durationSeconds: 0.2 })),
    scenes,
    audio: undefined,
  });
}

function budget(renderConcurrency: number): HtmlRenderBudget {
  return {
    renderConcurrency,
    ffmpegThreadsPerJob: Math.max(1, Math.floor(4 / renderConcurrency)),
    encodingPreset: "ultrafast",
    cpuCount: 4,
    availableMemoryBytes: 8 * 1024 ** 3,
  };
}

function abortableDelay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function fakeRuntime(input: { failScene?: number; slowScenes?: number[] } = {}) {
  const state = {
    browserLaunches: 0,
    browserClosed: false,
    contextsCreated: 0,
    activeContexts: 0,
    peakContexts: 0,
    startedScenes: [] as number[],
    ffmpegThreads: [] as number[],
    encodingPresets: [] as string[],
  };
  const browser = {
    async newContext() {
      state.contextsCreated += 1;
      state.activeContexts += 1;
      state.peakContexts = Math.max(state.peakContexts, state.activeContexts);
      let closed = false;
      return {
        async close() {
          if (closed) return;
          closed = true;
          state.activeContexts -= 1;
        },
      };
    },
    async close() {
      state.browserClosed = true;
    },
  } as unknown as Pick<Browser, "newContext" | "close">;
  const browserLauncher = async () => {
    state.browserLaunches += 1;
    return browser;
  };
  const sceneRecorder = async (scene: SceneRecordInput) => {
    state.startedScenes.push(scene.sceneIndex);
    state.ffmpegThreads.push(scene.ffmpegThreads);
    state.encodingPresets.push(scene.encodingPreset);
    const context = await scene.browser.newContext();
    const started = Date.now();
    try {
      const delay = input.slowScenes?.includes(scene.sceneIndex) ? 200 : 15;
      await abortableDelay(delay, scene.signal);
      if (scene.sceneIndex === input.failScene) throw new Error("fixture scene failure");
      await writeFile(scene.outputPath, `scene-${scene.sceneIndex}`, "utf8");
      return { detectedMotionSec: 0.1, recordMs: Date.now() - started, encodeMs: 1 };
    } finally {
      await context.close();
    }
  };
  return { state, browserLauncher, sceneRecorder };
}

function assembly(order: number[]) {
  return {
    concatRenderer: async (frames: Array<{ sceneIndex: number }>, outputPath: string) => {
      order.push(...frames.map((frame) => frame.sceneIndex));
      await writeFile(outputPath, "silent-video", "utf8");
    },
    audioMuxer: async (_project: unknown, _videoPath: string, outputPath: string) => {
      await writeFile(outputPath, "final-video", "utf8");
    },
  } satisfies Pick<HtmlVideoRenderOptions, "concatRenderer" | "audioMuxer">;
}

test("five-scene HTML render shares one browser and obeys bounded concurrency", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scene-gen-html-concurrency-"));
  const previousCacheDir = process.env.SCENE_GEN_CACHE_DIR;
  process.env.SCENE_GEN_CACHE_DIR = path.join(directory, "cache");
  try {
    const serialRuntime = fakeRuntime();
    const serialOrder: number[] = [];
    const serial = await renderHtmlVideoProject(fiveSceneProject(), path.join(directory, "serial.mp4"), {
      workDir: path.join(directory, "serial"), renderBudget: budget(1),
      browserLauncher: serialRuntime.browserLauncher, sceneRecorder: serialRuntime.sceneRecorder,
      ...assembly(serialOrder),
    });
    assert.equal(serialRuntime.state.browserLaunches, 1);
    assert.equal(serialRuntime.state.peakContexts, 1);
    assert.deepEqual(serialOrder, [0, 1, 2, 3, 4]);
    assert.equal(serial.metrics.renderConcurrency, 1);

    const parallelWorkDir = path.join(directory, "parallel");
    const parallelRuntime = fakeRuntime();
    const parallelOrder: number[] = [];
    const parallel = await renderHtmlVideoProject(fiveSceneProject(), path.join(directory, "parallel.mp4"), {
      workDir: parallelWorkDir, renderBudget: budget(2),
      browserLauncher: parallelRuntime.browserLauncher, sceneRecorder: parallelRuntime.sceneRecorder,
      ...assembly(parallelOrder),
    });
    assert.equal(parallelRuntime.state.browserLaunches, 1);
    assert.equal(parallelRuntime.state.peakContexts, 2);
    assert.equal(parallelRuntime.state.contextsCreated, 5);
    assert.deepEqual([...new Set(parallelRuntime.state.ffmpegThreads)], [2]);
    assert.deepEqual([...new Set(parallelRuntime.state.encodingPresets)], ["ultrafast"]);
    assert.deepEqual(parallelOrder, [0, 1, 2, 3, 4]);
    assert.deepEqual(parallel.metrics.renderedScenes, [0, 1, 2, 3, 4]);

    const cacheRuntime = fakeRuntime();
    const cacheResult = await renderHtmlVideoProject(fiveSceneProject(), path.join(directory, "cached.mp4"), {
      workDir: parallelWorkDir, renderBudget: budget(2),
      browserLauncher: cacheRuntime.browserLauncher, sceneRecorder: cacheRuntime.sceneRecorder,
      ...assembly([]),
    });
    assert.equal(cacheRuntime.state.browserLaunches, 0);
    assert.equal(cacheRuntime.state.contextsCreated, 0);
    assert.deepEqual(cacheResult.metrics.cacheHitScenes, [0, 1, 2, 3, 4]);

    const forcedRuntime = fakeRuntime();
    const forced = await renderHtmlVideoProject(fiveSceneProject(), path.join(directory, "forced.mp4"), {
      workDir: parallelWorkDir, forceSceneIndexes: [2], renderBudget: budget(2),
      browserLauncher: forcedRuntime.browserLauncher, sceneRecorder: forcedRuntime.sceneRecorder,
      ...assembly([]),
    });
    assert.equal(forcedRuntime.state.browserLaunches, 1);
    assert.equal(forcedRuntime.state.contextsCreated, 1);
    assert.deepEqual(forced.metrics.renderedScenes, [2]);
    assert.deepEqual(forced.metrics.cacheHitScenes, [0, 1, 3, 4]);
  } finally {
    if (previousCacheDir === undefined) delete process.env.SCENE_GEN_CACHE_DIR; else process.env.SCENE_GEN_CACHE_DIR = previousCacheDir;
    await rm(directory, { recursive: true, force: true });
  }
});

test("scene failure preserves successful caches and resume renders only unfinished scenes", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scene-gen-html-failure-"));
  const workDir = path.join(directory, "work");
  const previousCacheDir = process.env.SCENE_GEN_CACHE_DIR;
  process.env.SCENE_GEN_CACHE_DIR = path.join(directory, "cache");
  try {
    const failingRuntime = fakeRuntime({ failScene: 2, slowScenes: [3, 4] });
    await assert.rejects(
      renderHtmlVideoProject(fiveSceneProject(), path.join(directory, "failed.mp4"), {
        workDir, renderBudget: budget(2), browserLauncher: failingRuntime.browserLauncher,
        sceneRecorder: failingRuntime.sceneRecorder, ...assembly([]),
      }),
      (error: unknown) => error instanceof HtmlSceneRenderError && error.sceneIndex === 2,
    );
    assert.equal(failingRuntime.state.browserClosed, true);
    assert.equal(failingRuntime.state.activeContexts, 0);
    assert.equal(failingRuntime.state.startedScenes.includes(4), false, "unstarted work must be cancelled");
    const successfulCaches = (await readdir(workDir)).filter((file) => file.endsWith(".cache.json"));
    assert.equal(successfulCaches.length, 2);

    const resumeRuntime = fakeRuntime();
    const resumed = await renderHtmlVideoProject(fiveSceneProject(), path.join(directory, "resumed.mp4"), {
      workDir, renderBudget: budget(2), browserLauncher: resumeRuntime.browserLauncher,
      sceneRecorder: resumeRuntime.sceneRecorder, ...assembly([]),
    });
    assert.deepEqual(resumed.metrics.cacheHitScenes, [0, 1]);
    assert.deepEqual(resumed.metrics.renderedScenes, [2, 3, 4]);
  } finally {
    if (previousCacheDir === undefined) delete process.env.SCENE_GEN_CACHE_DIR; else process.env.SCENE_GEN_CACHE_DIR = previousCacheDir;
    await rm(directory, { recursive: true, force: true });
  }
});

test("AbortSignal closes browser and active contexts", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scene-gen-html-abort-"));
  const runtime = fakeRuntime({ slowScenes: [0, 1, 2, 3, 4] });
  const controller = new AbortController();
  const previousCacheDir = process.env.SCENE_GEN_CACHE_DIR;
  process.env.SCENE_GEN_CACHE_DIR = path.join(directory, "cache");
  try {
    const pending = renderHtmlVideoProject(fiveSceneProject(), path.join(directory, "aborted.mp4"), {
      workDir: path.join(directory, "work"), renderBudget: budget(2), signal: controller.signal,
      browserLauncher: runtime.browserLauncher, sceneRecorder: runtime.sceneRecorder, ...assembly([]),
    });
    setTimeout(() => controller.abort(new Error("fixture abort")), 30);
    await assert.rejects(pending, /fixture abort/);
    assert.equal(runtime.state.browserClosed, true);
    assert.equal(runtime.state.activeContexts, 0);
  } finally {
    if (previousCacheDir === undefined) delete process.env.SCENE_GEN_CACHE_DIR; else process.env.SCENE_GEN_CACHE_DIR = previousCacheDir;
    await rm(directory, { recursive: true, force: true });
  }
});
