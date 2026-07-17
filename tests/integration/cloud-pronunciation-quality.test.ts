import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRuntimeConfig, runWithRuntimeConfig } from "../../src/config/runtime-config";
import { dirtyPlanFromIssues } from "../../src/harness/dirty-plan";
import { runAudioPronunciationGate } from "../../src/harness/quality/audio-pronunciation-gate";
import { transcribeScenesCached } from "../../src/harness/quality/audio-semantic-gate";
import { compilePronunciationPlan } from "../../src/pipeline/pronunciation/compiler";
import { azureBillableCharacters, azureTts, readAzureUsage, resetAzureProviderStateForTests } from "../../src/pipeline/tts/providers/azure";
import { PronunciationAttemptLedger, routeTtsProvider } from "../../src/production/tts-routing";
import { cloudPronunciationNarration, createCloudPronunciationProject } from "../fixtures/cloud-pronunciation-project";

function wavBuffer(durationSeconds = 3, sampleRate = 16_000) {
  const samples = Math.max(1, Math.floor(durationSeconds * sampleRate));
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + dataSize, 4); buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write("data", 36); buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

async function mockAzure() {
  const requests: string[] = [];
  let active = 0;
  let peak = 0;
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    active += 1;
    peak = Math.max(peak, active);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(Buffer.concat(chunks).toString("utf8"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    response.statusCode = 200;
    response.setHeader("Content-Type", "audio/wav");
    response.end(wavBuffer(0.12));
    active -= 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock Azure server did not bind.");
  return {
    endpoint: `http://127.0.0.1:${address.port}/cognitiveservices/v1`, requests, peak: () => peak,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function config(cacheRoot: string, endpoint: string, budget = 500_000) {
  return buildRuntimeConfig({
    ...process.env, SCENE_GEN_CACHE_DIR: cacheRoot, SCENE_GEN_PROFILE: "production", TTS_PROVIDER: "azure",
    AZURE_SPEECH_KEY: "mock-key", AZURE_SPEECH_ENDPOINT: endpoint, AZURE_TTS_VOICE: "zh-CN-XiaoxiaoNeural",
    AZURE_TTS_OUTPUT_FORMAT: "riff-24khz-16bit-mono-pcm", AZURE_TTS_MAX_RETRIES: "0", AZURE_TTS_CONCURRENCY: "2",
    AZURE_TTS_REQUESTS_PER_MINUTE: "1000", AZURE_TTS_MONTHLY_CHARACTER_BUDGET: String(budget),
    ASR_PROVIDER: "mock", PRONUNCIATION_VERIFIER_PROVIDER: "mock", PRONUNCIATION_VERIFIER_MIN_AUDIO_MS: "1",
  }, "production");
}

test("cloud pronunciation regression covers cache, repair, verification and quota", { timeout: 120_000, concurrency: false }, async () => {
  resetAzureProviderStateForTests();
  const root = await mkdtemp(path.join(os.tmpdir(), "scene-gen-cloud-pronunciation-"));
  const server = await mockAzure();
  const previous = { ...process.env };
  try {
    const cacheRoot = path.join(root, "cache");
    Object.assign(process.env, { AZURE_SPEECH_KEY: "mock-key", AZURE_SPEECH_ENDPOINT: server.endpoint, AZURE_TTS_MONTHLY_CHARACTER_BUDGET: "500000", SCENE_GEN_CACHE_DIR: cacheRoot, F5_TTS_PYTHON: "python" });
    const runtimeConfig = config(cacheRoot, server.endpoint);
    const project = createCloudPronunciationProject();
    const plans = await Promise.all(cloudPronunciationNarration.map((displayText) => compilePronunciationPlan({ displayText, domain: "software" }).then((result) => result.plan)));
    project.narrationSegments = project.narrationSegments?.map((segment, index) => ({ ...segment, pronunciationPlan: plans[index] }));
    const audioPath = path.join(root, "narration.wav");
    await writeFile(audioPath, wavBuffer());
    project.audio = { src: audioPath, durationSeconds: 3, provider: "azure" };

    const coldStarted = Date.now();
    const cold = await Promise.all(plans.map((plan, sceneIndex) => azureTts({ sceneIndex, displayText: plan.displayText, synthesisText: plan.synthesisText, pronunciationPlan: plan, pronunciationPlanHash: plan.planHash, outputPath: path.join(root, "cold", `${sceneIndex}.wav`) }, runtimeConfig)));
    const coldAudioMs = Date.now() - coldStarted;
    assert.equal(server.requests.length, 5);
    assert.equal(server.peak(), 2);
    assert.equal(plans[2].displayText, "系统完成核心模块重构");
    const reconstructionSsml = server.requests.find((ssml) => ssml.includes(">重构</phoneme>"));
    assert.ok(reconstructionSsml);
    assert.match(reconstructionSsml, /<phoneme[^>]+ph="chong 2 - gou 4"[^>]*>重构<\/phoneme>/);

    const warmStarted = Date.now();
    const beforeWarm = server.requests.length;
    const warm = await Promise.all(plans.map((plan, sceneIndex) => azureTts({ sceneIndex, displayText: plan.displayText, synthesisText: plan.synthesisText, pronunciationPlan: plan, pronunciationPlanHash: plan.planHash, outputPath: path.join(root, "warm", `${sceneIndex}.wav`) }, runtimeConfig)));
    const warmAudioMs = Date.now() - warmStarted;
    assert.equal(server.requests.length - beforeWarm, 0);
    assert.equal(warm.every((item) => item.reused), true);

    let verifierCalls = 0;
    const mismatch = await runAudioPronunciationGate({ project, config: runtimeConfig, verify: async ({ sceneIndex, span }) => {
      verifierCalls += 1;
      const wrong = sceneIndex === 2 && span.phrase === "重构";
      return { status: "verified", actualPinyin: wrong ? ["zhong4", "gou4"] : span.expectedPinyin, startMs: 100, endMs: 400, confidence: 0.95, verifier: "mock-phoneme" };
    } });
    const pronunciationIssue = mismatch.issues.find((issue) => issue.code === "audio_pronunciation_mismatch" && issue.sceneIndex === 2);
    assert.ok(pronunciationIssue);
    const dirty = dirtyPlanFromIssues([pronunciationIssue!], project.scenes.length);
    assert.deepEqual(dirty.audioSceneIndexes, [2]);
    assert.equal(dirty.concatAudio, true); assert.equal(dirty.remux, true); assert.deepEqual(dirty.videoSceneIndexes, []);
    const beforeRepair = server.requests.length;
    await azureTts({ sceneIndex: 2, displayText: plans[2].displayText, synthesisText: plans[2].synthesisText, pronunciationPlan: plans[2], pronunciationPlanHash: plans[2].planHash, pronunciationStrategy: "spoken-fallback", cacheSalt: "scene-2-repair", force: true, outputPath: path.join(root, "repair", "2.wav") }, runtimeConfig);
    assert.equal(server.requests.length - beforeRepair, 1);

    let inconclusiveCalls = 0;
    const inconclusiveAudioPath = path.join(root, "inconclusive.wav");
    const inconclusiveAudio = wavBuffer();
    inconclusiveAudio.writeInt16LE(1, 44);
    await writeFile(inconclusiveAudioPath, inconclusiveAudio);
    const singleSceneProject = { ...project, audio: { ...project.audio!, src: inconclusiveAudioPath }, narrationSegments: [project.narrationSegments![2]] };
    const inconclusive = await runAudioPronunciationGate({ project: singleSceneProject, config: runtimeConfig, verify: async () => {
      inconclusiveCalls += 1;
      return { status: "inconclusive", confidence: 0.2, verifier: "mock-phoneme", reason: "alignment_failed" };
    } });
    assert.equal(inconclusive.issues.some((issue) => issue.code === "audio_pronunciation_mismatch"), false);
    assert.equal(inconclusive.issues.some((issue) => issue.code === "verification_inconclusive"), true);

    const ledger = new PronunciationAttemptLedger();
    const identity = { phraseFingerprint: "重构", provider: "f5", pronunciationStrategy: "switch-pronunciation-mode" as const, pronunciationPlanHash: plans[2].planHash };
    assert.equal(ledger.claim(2, identity), true); assert.equal(ledger.claim(2, identity), false);
    const routed = await runWithRuntimeConfig(runtimeConfig, () => routeTtsProvider({ profile: "production", plan: plans[2], explicitProvider: "azure" }));
    assert.equal(routed.selectedProvider, "azure"); assert.equal(routed.pronunciationStrategy, "switch-pronunciation-mode");

    const cachedAudioPath = path.join(root, "cached.wav");
    const cachedAudio = wavBuffer();
    cachedAudio.writeInt16LE(2, 44);
    await writeFile(cachedAudioPath, cachedAudio);
    const cachedProject = { ...singleSceneProject, audio: { ...singleSceneProject.audio!, src: cachedAudioPath } };
    let asrCalls = 0;
    const transcribe = async () => { asrCalls += 1; return [{ sceneIndex: 2, text: plans[2].displayText, confidence: 0.99 }]; };
    await transcribeScenesCached({ project: cachedProject, config: runtimeConfig, provider: "mock", transcribe });
    await transcribeScenesCached({ project: cachedProject, config: runtimeConfig, provider: "mock", transcribe });
    assert.equal(asrCalls, 1);
    let cachedVerifierCalls = 0;
    const verify = async () => { cachedVerifierCalls += 1; return { status: "verified" as const, actualPinyin: ["chong2", "gou4"], startMs: 100, endMs: 400, confidence: 0.99, verifier: "mock-cache" }; };
    await runAudioPronunciationGate({ project: cachedProject, config: runtimeConfig, verify });
    await runAudioPronunciationGate({ project: cachedProject, config: runtimeConfig, verify });
    assert.equal(cachedVerifierCalls, 1);

    const quotaRoot = path.join(root, "quota-cache");
    await mkdir(path.join(quotaRoot, "metadata"), { recursive: true });
    await writeFile(path.join(quotaRoot, "metadata", "azure-tts-usage.json"), JSON.stringify({ version: 1, month: new Date().toISOString().slice(0, 7), usedCharacters: 1, updatedAt: new Date().toISOString() }));
    const quotaConfig = config(quotaRoot, server.endpoint, 1);
    process.env.SCENE_GEN_CACHE_DIR = quotaRoot; process.env.AZURE_TTS_MONTHLY_CHARACTER_BUDGET = "1";
    const quotaRoute = await runWithRuntimeConfig(quotaConfig, () => routeTtsProvider({ profile: "production", plan: plans[2] }));
    assert.equal(quotaRoute.selectedProvider, "f5");
    assert.equal(quotaRoute.candidates.find((candidate) => candidate.providerId === "azure")?.reasons.some((reason) => reason.includes("hard limit")), true);

    const usage = await readAzureUsage(runtimeConfig);
    const benchmark = {
      coldAudioMs, warmAudioMs, ttsRequestCount: server.requests.length, asrRequestCount: asrCalls,
      pronunciationVerificationCount: verifierCalls + inconclusiveCalls + cachedVerifierCalls,
      avoidedTtsRegenerationCount: ledger.metrics().avoidedTtsRegenerationCount, azureBilledCharacters: usage.usedCharacters,
      cacheHitRatio: warm.filter((item) => item.reused).length / warm.length, providerSwitchCount: 1,
      singleSceneRepairTtsRequests: 1, selectedProvider: routed.selectedProvider, pronunciationStrategy: routed.pronunciationStrategy,
      quotaBlocked: true, expectedColdCharacters: plans.reduce((sum, plan) => sum + azureBillableCharacters(plan.synthesisText), 0),
    };
    assert.equal(benchmark.cacheHitRatio, 1); assert.equal(benchmark.avoidedTtsRegenerationCount, 1);
    assert.equal(cold.every((item) => !item.reused), true); assert.ok(benchmark.azureBilledCharacters >= benchmark.expectedColdCharacters);
  } finally {
    await server.close();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    resetAzureProviderStateForTests();
    await rm(root, { recursive: true, force: true });
  }
});
