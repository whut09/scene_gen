import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { RunJournalStore, runJournalSchema } from "./run-journal";
import { buildRuntimeConfig, runtimeConfigHash, runtimeConfigSnapshot, runtimeConfigWithRunOverrides } from "../config/runtime-config";

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

test("run journal records redacted runtime config and override history", async () => {
  const runDir = await mkdtemp(path.join(tmpdir(), "scene-gen-config-run-"));
  try {
    const initial = buildRuntimeConfig({ NEWS_LLM_API_KEY: "secret", NEWS_LLM_MODEL: "model", SCENE_GEN_PROFILE: "test" });
    const journal = await RunJournalStore.create(runDir, {
      runId: "run-config",
      url: "https://example.com/config",
      config: { targetSeconds: 30, maxIterations: 2, engine: "html-video", outputDir: path.join(runDir, "output"), screenshotLimit: 0 },
    });
    await journal.setRuntimeConfig(runtimeConfigSnapshot(initial), runtimeConfigHash(initial));
    const overridden = runtimeConfigWithRunOverrides(initial, { screenshotLimit: 2 });
    await journal.setRuntimeConfig(runtimeConfigSnapshot(overridden), runtimeConfigHash(overridden));
    const persisted = JSON.parse(await readFile(journal.filePath, "utf8"));
    assert.equal(JSON.stringify(persisted).includes("secret"), false);
    assert.equal(persisted.config.runtimeConfig.rendering.screenshotLimit, 2);
    assert.equal(persisted.config.configOverrides.length, 1);
    assert.equal(persisted.config.configOverrides[0].previousHash, runtimeConfigHash(initial));
    assert.equal(persisted.config.configOverrides[0].nextHash, runtimeConfigHash(overridden));
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});
