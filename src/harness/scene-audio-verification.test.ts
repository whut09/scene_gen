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

test("semantic ASR verifies provider fallback text instead of display text", () => {
  const project = projectFixture();
  project.narrationSegments![1].providerSynthesisText = "系统完成核心模块重新构建并输出结果。";
  const result = verifySceneTranscripts(project, [
    { sceneIndex: 0, text: project.narrationSegments![0].text, confidence: 0.95 },
    { sceneIndex: 1, text: "系统完成核心模块重新构建并输出结果。", confidence: 0.95 },
    { sceneIndex: 2, text: project.narrationSegments![2].text, confidence: 0.95 },
  ]);
  assert.equal(result.issues.some((item) => item.sceneIndex === 1 && item.code === "audio_semantic_mismatch"), false);
});

test("semantic ASR ignores provider-only phoneme tokens when tts text is available", () => {
  const project = projectFixture();
  project.narrationSegments![1].ttsText = "系统完成核心模块重构并输出结果。";
  project.narrationSegments![1].providerSynthesisText = "系统完成核心模块CHONG2GOU4并输出结果。";
  const result = verifySceneTranscripts(project, [
    { sceneIndex: 0, text: project.narrationSegments![0].text, confidence: 0.95 },
    { sceneIndex: 1, text: "系统完成核心模块重构并输出结果。", confidence: 0.95 },
    { sceneIndex: 2, text: project.narrationSegments![2].text, confidence: 0.95 },
  ]);
  assert.equal(result.issues.some((item) => item.sceneIndex === 1 && item.code === "audio_entity_mismatch"), false);
  assert.equal(result.issues.some((item) => item.sceneIndex === 1 && item.code === "audio_semantic_mismatch"), false);
});

test("semantic ASR accepts equivalent Mandarin number and homophone transcriptions", () => {
  const project = projectFixture();
  project.narrationSegments![0].text = "首个全国产十万卡AI超集群投用。新闻日期二零二六年八月九日。";
  project.narrationSegments![1].text = "峰值能力相当于全人类持续计算二百年。";
  project.narrationSegments![2].text = "超过六成算力已经纳入统一监测。";
  project.narrationSegments![2].claimIds = [];
  const result = verifySceneTranscripts(project, [
    { sceneIndex: 0, text: "首个全国产十万卡AI超级群投用。新文日期二零二六年八月九日。", confidence: 0.95 },
    { sceneIndex: 1, text: "峰值能力相当于全人类持续计算两百年。", confidence: 0.95 },
    { sceneIndex: 2, text: "超过六成算力已经纳入统一监测。", confidence: 0.95 },
  ]);

  assert.equal(result.issues.some((item) => item.code === "audio_number_mismatch" || item.code === "audio_semantic_mismatch"), false);
});

test("semantic ASR accepts the homophone transcription for result review", () => {
  const project = projectFixture();
  project.narrationSegments![2].text = "安全、治理和结果复核不能交给AI。";
  project.narrationSegments![2].claimIds = [];
  const result = verifySceneTranscripts(project, [
    { sceneIndex: 0, text: project.narrationSegments![0].text, confidence: 0.95 },
    { sceneIndex: 1, text: project.narrationSegments![1].text, confidence: 0.95 },
    { sceneIndex: 2, text: "安全、治理和结果符合不能交给AI。", confidence: 0.95 },
  ]);

  assert.equal(result.issues.some((item) => item.sceneIndex === 2 && item.code === "audio_semantic_mismatch"), false);
});

test("semantic ASR accepts the traditional homophone transcription for result review", () => {
  const project = projectFixture();
  project.narrationSegments![2].text = "安全、治理和结果复核不能交给AI。";
  project.narrationSegments![2].claimIds = [];
  const result = verifySceneTranscripts(project, [
    { sceneIndex: 0, text: project.narrationSegments![0].text, confidence: 0.95 },
    { sceneIndex: 1, text: project.narrationSegments![1].text, confidence: 0.95 },
    { sceneIndex: 2, text: "安全、治理和結果符合不能交給AI。", confidence: 0.95 },
  ]);

  assert.equal(result.issues.some((item) => item.sceneIndex === 2 && item.code === "audio_semantic_mismatch"), false);
});

