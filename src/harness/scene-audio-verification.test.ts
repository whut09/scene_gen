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

test("scene ASR checks entities and numbers without directly rebuilding TTS", () => {
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
