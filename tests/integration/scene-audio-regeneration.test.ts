import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { renderHtmlVideoProject } from "../../src/html-video/render-html-video";
import { attachNarrationAudio } from "../../src/pipeline/tts";
import { fromRoot } from "../../src/pipeline/utils";
import { resolvePythonCommand } from "../../src/runtime/runtime-paths";
import { createFixtureProject } from "../fixtures/project";

const execFileAsync = promisify(execFile);

async function lineCount(filePath: string) {
  return readFile(filePath, "utf8").then((value) => value.trim().split(/\r?\n/).filter(Boolean).length).catch(() => 0);
}

function fiveSceneProject() {
  const fixture = createFixtureProject();
  const texts = ["Scene zero", "Scene one", "Scene two", "Scene three", "Scene four"];
  return createFixtureProject({
    meta: { ...fixture.meta, title: texts[0], durationSeconds: 5 },
    narration: texts.join(". "),
    narrationSegments: texts.map((text, sceneIndex) => ({ sceneIndex, text, audioStartSeconds: sceneIndex, durationSeconds: 1 })),
    scenes: texts.map((text) => ({ ...fixture.scenes[0], headline: text, duration: 1 })),
  });
}

test("scene-scoped audio repair rebuilds one segment and re-concatenates narration", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scene-gen-partial-audio-"));
  const generatedDir = path.join(directory, "generated");
  const refAudio = path.join(directory, "reference.wav");
  const requestCount = path.join(directory, "requests.txt");
  await writeFile(refAudio, "fixture");
  const names = [
    "F5_TTS_PYTHON", "F5_TTS_WORKER_SCRIPT", "F5_TTS_REF_AUDIO", "F5_TTS_REF_TEXT",
    "F5_TTS_WORKER_MODE", "F5_TTS_DEVICE", "F5_TTS_CONCURRENCY", "MOCK_F5_REQUEST_COUNT_FILE",
    "TTS_DURATION_POLICY", "SCENE_GEN_CACHE_DIR",
  ] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    F5_TTS_PYTHON: resolvePythonCommand(),
    F5_TTS_WORKER_SCRIPT: fromRoot("tests", "fixtures", "mock-f5-worker.py"),
    F5_TTS_REF_AUDIO: refAudio,
    F5_TTS_REF_TEXT: "reference",
    F5_TTS_WORKER_MODE: "worker",
    F5_TTS_DEVICE: "cuda:0",
    F5_TTS_CONCURRENCY: "1",
    MOCK_F5_REQUEST_COUNT_FILE: requestCount,
    TTS_DURATION_POLICY: "natural",
    SCENE_GEN_CACHE_DIR: path.join(directory, "cache"),
  });
  try {
    const project = fiveSceneProject();
    const initial = await attachNarrationAudio(project, "partial", { generatedDir, provider: "f5" });
    assert.equal(await lineCount(requestCount), 5);
    const secondRun = await attachNarrationAudio(project, "partial-second-run", { generatedDir: path.join(directory, "second-run"), provider: "f5" });
    assert.equal(await lineCount(requestCount), 5, "identical audio in a second run must use the global cache");
    assert.equal(secondRun.audio?.metrics?.reusedSceneCount, 5);
    const narrationPath = path.join(generatedDir, "partial.wav");
    const initialMtime = (await stat(narrationPath)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));

    const repaired = await attachNarrationAudio(initial, "partial", {
      generatedDir,
      provider: "f5",
      forceAudioRebuild: true,
      forceSceneIndexes: [2],
      cacheSalt: "audio:audio_pronunciation_mismatch:2",
      reason: "audio_pronunciation_mismatch",
    });
    assert.equal(await lineCount(requestCount), 6, "only the faulty scene should call TTS");
    assert.equal(repaired.audio?.metrics?.generatedAudioSceneIndexes, "2");
    assert.equal(repaired.audio?.metrics?.reusedAudioSceneIndexes, "0,1,3,4");
    assert.equal(repaired.audio?.metrics?.forcedAudioSceneIndexes, "2");
    assert.equal(repaired.audio?.metrics?.concatenatedAudio, true);
    assert.ok((await stat(narrationPath)).mtimeMs > initialMtime, "combined narration must be rebuilt");

    const reusedRepair = await attachNarrationAudio(repaired, "partial", { generatedDir, provider: "f5" });
    assert.equal(await lineCount(requestCount), 6, "the repaired scene salt should remain reusable on the next run");
    assert.equal(reusedRepair.audio?.metrics?.audioGenerationKey, repaired.audio?.metrics?.audioGenerationKey);

    const rebuiltAll = await attachNarrationAudio(reusedRepair, "partial", {
      generatedDir,
      provider: "f5",
      forceAudioRebuild: true,
      cacheSalt: "audio:global-rebuild:all",
      reason: "global-rebuild",
    });
    assert.equal(await lineCount(requestCount), 11, "missing sceneIndex should rebuild all five scenes");
    assert.equal(rebuiltAll.audio?.metrics?.generatedSceneCount, 5);
    assert.equal(rebuiltAll.audio?.metrics?.forcedAudioSceneIndexes, "0,1,2,3,4");
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("two-second cached silent video is remuxed without recording scenes", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scene-gen-remux-only-"));
  const workDir = path.join(directory, "html-video");
  const silentVideoPath = path.join(workDir, "video-no-audio.mp4");
  const audioPath = path.join(directory, "replacement.wav");
  const outputPath = path.join(directory, "final.mp4");
  await (await import("node:fs/promises")).mkdir(workDir, { recursive: true });
  try {
    await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=30:d=2", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", silentVideoPath], { windowsHide: true });
    await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=660:duration=2", "-ar", "24000", "-ac", "1", audioPath], { windowsHide: true });
    const fixture = createFixtureProject();
    const project = createFixtureProject({
      meta: { ...fixture.meta, width: 320, height: 240, durationSeconds: 2 },
      narrationSegments: [{ sceneIndex: 0, text: fixture.narration, audioStartSeconds: 0, durationSeconds: 2 }],
      scenes: [{ ...fixture.scenes[0], duration: 2 }],
      audio: { src: audioPath, durationSeconds: 2, provider: "f5" },
    });
    const result = await renderHtmlVideoProject(project, outputPath, { workDir, remuxOnly: true });
    assert.equal(result.remuxedVideo, true);
    assert.equal(result.frames.length, 0, "remux-only must not record any scene");
    const probe = await execFileAsync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", outputPath], { windowsHide: true });
    assert.match(probe.stdout, /audio/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