test("AI entity verification rejects expansion to the Mandarin semantic form", () => {
  const project = projectFixture();
  project.narrationSegments![2].text = "AI 系统完成验证。";
  project.narrationSegments![2].claimIds = [];
  const result = verifySceneTranscripts(project, [
    { sceneIndex: 0, text: project.narrationSegments![0].text, confidence: 0.95 },
    { sceneIndex: 1, text: project.narrationSegments![1].text, confidence: 0.95 },
    { sceneIndex: 2, text: "人工智能系统完成验证。", confidence: 0.95 },
  ]);
  assert.equal(result.issues.some((item) => item.code === "audio_entity_mismatch" && item.sceneIndex === 2), true);
});

test("AI acronym verification rejects the Chinese homophone", () => {
  const project = projectFixture();
  project.narrationSegments![0].text = "AI 正在改变开发流程。";
  project.narrationSegments![0].ttsText = "AI 正在改变开发流程。";
  const result = verifySceneTranscripts(project, [
    { sceneIndex: 0, text: "爱正在改变开发流程。", confidence: 0.95 },
    { sceneIndex: 1, text: project.narrationSegments![1].text, confidence: 0.95 },
    { sceneIndex: 2, text: project.narrationSegments![2].text, confidence: 0.95 },
  ]);
  assert.ok(result.issues.some((item) => item.code === "audio_entity_mismatch" && item.sceneIndex === 0));
});

test("AI acronym verification is inconclusive when ASR confidence is below the semantic threshold", () => {
  const project = projectFixture();
  project.narrationSegments![0].text = "AI 正在改变开发流程。";
  project.narrationSegments![0].ttsText = "AI 正在改变开发流程。";
  const result = verifySceneTranscripts(project, [
    { sceneIndex: 0, text: "爱正在改变开发流程。", confidence: 0.72 },
    { sceneIndex: 1, text: project.narrationSegments![1].text, confidence: 0.95 },
    { sceneIndex: 2, text: project.narrationSegments![2].text, confidence: 0.95 },
  ]);
  assert.equal(result.issues.some((item) => item.code === "audio_entity_mismatch" && item.sceneIndex === 0), false);
  assert.ok(result.issues.some((item) => item.code === "verification_inconclusive" && item.sceneIndex === 0));
});

test("AI acronym verification accepts a spelled letter transcript", () => {
  const project = projectFixture();
  project.narrationSegments![0].text = "AI 正在改变开发流程。";
  project.narrationSegments![0].ttsText = "AI 正在改变开发流程。";
  const result = verifySceneTranscripts(project, [
    { sceneIndex: 0, text: "A I 正在改变开发流程。", confidence: 0.95 },
    { sceneIndex: 1, text: project.narrationSegments![1].text, confidence: 0.95 },
    { sceneIndex: 2, text: project.narrationSegments![2].text, confidence: 0.95 },
  ]);
  assert.equal(result.issues.some((item) => item.code === "audio_entity_mismatch" && item.sceneIndex === 0), false);
});

test("IndexTTS acronym gate rejects separated letters and accepts glossary spelling", () => {
  const project = projectFixture();
  project.narrationSegments![0] = {
    ...project.narrationSegments![0], text: "AI 正在改变开发流程。", ttsText: "AI 正在改变开发流程。",
    providerSynthesisText: "A、I，正在改变开发流程。", providerSynthesisChunks: ["A、I，正在改变开发流程。"], ttsProvider: "indextts",
  };
  const transcripts = [
    { sceneIndex: 0, text: "A I 正在改变开发流程。", confidence: 0.95 },
    { sceneIndex: 1, text: project.narrationSegments![1].text, confidence: 0.95 },
    { sceneIndex: 2, text: project.narrationSegments![2].text, confidence: 0.95 },
  ];
  assert.ok(verifySceneTranscripts(project, transcripts).issues.some((item) => item.code === "audio_acronym_plan_unprotected" && item.sceneIndex === 0));

  project.narrationSegments![0].providerSynthesisText = "A-I正在改变开发流程。";
  project.narrationSegments![0].providerSynthesisChunks = ["A-I正在改变开发流程。"];
  assert.equal(verifySceneTranscripts(project, transcripts).issues.some((item) => item.code === "audio_acronym_plan_unprotected" && item.sceneIndex === 0), false);
});

test("AGI acronym verification rejects the entire acronym collapsing to a homophone", () => {
  const project = projectFixture();
  project.narrationSegments![0].text = "AGI 加速窗口已经到来。";
  project.narrationSegments![0].ttsText = "AGI 加速窗口已经到来。";
  const result = verifySceneTranscripts(project, [
    { sceneIndex: 0, text: "爱加速窗口已经到来。", confidence: 0.9 },
    { sceneIndex: 1, text: project.narrationSegments![1].text, confidence: 0.95 },
    { sceneIndex: 2, text: project.narrationSegments![2].text, confidence: 0.95 },
  ]);
  assert.ok(result.issues.some((item) => item.code === "audio_entity_mismatch" && item.sceneIndex === 0));
});

