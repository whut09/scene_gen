import assert from "node:assert/strict";
import test from "node:test";
import type { VideoProject } from "../pipeline/types";
import { dirtyPlanFromIssues } from "./dirty-plan";
import { normalizeQualityIssue } from "./quality-protocol";
import { verifySceneTranscripts } from "./scene-audio-verification";

function projectFixture(): VideoProject {
  const narrationSegments = [
    "新版本正式发布，系统进入验证阶段。",
    "系统完成核心模块重构并输出结果。",
    "OpenAI 发布 v2.1，准确率提升 42%。",
  ].map((text, sceneIndex) => ({ sceneIndex, text, audioStartSeconds: sceneIndex * 5, durationSeconds: 5, claimIds: sceneIndex === 2 ? ["claim-openai"] : [] }));
  return {
    meta: { title: "新版本正式发布", createdAt: "2026-07-15T00:00:00.000Z", width: 1080, height: 1920, fps: 30, durationSeconds: 15, sourceCount: 1 },
    narration: narrationSegments.map((segment) => segment.text).join("\n"),
    narrationSegments,
    factLedger: { version: 1, claims: [{ id: "claim-openai", subject: "OpenAI", predicate: "发布", value: "v2.1", qualifiers: [], sourceId: "source", evidenceText: "OpenAI 发布 v2.1，准确率提升 42%。", confidence: 1 }] },
    scenes: narrationSegments.map((segment, index) => ({ type: "title" as const, duration: 5, kicker: `场景 ${index + 1}`, headline: segment.text, subhead: "逐场景语音验证", sources: ["fixture"] })),
    sources: [{ id: "source", kind: "webpage", title: "fixture", url: "https://example.com", source: "fixture", summary: "fixture", content: "fixture", score: 1, tags: [] }],
  };
}

test("scene ASR never infers pronunciation from Chinese transcript text", () => {
  const project = projectFixture();
  const result = verifySceneTranscripts(project, [
    { sceneIndex: 0, text: project.narrationSegments![0].text, confidence: 0.95 },
    { sceneIndex: 1, text: project.narrationSegments![1].text, confidence: 0.91 },
    { sceneIndex: 2, text: project.narrationSegments![2].text, confidence: 0.95 },
  ]);
  assert.equal(result.issues.some((item) => item.code === "audio_pronunciation_mismatch"), false);
});
test("low confidence ASR is inconclusive and does not rebuild audio", () => {
  const project = projectFixture();
  const result = verifySceneTranscripts(project, [
    { sceneIndex: 0, text: project.narrationSegments![0].text, confidence: 0.95 },
    { sceneIndex: 1, text: "完全错误的内容", confidence: 0.3 },
    { sceneIndex: 2, text: project.narrationSegments![2].text, confidence: 0.95 },
  ]);
  const sceneIssues = result.issues.filter((item) => item.sceneIndex === 1);
  assert.deepEqual(sceneIssues.map((item) => item.code), ["verification_inconclusive"]);
  const normalized = sceneIssues.map((item) => normalizeQualityIssue("audio", item));
  assert.deepEqual(dirtyPlanFromIssues(normalized, 3).audioSceneIndexes, []);
});

test("explicit production confidence threshold overrides a lower environment value", () => {
  const project = projectFixture();
  const result = verifySceneTranscripts(project, project.narrationSegments!.map((segment) => ({ sceneIndex: segment.sceneIndex, text: segment.text, confidence: 0.78 })), { minimumConfidence: 0.8 });
  assert.equal(result.issues.every((item) => item.code === "verification_inconclusive"), true);
});

test("high-confidence ASR disagreement retries verification without dirtying TTS", () => {
  const project = projectFixture();
  const result = verifySceneTranscripts(project, [
    { sceneIndex: 0, text: project.narrationSegments![0].text, confidence: 0.95 },
    { sceneIndex: 1, text: project.narrationSegments![1].text, confidence: 0.95 },
    { sceneIndex: 2, text: "OpenEye 发布 v2.2，准确率提升 40%。", confidence: 0.92 },
  ]);
  assert.ok(result.issues.some((item) => item.code === "audio_entity_mismatch" && item.sceneIndex === 2));
  assert.ok(result.issues.some((item) => item.code === "audio_number_mismatch" && item.sceneIndex === 2));
  const normalized = result.issues.map((item) => normalizeQualityIssue("audio", item));
  const dirtyPlan = dirtyPlanFromIssues(normalized, 3);
  assert.deepEqual(dirtyPlan.audioSceneIndexes, []);
  assert.equal(dirtyPlan.concatAudio, false);
  assert.equal(dirtyPlan.remux, false);
  assert.equal(result.issues.filter((item) => item.sceneIndex === 2).every((item) => item.repairAction === "retry-stage"), true);
});

