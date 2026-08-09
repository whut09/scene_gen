import assert from "node:assert/strict";
import test from "node:test";
import type { VideoProject } from "../../pipeline/types";
import { narrationRateMetrics, ttsConventionIssues } from "./audio-rules";

test("narration speed metrics use synthesis text when ttsText differs from display text", () => {
  const project = {
    narration: "这是很长的屏幕展示文本，但语音只读短标题。第二屏保持正常旁白。",
    narrationSegments: [
      { sceneIndex: 0, text: "这是很长的屏幕展示文本，但语音只读短标题。", ttsText: "短标题", durationSeconds: 1 },
      { sceneIndex: 1, text: "第二屏正常", durationSeconds: 2 },
    ],
  } as VideoProject;
  const metrics = narrationRateMetrics(project);
  assert.equal(metrics.narrationChars, 8);
  assert.deepEqual(metrics.segmentRates, [3, 2.5]);
});

test("proper-name guard accepts numeric speech normalization without translation", () => {
  const project = {
    meta: { title: "fixture", createdAt: "2026-07-25T00:00:00.000Z", width: 1080, height: 1920, fps: 30, durationSeconds: 5, sourceCount: 1 },
    narration: "Frontier-Bench v0.1 的结果已经公布。",
    narrationSegments: [{ sceneIndex: 0, text: "Frontier-Bench v0.1 的结果已经公布。", ttsText: "Frontier-Bench v零点一 的结果已经公布。" }],
    scenes: [{ type: "title" as const, duration: 5, kicker: "fixture", headline: "fixture", subhead: "fixture", sources: ["fixture"] }],
    sources: [],
  } satisfies VideoProject;

  assert.equal(ttsConventionIssues(project).some((issue) => issue.code === "tts_proper_name_translated"), false);
});

test("news number gate requires natural readings for 90后 and 2000元", () => {
  const project = {
    meta: { title: "数字新闻", createdAt: "2026-07-30T00:00:00.000Z", width: 1080, height: 1920, fps: 30, durationSeconds: 5, sourceCount: 1 },
    narration: "90后奶爸平均每分钟算力成本2000元。",
    narrationSegments: [{ sceneIndex: 0, text: "90后奶爸平均每分钟算力成本2000元。", providerSynthesisText: "九十后奶爸平均每分钟算力成本二零零零元。", ttsProvider: "nvidia" }],
    scenes: [{ type: "title" as const, duration: 5, kicker: "fixture", headline: "数字新闻", subhead: "fixture", sources: ["fixture"] }],
    sources: [],
  } satisfies VideoProject;

  assert.equal(ttsConventionIssues(project).some((issue) => issue.code === "tts_contextual_number_pronunciation_invalid"), true);
  project.narrationSegments![0].providerSynthesisText = "九零后奶爸平均每分钟算力成本两千元。";
  assert.equal(ttsConventionIssues(project).some((issue) => issue.code === "tts_contextual_number_pronunciation_invalid"), false);
});

test("audio gate rejects a pronunciation plan compiled from stale display text", () => {
  const project = {
    meta: { title: "更新后的标题", createdAt: "2026-07-30T00:00:00.000Z", width: 1080, height: 1920, fps: 30, durationSeconds: 5, sourceCount: 1 },
    narration: "更新后的标题。",
    narrationSegments: [{
      sceneIndex: 0,
      text: "更新后的标题。",
      pronunciationPlan: { displayText: "旧标题。", semanticText: "旧标题。", synthesisText: "旧标题。", spans: [], planHash: "stale", frontendVersion: "test" },
    }],
    scenes: [{ type: "title" as const, duration: 5, kicker: "fixture", headline: "更新后的标题", subhead: "fixture", sources: ["fixture"] }],
    sources: [],
  } satisfies VideoProject;

  assert.equal(ttsConventionIssues(project).some((issue) => issue.code === "tts_derived_text_stale"), true);
});

test("local provider gate rejects spaced or Chinese-homophone AI and accepts glossary spelling", () => {
  const project = {
    meta: { title: "AI-For-Beginners", createdAt: "2026-07-30T00:00:00.000Z", width: 1080, height: 1920, fps: 30, durationSeconds: 5, sourceCount: 1 },
    narration: "AI-For-Beginners 是人工智能入门课程。",
    narrationSegments: [{ sceneIndex: 0, text: "AI-For-Beginners 是人工智能入门课程。", providerSynthesisText: "A I For Beginners 是人工智能入门课程。", ttsProvider: "indextts" }],
    scenes: [{ type: "title" as const, duration: 5, kicker: "fixture", headline: "AI-For-Beginners", subhead: "fixture", sources: ["fixture"] }],
    sources: [],
  } satisfies VideoProject;

  assert.equal(ttsConventionIssues(project).some((issue) => issue.code === "audio_acronym_plan_unprotected"), true);
  project.narrationSegments![0].providerSynthesisText = "诶艾 For Beginners 是人工智能入门课程。";
  assert.equal(ttsConventionIssues(project).some((issue) => issue.code === "audio_acronym_plan_unprotected"), true);
  project.narrationSegments![0].providerSynthesisText = "A-I For Beginners 是人工智能入门课程。";
  assert.equal(ttsConventionIssues(project).some((issue) => issue.code === "audio_acronym_plan_unprotected"), false);
});