test("AGI acronym verification accepts ASR writing the spoken letter I as its homophone", () => {
  const project = projectFixture();
  project.narrationSegments![0].text = "AGI 加速窗口已经到来。";
  project.narrationSegments![0].ttsText = "AGI 加速窗口已经到来。";
  const result = verifySceneTranscripts(project, [
    { sceneIndex: 0, text: "AG爱加速窗口已经到来。", confidence: 0.9 },
    { sceneIndex: 1, text: project.narrationSegments![1].text, confidence: 0.95 },
    { sceneIndex: 2, text: project.narrationSegments![2].text, confidence: 0.95 },
  ]);
  assert.equal(result.issues.some((item) => item.code === "audio_entity_mismatch" && item.sceneIndex === 0), false);
});

test("AGI acronym verification accepts all three ASCII letters", () => {
  const project = projectFixture();
  project.narrationSegments![0].text = "AGI 加速窗口已经到来。";
  project.narrationSegments![0].ttsText = "AGI 加速窗口已经到来。";
  const result = verifySceneTranscripts(project, [
    { sceneIndex: 0, text: "A G I 加速窗口已经到来。", confidence: 0.9 },
    { sceneIndex: 1, text: project.narrationSegments![1].text, confidence: 0.95 },
    { sceneIndex: 2, text: project.narrationSegments![2].text, confidence: 0.95 },
  ]);
  assert.equal(result.issues.some((item) => item.code === "audio_entity_mismatch" && item.sceneIndex === 0), false);
});

test("scene ASR blocks a confident first-word omission", () => {
  const project = projectFixture();
  project.meta.title = "AI 圈又在造新词";
  project.narrationSegments![0].text = "AI 圈又在造新词，系统进入验证阶段。";
  const result = verifySceneTranscripts(project, [
    { sceneIndex: 0, text: "圈又在造新词，系统进入验证阶段。", confidence: 0.9 },
    { sceneIndex: 1, text: project.narrationSegments![1].text, confidence: 0.95 },
    { sceneIndex: 2, text: project.narrationSegments![2].text, confidence: 0.95 },
  ]);
  assert.ok(result.issues.some((item) => item.code === "audio_opening_mismatch" && item.sceneIndex === 0));
});

test("low-confidence opening disagreement remains inconclusive", () => {
  const project = projectFixture();
  project.meta.title = "AI 正在创造新词";
  project.narrationSegments![0].text = "AI 正在创造新词，系统进入验证阶段。";
  const result = verifySceneTranscripts(project, [
    { sceneIndex: 0, text: "正在创造新词，系统进入验证阶段。", confidence: 0.72 },
    { sceneIndex: 1, text: project.narrationSegments![1].text, confidence: 0.95 },
    { sceneIndex: 2, text: project.narrationSegments![2].text, confidence: 0.95 },
  ], { minimumConfidence: 0.8 });
  assert.ok(result.issues.some((item) => item.code === "verification_inconclusive" && item.sceneIndex === 0));
  assert.equal(result.issues.some((item) => item.code === "audio_opening_mismatch" && item.sceneIndex === 0), false);
});

test("opening disagreement below the semantic confidence threshold remains inconclusive", () => {
  const project = projectFixture();
  project.meta.title = "奥特曼马斯克豪言我们已进入奇点";
  project.narrationSegments![0].text = "奥特曼马斯克豪言我们已进入奇点，系统进入验证阶段。";
  const result = verifySceneTranscripts(project, [
    { sceneIndex: 0, text: "欧特曼马斯克豪演我们以进入其点，系统进入验证阶段。", confidence: 0.7 },
    { sceneIndex: 1, text: project.narrationSegments![1].text, confidence: 0.95 },
    { sceneIndex: 2, text: project.narrationSegments![2].text, confidence: 0.95 },
  ]);
  assert.ok(result.issues.some((item) => item.code === "verification_inconclusive" && item.sceneIndex === 0));
  assert.equal(result.issues.some((item) => item.code === "audio_opening_mismatch" && item.sceneIndex === 0), false);
});