test("extra ASR numbers do not fail when all expected numbers are present", () => {
  const project = projectFixture();
  const result = verifySceneTranscripts(project, [
    { sceneIndex: 0, text: `${project.narrationSegments![0].text} 第一屏`, confidence: 0.95 },
    { sceneIndex: 1, text: project.narrationSegments![1].text, confidence: 0.95 },
    { sceneIndex: 2, text: project.narrationSegments![2].text, confidence: 0.95 },
  ]);
  assert.equal(result.issues.some((item) => item.code === "audio_number_mismatch" && item.sceneIndex === 0), false);
});

test("missing ASR confidence is inconclusive instead of a semantic failure", () => {
  const project = projectFixture();
  const result = verifySceneTranscripts(project, project.narrationSegments!.map((segment) => ({ sceneIndex: segment.sceneIndex, text: segment.text, confidence: null })));
  assert.equal(result.issues.every((item) => item.code === "verification_inconclusive"), true);
});

test("scene ASR detects omitted and inserted narration tokens", () => {
  const project = projectFixture();
  const result = verifySceneTranscripts(project, [
    { sceneIndex: 0, text: project.narrationSegments![0].text, confidence: 0.95 },
    { sceneIndex: 1, text: "系统模块输出额外无关内容。", confidence: 0.93 },
    { sceneIndex: 2, text: project.narrationSegments![2].text, confidence: 0.95 },
  ]);
  const issue = result.issues.find((item) => item.code === "audio_semantic_mismatch" && item.sceneIndex === 1);
  assert.ok(issue);
  assert.equal(typeof issue.evidence?.tokenCoverage, "number");
  assert.equal(typeof issue.evidence?.tokenPrecision, "number");
});

test("scene ASR detects narration leaking from an adjacent scene", () => {
  const project = projectFixture();
  const result = verifySceneTranscripts(project, [
    { sceneIndex: 0, text: project.narrationSegments![0].text, confidence: 0.95 },
    { sceneIndex: 1, text: "系统进入验证阶段。系统完成核心模块重构并输出结果。", confidence: 0.94 },
    { sceneIndex: 2, text: project.narrationSegments![2].text, confidence: 0.95 },
  ]);
  assert.ok(result.issues.some((item) => item.code === "audio_segment_cross_talk" && item.sceneIndex === 1));
});

test("final scene ASR detects a truncated ending even when overall coverage is high", () => {
  const project = projectFixture();
  const finalText = "\u8fd9\u4e00\u5c4f\u5148\u603b\u7ed3\u6570\u636e\u5904\u7406\u3001\u6a21\u578b\u8ba1\u7b97\u3001\u7ed3\u679c\u6821\u9a8c\u548c\u5de5\u7a0b\u5b9e\u73b0\u4e4b\u95f4\u7684\u5173\u7cfb\uff0c\u518d\u8bf4\u660e\u8f93\u5165\u5047\u8bbe\u4f1a\u5982\u4f55\u5f71\u54cd\u8f93\u51fa\uff0c\u6700\u540e\u5f3a\u8c03\u5fc5\u987b\u4fdd\u7559\u5b8c\u6574\u7684\u6700\u7ec8\u7ed3\u8bba\u3002";
  project.narrationSegments![2] = { ...project.narrationSegments![2], text: finalText, claimIds: [] };
  const result = verifySceneTranscripts(project, [
    { sceneIndex: 0, text: project.narrationSegments![0].text, confidence: 0.95 },
    { sceneIndex: 1, text: project.narrationSegments![1].text, confidence: 0.95 },
    { sceneIndex: 2, text: finalText.slice(0, -12), confidence: 0.95 },
  ]);
  const issue = result.issues.find((item) => item.code === "audio_semantic_mismatch" && item.sceneIndex === 2 && typeof item.evidence?.endingRecall === "number");
  assert.ok(issue);
  assert.equal(typeof issue.evidence?.endingRecall, "number");
});
