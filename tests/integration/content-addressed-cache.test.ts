import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectMediaCache, pruneMediaCache } from "../../src/cache/cache-manager";
import { getOrCreateMediaCache, mediaCachePaths, restoreMediaCache } from "../../src/cache/media-cache";
import { fromRoot } from "../../src/pipeline/utils";

test("content-addressed cache reuses across runs, single-flights, and protects active references", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scene-gen-cas-"));
  const cacheDir = path.join(directory, "cache");
  const runId = `cache-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runDir = fromRoot("dist", "runs", runId);
  const previousCacheDir = process.env.SCENE_GEN_CACHE_DIR;
  process.env.SCENE_GEN_CACHE_DIR = cacheDir;
  let generateCount = 0;
  try {
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "run.json"), JSON.stringify({ status: "running" }), "utf8");
    const cacheKey = "a".repeat(64);
    const targets = [path.join(runDir, "audio", "first.wav"), path.join(directory, "other-run", "second.wav")];
    const generate = async (outputPath: string) => {
      generateCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      await writeFile(outputPath, "shared-audio", "utf8");
    };
    const results = await Promise.all(targets.map((targetPath) => getOrCreateMediaCache({
      kind: "audio", cacheKey, extension: ".wav", targetPath, identity: { provider: "mock", text: "same" }, generate,
    })));
    assert.equal(generateCount, 1, "concurrent runs must generate one cache key once");
    assert.equal(results.filter((result) => result.generated).length, 1);
    assert.equal(await readFile(targets[0], "utf8"), "shared-audio");
    assert.equal(await readFile(targets[1], "utf8"), "shared-audio");

    const third = path.join(directory, "third-run", "third.wav");
    await getOrCreateMediaCache({ kind: "audio", cacheKey, extension: ".wav", targetPath: third, identity: { provider: "mock", text: "same" }, generate });
    assert.equal(generateCount, 1, "a later run must restore from global cache");

    const partialKey = "b".repeat(64);
    const partial = mediaCachePaths("audio", partialKey, ".wav");
    await mkdir(path.dirname(partial.mediaPath), { recursive: true });
    await writeFile(partial.mediaPath, "partial", "utf8");
    assert.equal(await restoreMediaCache({ kind: "audio", cacheKey: partialKey, extension: ".wav", targetPath: path.join(directory, "partial.wav") }), undefined);

    const protectedPrune = await pruneMediaCache({ maxSizeBytes: 0 });
    assert.equal(protectedPrune.deletedCount, 0, "active run references must be protected");
    assert.equal(protectedPrune.protectedActiveCount, 1);
    await writeFile(path.join(runDir, "run.json"), JSON.stringify({ status: "succeeded" }), "utf8");
    const completedPrune = await pruneMediaCache({ maxSizeBytes: 0 });
    assert.equal(completedPrune.deletedCount, 1);
    assert.equal((await inspectMediaCache()).count, 0);
  } finally {
    if (previousCacheDir === undefined) delete process.env.SCENE_GEN_CACHE_DIR;
    else process.env.SCENE_GEN_CACHE_DIR = previousCacheDir;
    await rm(runDir, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
