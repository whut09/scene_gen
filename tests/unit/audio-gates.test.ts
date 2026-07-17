import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRuntimeConfig } from "../../src/config/runtime-config";
import { compilePronunciationPlan } from "../../src/pipeline/pronunciation/compiler";
import type { VideoProject } from "../../src/pipeline/types";
import { dirtyPlanFromIssues } from "../../src/harness/dirty-plan";
import { normalizeQualityIssue } from "../../src/harness/quality-protocol";
import { runAudioPronunciationGate } from "../../src/harness/quality/audio-pronunciation-gate";
import { runAudioSemanticGate, transcribeScenesCached } from "../../src/harness/quality/audio-semantic-gate";
import { runAudioStructuralGate } from "../../src/harness/quality/audio-structural-gate";
import { evaluateAudio } from "../../src/harness/quality/audio-rules";

function wavBuffer(durationSeconds = 2, sampleRate = 16_000) {
  const samples = Math.max(1, Math.floor(durationSeconds * sampleRate));
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + dataSize, 4); buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

async function fixture(root: string, options: { riskOnSecond?: boolean } = {}) {
  const audioPath = path.join(root, "narration.wav");
  await writeFile(audioPath, wavBuffer(4));
  const first = await compilePronunciationPlan({ displayText: "这是普通开场" });
  const second = await compilePronunciationPlan({ displayText: options.riskOnSecond === false ? "这是普通内容" : "系统完成重构" });
  const texts = [first.plan.displayText, second.plan.displayText];
  const project: VideoProject = {
    meta: { title: "这是普通开场", createdAt: "2026-07-17T00:00:00.000Z", width: 1080, height: 1920, fps: 30, durationSeconds: 4, sourceCount: 1 },
    narration: texts.join("\n"),
    narrationSegments: [first.plan, second.plan].map((plan, sceneIndex) => ({ sceneIndex, text: plan.displayText, audioStartSeconds: sceneIndex * 2, durationSeconds: 2, pronunciationPlan: plan })),
    audio: { src: audioPath, durationSeconds: 4, provider: "azure" },
    scenes: texts.map((text) => ({ type: "title" as const, duration: 2, kicker: "测试", headline: text, subhead: "音频门", sources: ["fixture"] })),
    sources: [{ id: "fixture", kind: "webpage", title: "fixture", url: "https://example.com", source: "fixture", summary: "fixture", content: "fixture", score: 1, tags: [] }],
  };
  return { project, audioPath };
}

function config(root: string, overrides: NodeJS.ProcessEnv = {}) {
  return buildRuntimeConfig({ ...process.env, SCENE_GEN_CACHE_DIR: path.join(root, "cache"), ASR_PROVIDER: "mock", PRONUNCIATION_VERIFIER_PROVIDER: "mock", PRONUNCIATION_VERIFIER_CONFIDENCE_MIN: "0.7", QUALITY_MIN_DURATION_FACTOR: "0.5", QUALITY_MAX_DURATION_FACTOR: "2", ...overrides }, "test");
}

const goodProbe = async () => ({ readable: true, durationSeconds: 4, sampleRate: 16_000, channels: 1, silenceRatio: 0.05, peakDb: -3 });