test("mixed Chinese and English titles use the Chinese opening anchor", () => {
  const project = projectFixture();
  project.meta.title = "字节发布 Seed Audio 1.0";
  project.narrationSegments![0].text = "字节发布 Seed Audio 1.0 音频创作模型。";
  const result = verifySceneTranscripts(project, [
    { sceneIndex: 0, text: "字节发布 C 刀柳一点零音频创作模型。", confidence: 0.82 },
    { sceneIndex: 1, text: project.narrationSegments![1].text, confidence: 0.95 },
    { sceneIndex: 2, text: project.narrationSegments![2].text, confidence: 0.95 },
  ]);
  assert.equal(result.issues.some((item) => item.code === "audio_opening_mismatch" && item.sceneIndex === 0), false);
});

test("timed Mandarin transliteration proves an English-only project title was spoken", () => {
  const project = projectFixture();
  project.meta.title = "WeKnora";
  project.narrationSegments![0].text = "WeKnora，开源项目推荐。它把团队资料变成可检索问答。";
  const result = verifySceneTranscripts(project, [
    {
      sceneIndex: 0,
      text: "为诺尔，开源项目推荐。它把团队资料变成可检索问答。",
      confidence: 0.85,
      detectedLanguage: "zh",
      languageConfidence: 0.99,
      words: [
        { text: "为诺尔", startSeconds: 0, endSeconds: 0.8, confidence: 0.85 },
        { text: "开源项目推荐", startSeconds: 0.8, endSeconds: 1.6, confidence: 0.85 },
      ],
    },
    { sceneIndex: 1, text: project.narrationSegments![1].text, confidence: 0.95 },
    { sceneIndex: 2, text: project.narrationSegments![2].text, confidence: 0.95 },
  ]);
  assert.equal(result.issues.some((item) => item.code === "audio_opening_mismatch" && item.sceneIndex === 0), false);
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

test("moderate confidence ASR does not masquerade as a semantic TTS failure", () => {
  const project = projectFixture();
  const result = verifySceneTranscripts(project, project.narrationSegments!.map((segment) => ({
    sceneIndex: segment.sceneIndex,
    text: "不可靠的转写结果",
    confidence: 0.79,
    detectedLanguage: "zh",
    languageConfidence: 0.99,
  })));

  assert.equal(result.issues.some((item) => item.code === "audio_semantic_mismatch"), false);
  assert.ok(result.issues.some((item) => item.code === "verification_inconclusive"));
});

test("near-threshold semantic ASR remains inconclusive", () => {
  const project = projectFixture();
  const result = verifySceneTranscripts(project, project.narrationSegments!.map((segment) => ({
    sceneIndex: segment.sceneIndex,
    text: segment.text.slice(0, Math.floor(segment.text.length * 0.76)),
    confidence: 0.84,
    detectedLanguage: "zh",
    languageConfidence: 0.99,
  })));
  assert.equal(result.issues.some((item) => item.code === "audio_semantic_mismatch"), false);
  assert.ok(result.issues.some((item) => item.code === "verification_inconclusive"));
});

test("traditional Chinese ASR transcript matches simplified narration", () => {
  const project = projectFixture();
  project.narrationSegments![1].text = "相当于全人类持续计算二百年，现在支持新材料、创新药等领域的计算任务。";
  const result = verifySceneTranscripts(project, [
    { sceneIndex: 0, text: project.narrationSegments![0].text, confidence: 0.95 },
    { sceneIndex: 1, text: "相當於全人類持續計算二百年，現在支持新材料、創新藥等領域的計算任務。", confidence: 0.95 },
    { sceneIndex: 2, text: project.narrationSegments![2].text, confidence: 0.95 },
  ]);

  assert.equal(result.issues.some((item) => item.sceneIndex === 1 && item.code === "audio_semantic_mismatch"), false);
});

test("traditional and near-homophone ASR output does not reject complete access-control narration", () => {
  const project = projectFixture();
  project.narrationSegments![2].text = "身份服务一旦停机，可能影响所有接入系统。上线前必须准备备份、高可用、管理员恢复和升级回滚方案，并先从低风险应用迁移。";
  const result = verifySceneTranscripts(project, [
    { sceneIndex: 0, text: project.narrationSegments![0].text, confidence: 0.95 },
    { sceneIndex: 1, text: project.narrationSegments![1].text, confidence: 0.95 },
    { sceneIndex: 2, text: "身份服務一旦停機，可能影響所有接入系統。上線前必須準備備份、高可用、管理員恢復和升級毀滾方案，並先從低風險應用簽移。", confidence: 0.95 },
  ]);

  assert.equal(result.issues.some((item) => item.sceneIndex === 2 && item.code === "audio_semantic_mismatch"), false);
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


test("scene ASR blocks unexpected synthesized prefixes and repeated phrases", () => {
  const project = projectFixture();
  project.narrationSegments = [{ sceneIndex: 0, text: "给人工智能发工号并纳入组织流程" }];
  project.meta.title = "给人工智能发工号";
  const result = verifySceneTranscripts(project, [{ sceneIndex: 0, text: "两给人工智能发工号号号并纳入组织流程", confidence: 0.92, detectedLanguage: "zh", languageConfidence: 0.99 }], { expectedLanguage: "zh", minimumConfidence: 0.65 });
  assert.ok(result.issues.some((item) => item.code === "audio_scene_opening_artifact"));
  assert.ok(result.issues.some((item) => item.code === "audio_repeated_phrase"));
});

test("scene ASR blocks a Latin product token repeated twice", () => {
  const project = projectFixture();
  project.narrationSegments = [{ sceneIndex: 0, text: "GPT-5.6 Sol 获得回答质量升级。" }];
  project.meta.title = "GPT-5.6 Sol 升级";
  const result = verifySceneTranscripts(project, [{
    sceneIndex: 0,
    text: "GPT-5.6 Sol Sol 获得回答质量升级。",
    confidence: 0.95,
    detectedLanguage: "zh",
    languageConfidence: 0.99,
  }], { expectedLanguage: "zh", minimumConfidence: 0.84 });
  assert.ok(result.issues.some((item) => item.code === "audio_repeated_phrase"));
});

test("scene ASR blocks a repository homepage title spoken twice", () => {
  const project = projectFixture();
  const title = "今日开源热点趋势项目推荐图表设计让智能体生成专业技术图表";
  project.meta.title = "diagram-design";
  project.narrationSegments = [{ sceneIndex: 0, text: `${title}它能快速生成品牌风格图表` }];
  const result = verifySceneTranscripts(project, [{
    sceneIndex: 0,
    text: `${title}${title}它能快速生成品牌风格图表`,
    confidence: 0.83,
    detectedLanguage: "zh",
    languageConfidence: 0.99,
  }], { expectedLanguage: "zh", minimumConfidence: 0.65 });
  assert.ok(result.issues.some((item) => item.code === "audio_repeated_phrase"));
});

test("scene ASR blocks short residual narration after an otherwise complete scene", () => {
  const project = projectFixture();
  project.narrationSegments = [{ sceneIndex: 0, text: "系统完成核心模块重构并输出结果" }];
  project.meta.title = "核心模块重构";
  const result = verifySceneTranscripts(project, [{
    sceneIndex: 0,
    text: "系统完成核心模块重构并输出结果吃",
    confidence: 0.95,
    detectedLanguage: "zh",
    languageConfidence: 0.99,
  }], { expectedLanguage: "zh", minimumConfidence: 0.84 });
  assert.ok(result.issues.some((item) => item.code === "audio_scene_boundary_artifact"));
});

test("scene ASR does not treat repeated year digits as repeated narration", () => {
  const project = projectFixture();
  project.narrationSegments = [{ sceneIndex: 0, text: "1999年提出数学猜想" }];
  project.meta.title = "数学猜想";
  const result = verifySceneTranscripts(project, [{
    sceneIndex: 0,
    text: "1999年提出数学猜想",
    confidence: 0.95,
    detectedLanguage: "zh",
    languageConfidence: 0.99,
  }], { expectedLanguage: "zh", minimumConfidence: 0.84 });
  assert.equal(result.issues.some((item) => item.code === "audio_repeated_phrase"), false);
});

test("scene ASR does not hard fail repeated phrases below the confidence threshold", () => {
  const project = projectFixture();
  project.narrationSegments = [{ sceneIndex: 0, text: "系统完成核心模块重构" }];
  project.meta.title = "核心模块重构";
  const result = verifySceneTranscripts(project, [{
    sceneIndex: 0,
    text: "系统系统系统完成核心模块重构",
    confidence: 0.73,
    detectedLanguage: "zh",
    languageConfidence: 0.99,
  }], { expectedLanguage: "zh", minimumConfidence: 0.84 });
  assert.equal(result.issues.some((item) => item.code === "audio_repeated_phrase"), false);
  assert.ok(result.issues.some((item) => item.code === "verification_inconclusive"));
});
