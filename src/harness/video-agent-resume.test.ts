import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { writeStoryManifest } from "../pipeline/story-manifest";
import { fromRoot, writeJsonAtomic } from "../pipeline/utils";
import { RunJournalStore } from "./run-journal";
import { runVideoAgent } from "./video-agent";
import { buildRuntimeConfig, runtimeConfigHash, runtimeConfigSnapshot, runtimeConfigWithRunOverrides } from "../config/runtime-config";

test("resume from publish reuses prior project and gate artifacts", async () => {
  const runId = `resume-test-${randomUUID()}`;
  const runDir = fromRoot("dist", "runs", runId);
  const projectPath = path.join(runDir, "projects", "story.json");
  const manifestPath = path.join(runDir, "manifest.json");
  const draftPath = path.join(runDir, "evaluations", "iteration-1-draft.json");
  const audioPath = path.join(runDir, "evaluations", "iteration-1-audio.json");
  const videoPath = path.join(runDir, "evaluations", "video-attempt-1.json");
  const outputPath = path.join(runDir, "output.mp4");
  const project = {
    meta: { title: "恢复测试标题", createdAt: "2026-07-15T00:00:00.000Z", width: 1080, height: 1920, fps: 30, durationSeconds: 10, sourceCount: 1 },
    narration: "恢复测试标题。",
    narrationSegments: [{ sceneIndex: 0, text: "恢复测试标题。", audioStartSeconds: 0, durationSeconds: 10 }],
    scenes: [{ type: "title", duration: 10, kicker: "测试", headline: "恢复测试标题", subhead: "恢复发布阶段", sources: ["核心事实"] }],
    sources: [{ id: "resume", kind: "webpage", title: "恢复测试标题", url: "https://example.com/resume", source: "核心事实", summary: "恢复测试", score: 1, tags: ["test"] }],
  };
  const draft = { stage: "draft", passed: true, issues: [], revisionNotes: [], metrics: {} };
  const audio = { stage: "audio", passed: true, issues: [], revisionNotes: [], metrics: {} };
  const video = { stage: "video", passed: true, issues: [], revisionNotes: [], metrics: {} };
  try {
    await writeJsonAtomic(projectPath, project);
    await writeStoryManifest(manifestPath, [{ index: 1, title: project.meta.title, source: "核心事实", sourceUrl: project.sources[0].url, score: 1, projectPath, outputPath }]);
    await writeJsonAtomic(draftPath, draft);
    await writeJsonAtomic(audioPath, audio);
    await writeJsonAtomic(videoPath, video);
    const journal = await RunJournalStore.create(runDir, {
      runId,
      url: project.sources[0].url,
      config: { targetSeconds: 10, maxIterations: 1, engine: "html-video", outputDir: runDir, screenshotLimit: 0 },
    });
    await journal.setArtifacts({ manifestPath, projectPath, outputPath, iteration1Draft: draftPath, iteration1Audio: audioPath, videoEvaluation: videoPath });

    const result = await runVideoAgent(["--resume", runId, "--from-stage", "publish"]);
    assert.equal(result.passed, true);
    const stages = (await RunJournalStore.open(runDir)).snapshot().stages;
    assert.equal(stages.some((stage) => stage.name === "publish" && stage.status === "succeeded"), true);
    assert.equal(stages.some((stage) => stage.name === "render"), false);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("resume rejects configuration drift unless override-config is explicit", async () => {
  const runId = `resume-config-test-${randomUUID()}`;
  const runDir = fromRoot("dist", "runs", runId);
  const initial = buildRuntimeConfig({ SCENE_GEN_PROFILE: "test", NEWS_LLM_MODEL: "model" });
  const changed = runtimeConfigWithRunOverrides(initial, { screenshotLimit: 3 });
  try {
    await RunJournalStore.create(runDir, {
      runId,
      url: "https://example.com/config-resume",
      config: {
        targetSeconds: 30,
        maxIterations: 2,
        engine: "html-video",
        qualityProfile: "balanced",
        outputDir: runDir,
        screenshotLimit: 0,
        runtimeProfile: initial.profile,
        runtimeConfig: runtimeConfigSnapshot(initial),
        runtimeConfigHash: runtimeConfigHash(initial),
      },
    });
    await assert.rejects(() => runVideoAgent(["--resume", runId], undefined, changed), /Runtime config hash differs/);
    await assert.rejects(() => runVideoAgent(["--resume", runId, "--screenshots", "3"], undefined, initial), /--override-config/);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});
