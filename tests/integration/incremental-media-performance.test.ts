import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runIncrementalMediaBenchmark } from "../fixtures/incremental-media-runner";

test("incremental media benchmark verifies cold, warm and minimum dirty plans", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scene-gen-incremental-media-"));
  try {
    const report = await runIncrementalMediaBenchmark(directory);
    const { cold, warm, audioRepair, videoRepair, remuxOnly, lexiconChange } = report.scenarios;

    assert.equal(cold.ttsCalls, 5);
    assert.equal(cold.workerStarts, 1);
    assert.equal(cold.modelLoads, 1);
    assert.equal(cold.maxConcurrency, 1);
    assert.equal(cold.videoMaxConcurrency, 2);
    assert.deepEqual(cold.generatedAudioScenes, [0, 1, 2, 3, 4]);
    assert.deepEqual(cold.recordedVideoScenes, [0, 1, 2, 3, 4]);
    assert.equal(cold.concatAudio && cold.concatVideo && cold.mux && cold.outputComplete, true);

    assert.equal(warm.ttsCalls, 0);
    assert.equal(warm.workerStarts, 0);
    assert.equal(warm.modelLoads, 0);
    assert.equal(warm.maxConcurrency, 0);
    assert.equal(warm.videoMaxConcurrency, 0);
    assert.deepEqual(warm.recordedVideoScenes, []);
    assert.deepEqual(warm.reusedAudioScenes, [0, 1, 2, 3, 4]);
    assert.equal(warm.outputComplete, true);
    assert.equal(report.cacheHitRatio, 1);
    assert.ok(warm.ttsCalls + warm.recordedVideoScenes.length < cold.ttsCalls + cold.recordedVideoScenes.length);

    assert.equal(audioRepair.ttsCalls, 1);
    assert.deepEqual(audioRepair.generatedAudioScenes, [2]);
    assert.deepEqual(audioRepair.reusedAudioScenes, [0, 1, 3, 4]);
    assert.deepEqual(audioRepair.forceSceneIndexes, [2]);
    assert.deepEqual(audioRepair.recordedVideoScenes, []);
    assert.equal(audioRepair.concatAudio, true);
    assert.equal(audioRepair.concatVideo, false);
    assert.equal(audioRepair.mux, true);

    assert.equal(videoRepair.ttsCalls, 0);
    assert.deepEqual(videoRepair.recordedVideoScenes, [3]);
    assert.equal(videoRepair.videoMaxConcurrency, 1);
    assert.deepEqual(videoRepair.forceSceneIndexes, [3]);
    assert.equal(videoRepair.concatVideo, true);
    assert.equal(videoRepair.mux, true);

    assert.equal(remuxOnly.ttsCalls, 0);
    assert.deepEqual(remuxOnly.recordedVideoScenes, []);
    assert.equal(remuxOnly.concatAudio, false);
    assert.equal(remuxOnly.concatVideo, false);
    assert.equal(remuxOnly.mux, true);

    assert.equal(lexiconChange.ttsCalls, 1);
    assert.deepEqual(lexiconChange.generatedAudioScenes, [2]);
    assert.deepEqual(lexiconChange.reusedAudioScenes, [0, 1, 3, 4]);
    assert.deepEqual(lexiconChange.recordedVideoScenes, []);
    assert.equal(lexiconChange.outputComplete, true);
    assert.deepEqual(report.regeneratedAudioScenes, [2]);
    assert.deepEqual(report.regeneratedVideoScenes, [3]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
