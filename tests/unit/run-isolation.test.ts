import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { RunJournalStore } from "../../src/harness/run-journal";
import { readStoryManifest, writeStoryManifest } from "../../src/pipeline/story-manifest";

test("manifests and journals remain isolated across concurrent runs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scene-gen-isolation-"));
  const runDirs = [path.join(root, "run-a"), path.join(root, "run-b")];
  try {
    await Promise.all(runDirs.map(async (runDir, index) => {
      const projectPath = path.join(runDir, "projects", "story.json");
      const outputPath = path.join(runDir, "output", "story.mp4");
      const manifestPath = path.join(runDir, "manifest.json");
      await writeStoryManifest(manifestPath, [{
        index: 1,
        title: `Run ${index}`,
        source: `Source ${index}`,
        sourceUrl: `https://example.com/${index}`,
        score: index,
        projectPath,
        outputPath,
      }]);
      const journal = await RunJournalStore.create(runDir, {
        runId: `run-${index}`,
        url: `https://example.com/${index}`,
        config: { targetSeconds: 10, maxIterations: 1, engine: "html-video", outputDir: path.join(runDir, "output"), screenshotLimit: 0 },
      });
      await journal.setArtifacts({ manifestPath, projectPath, outputPath });
    }));

    const [manifestA, manifestB] = await Promise.all(runDirs.map((runDir) => readStoryManifest(path.join(runDir, "manifest.json"))));
    assert.notEqual(manifestA[0].projectPath, manifestB[0].projectPath);
    assert.equal(manifestA[0].projectPath.startsWith(runDirs[0]), true);
    assert.equal(manifestB[0].projectPath.startsWith(runDirs[1]), true);
    const journals = await Promise.all(runDirs.map((runDir) => readFile(path.join(runDir, "run.json"), "utf8")));
    assert.notEqual(journals[0], journals[1]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
