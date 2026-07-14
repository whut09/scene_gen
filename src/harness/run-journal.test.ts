import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { RunJournalStore, runJournalSchema } from "./run-journal";

test("run journal persists stage progress and terminal status", async () => {
  const runDir = await mkdtemp(path.join(tmpdir(), "scene-gen-run-"));
  try {
    const journal = await RunJournalStore.create(runDir, {
      runId: "run-1",
      url: "https://example.com/news",
      config: {
        targetSeconds: 100,
        maxIterations: 2,
        engine: "html-video",
        outputDir: path.join(runDir, "output"),
        screenshotLimit: 0,
      },
    });
    await journal.startStage("generate", 1);
    await journal.finishStage("generate", 1, "succeeded", {
      outputs: { projectPath: path.join(runDir, "projects", "story.json") },
      metrics: { cacheHit: true },
    });
    await journal.succeed();

    const persisted = runJournalSchema.parse(JSON.parse(await readFile(journal.filePath, "utf8")));
    assert.equal(persisted.status, "succeeded");
    assert.equal(persisted.stages[0].status, "succeeded");
    assert.equal(persisted.stages[0].metrics?.cacheHit, true);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});