test("semantic ASR transcript text never proves or disproves polyphone pronunciation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scene-gen-audio-semantic-"));
  try {
    const { project } = await fixture(root);
    const result = await runAudioSemanticGate({ project, config: config(root), provider: "mock", transcribe: async () => [
      { sceneIndex: 0, text: project.narrationSegments![0].text, confidence: 0.95 },
      { sceneIndex: 1, text: "系统完成重构", confidence: 0.95 },
    ] });
    assert.equal(result.issues.some((issue) => issue.code === "audio_pronunciation_mismatch"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pronunciation gate mismatches zhong4 and passes chong2 with acoustic evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scene-gen-audio-pronunciation-"));
  try {
    const first = await fixture(root);
    const mismatch = await runAudioPronunciationGate({ project: first.project, config: config(root), verify: async () => ({ status: "verified", actualPinyin: ["zhong 4", "gou 4"], phonemeCandidates: ["zhong 4:95", "gou 4:96"], startMs: 100, endMs: 800, confidence: 0.94, verifier: "mock-phoneme" }) });
    const issue = mismatch.issues.find((item) => item.code === "audio_pronunciation_mismatch");
    assert.equal(issue?.sceneIndex, 1);
    assert.equal(issue?.evidence?.actualPinyin, "zhong 4 gou 4");
    assert.equal(typeof issue?.evidence?.pronunciationPlanHash, "string");

    const secondRoot = await mkdtemp(path.join(tmpdir(), "scene-gen-audio-pronunciation-pass-"));
    try {
      const second = await fixture(secondRoot);
      const passed = await runAudioPronunciationGate({ project: second.project, config: config(secondRoot), verify: async () => ({ status: "verified", actualPinyin: ["chong 2", "gou 4"], startMs: 100, endMs: 800, confidence: 0.96, verifier: "mock-phoneme" }) });
      assert.equal(passed.issues.length, 0);
    } finally { await rm(secondRoot, { recursive: true, force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("low confidence or missing acoustic evidence is inconclusive and never dirties TTS", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scene-gen-audio-inconclusive-"));
  try {
    const { project } = await fixture(root);
    const result = await runAudioPronunciationGate({ project, config: config(root), verify: async () => ({ status: "verified", actualPinyin: ["zhong 4", "gou 4"], confidence: 0.3, verifier: "mock-phoneme" }) });
    assert.deepEqual(result.issues.map((issue) => issue.code), ["verification_inconclusive"]);
    const dirty = dirtyPlanFromIssues(result.issues.map((issue) => normalizeQualityIssue("audio", issue)), 2);
    assert.deepEqual(dirty.audioSceneIndexes, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ASR cache runs the provider once for the same audio identity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scene-gen-asr-cache-"));
  try {
    const { project } = await fixture(root);
    let calls = 0;
    const transcribe = async () => { calls += 1; return [{ sceneIndex: 0, text: "这是普通开场", confidence: 0.9 }, { sceneIndex: 1, text: "系统完成重构", confidence: 0.9 }]; };
    await transcribeScenesCached({ project, config: config(root), provider: "mock", transcribe });
    await transcribeScenesCached({ project, config: config(root), provider: "mock", transcribe });
    assert.equal(calls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pronunciation verifier only checks risky scenes and failure does not trigger TTS", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scene-gen-risk-scenes-"));
  try {
    const { project } = await fixture(root);
    const calls: number[] = [];
    const result = await runAudioPronunciationGate({ project, config: config(root), verify: async ({ sceneIndex }) => { calls.push(sceneIndex); return { status: "inconclusive", confidence: 0, verifier: "mock-phoneme", reason: "verifier_failed" }; } });
    assert.deepEqual(calls, [1]);
    assert.deepEqual(result.issues.map((issue) => issue.code), ["verification_inconclusive"]);
    const dirty = dirtyPlanFromIssues(result.issues.map((issue) => normalizeQualityIssue("audio", issue)), 2);
    assert.deepEqual(dirty.audioSceneIndexes, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("structural failure short-circuits ASR and pronunciation verification", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scene-gen-structural-short-circuit-"));
  try {
    const { project } = await fixture(root);
    let asrCalls = 0;
    let pronunciationCalls = 0;
    const evaluation = await evaluateAudio(project, 4, undefined, config(root), {
      structuralProbe: async () => ({ readable: false, durationSeconds: 0, sampleRate: 0, channels: 0 }),
      transcribe: async () => { asrCalls += 1; return []; },
      pronunciationVerify: async () => { pronunciationCalls += 1; return { status: "inconclusive", confidence: 0, verifier: "mock" }; },
    });
    assert.equal(asrCalls, 0);
    assert.equal(pronunciationCalls, 0);
    assert.ok(evaluation.issues.some((issue) => issue.code === "audio_missing"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("semantic failure remains semantic and does not masquerade as pronunciation failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scene-gen-semantic-separation-"));
  try {
    const { project } = await fixture(root);
    const evaluation = await evaluateAudio(project, 4, undefined, config(root), {
      structuralProbe: goodProbe,
      transcribe: async () => [{ sceneIndex: 0, text: "错误内容", confidence: 0.95 }, { sceneIndex: 1, text: "完全无关", confidence: 0.95 }],
      pronunciationVerify: async () => ({ status: "verified", actualPinyin: ["chong 2", "gou 4"], startMs: 0, endMs: 600, confidence: 0.95, verifier: "mock" }),
    });
    assert.ok(evaluation.issues.some((issue) => issue.code === "audio_semantic_mismatch"));
    assert.equal(evaluation.issues.some((issue) => issue.code === "audio_pronunciation_mismatch"), false);
    const semantic = evaluation.issues.find((issue) => issue.code === "audio_semantic_mismatch");
    assert.equal(semantic?.repairAction, "retry-stage");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("structural gate checks sample rate, channels, silence, clipping and timeline", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scene-gen-structural-rules-"));
  try {
    const { project } = await fixture(root);
    project.narrationSegments![1].audioStartSeconds = 3;
    const result = await runAudioStructuralGate({ project, targetSeconds: 4, config: config(root), probe: async () => ({ readable: true, durationSeconds: 4, sampleRate: 8_000, channels: 2, silenceRatio: 0.99, peakDb: 0 }) });
    assert.ok(["audio_format_invalid", "audio_silence_excessive", "audio_clipping", "audio_scene_drift"].every((code) => result.issues.some((issue) => issue.code === code)));
  } finally { await rm(root, { recursive: true, force: true }); }
});
