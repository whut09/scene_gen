import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRuntimeConfig, runtimeConfigSnapshot } from "../../src/config/runtime-config";
import { runExternalProcess } from "../../src/pipeline/external-operation";
import {
  AzureTtsError,
  azureCacheKey,
  azureBillableCharacters,
  azureTts,
  inspectAzureVoice,
  readAzureUsage,
  resetAzureProviderStateForTests,
  synthesizeAzureSpeech,
} from "../../src/pipeline/tts/providers/azure";
import { compilePronunciationPlan } from "../../src/pipeline/pronunciation/compiler";
import { buildAzurePlainSsml } from "../../src/pipeline/tts/providers/azure-ssml";
import { pronunciationPlanHash, type PronunciationPlan } from "../../src/pipeline/pronunciation/schema";

function wavBuffer(durationSeconds = 0.08, sampleRate = 16_000) {
  const samples = Math.max(1, Math.floor(durationSeconds * sampleRate));
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

async function mockServer(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const server = createServer((request, response) => void Promise.resolve(handler(request, response)).catch((error) => {
    response.statusCode = 500;
    response.end(String(error));
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock server did not bind a TCP port.");
  return {
    endpoint: `http://127.0.0.1:${address.port}/cognitiveservices/v1`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function azureConfig(cacheRoot: string, endpoint: string, overrides: NodeJS.ProcessEnv = {}) {
  return buildRuntimeConfig({
    ...process.env,
    SCENE_GEN_CACHE_DIR: cacheRoot,
    TTS_PROVIDER: "azure",
    AZURE_SPEECH_KEY: "azure-secret-key",
    AZURE_SPEECH_ENDPOINT: endpoint,
    AZURE_TTS_VOICE: "zh-CN-XiaoxiaoNeural",
    AZURE_TTS_OUTPUT_FORMAT: "riff-24khz-16bit-mono-pcm",
    AZURE_TTS_TIMEOUT_MS: "1000",
    AZURE_TTS_MAX_RETRIES: "0",
    AZURE_TTS_CONCURRENCY: "2",
    AZURE_TTS_REQUESTS_PER_MINUTE: "1000",
    AZURE_TTS_MONTHLY_CHARACTER_BUDGET: "500000",
    ...overrides,
  }, "azure-free");
}

function input(outputPath: string, sceneIndex = 0, text = "系统完成核心模块重构") {
  return {
    sceneIndex,
    displayText: text,
    synthesisText: text,
    outputPath,
    pronunciationPlanHash: "a".repeat(64),
  };
}

test("Azure TTS generates WAV, caches it, and redacts its API key", { concurrency: false }, async () => {
  resetAzureProviderStateForTests();
  const root = await mkdtemp(path.join(tmpdir(), "scene-gen-azure-tts-"));
  let calls = 0;
  let authorization = "";
  const server = await mockServer(async (request, response) => {
    if (request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify([{ ShortName: "zh-CN-XiaoxiaoNeural", Locale: "zh-CN" }]));
      return;
    }
    calls += 1;
    authorization = String(request.headers["ocp-apim-subscription-key"] ?? "");
    response.setHeader("x-requestid", `azure-request-${calls}`);
    response.end(wavBuffer());
  });
  try {
    const config = azureConfig(root, server.endpoint);
    assert.equal(runtimeConfigSnapshot(config).tts.azure.apiKey, undefined);
    assert.doesNotMatch(JSON.stringify(runtimeConfigSnapshot(config)), /azure-secret-key/);
    const first = await azureTts(input(path.join(root, "first.wav")), config);
    const second = await azureTts(input(path.join(root, "second.wav")), config);
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.equal(first.result.billedCharacters, azureBillableCharacters("系统完成核心模块重构"));
    assert.equal(second.result.billedCharacters, 0);
    assert.equal(calls, 1);
    assert.equal(authorization, "azure-secret-key");
    assert.deepEqual(await readFile(path.join(root, "first.wav")), await readFile(path.join(root, "second.wav")));
    assert.equal((await inspectAzureVoice(config)).voiceFound, true);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Azure TTS retries 429 but does not retry authentication errors", { concurrency: false }, async () => {
  resetAzureProviderStateForTests();
  const root = await mkdtemp(path.join(tmpdir(), "scene-gen-azure-retry-"));
  let rateLimitedCalls = 0;
  const rateLimited = await mockServer((_request, response) => {
    rateLimitedCalls += 1;
    if (rateLimitedCalls === 1) {
      response.statusCode = 429;
      response.end("retry later");
    } else response.end(wavBuffer());
  });
  try {
    const config = azureConfig(root, rateLimited.endpoint, { AZURE_TTS_MAX_RETRIES: "1" });
    const result = await synthesizeAzureSpeech(input(path.join(root, "retry.wav")), config);
    assert.equal(result.retryCount, 1);
    assert.equal(rateLimitedCalls, 2);
  } finally {
    await rateLimited.close();
  }

  resetAzureProviderStateForTests();
  let unauthorizedCalls = 0;
  const unauthorized = await mockServer((_request, response) => {
    unauthorizedCalls += 1;
    response.statusCode = 401;
    response.end("rejected azure-secret-key");
  });
  try {
    const config = azureConfig(root, unauthorized.endpoint, { AZURE_TTS_MAX_RETRIES: "3" });
    await assert.rejects(
      synthesizeAzureSpeech(input(path.join(root, "unauthorized.wav"), 1), config),
      (error: unknown) => error instanceof AzureTtsError
        && error.result.errorType === "authentication_error"
        && error.result.retryCount === 0
        && !error.message.includes("azure-secret-key"),
    );
    assert.equal(unauthorizedCalls, 1);
  } finally {
    await unauthorized.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Azure TTS falls back only for unsupported phonemes and gives fallback a distinct cache key", { concurrency: false }, async () => {
  resetAzureProviderStateForTests();
  const root = await mkdtemp(path.join(tmpdir(), "scene-gen-azure-fallback-"));
  const bodies: string[] = [];
  const server = await mockServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    bodies.push(body);
    if (bodies.length === 1) {
      response.statusCode = 400;
      response.end("Unsupported phoneme alphabet for pronunciation");
      return;
    }
    response.end(wavBuffer());
  });
  try {
    const config = azureConfig(root, server.endpoint);
    const { plan } = await compilePronunciationPlan({ displayText: "系统完成核心模块重构" });
    const phonemeInput = { ...input(path.join(root, "fallback.wav"), 2, plan.displayText), pronunciationPlan: plan, pronunciationPlanHash: plan.planHash };
    const fallbackText = "系统完成核心模块重新构建";
    const fallbackInput = {
      ...phonemeInput,
      pronunciationPlan: undefined,
      pronunciationStrategy: "spoken-fallback" as const,
      synthesisText: fallbackText,
      ssml: buildAzurePlainSsml(fallbackText, { voice: config.tts.azure.voice }),
    };
    assert.notEqual(azureCacheKey(phonemeInput, config), azureCacheKey(fallbackInput, config));
    const result = await azureTts(phonemeInput, config);
    assert.equal(result.reused, false);
    assert.equal(bodies.length, 2);
    assert.match(bodies[0], /ph="chong 2 - gou 4">重构/);
    assert.doesNotMatch(bodies[1], /<phoneme/);
    assert.match(bodies[1], /重新构建/);
    assert.equal(plan.displayText, "系统完成核心模块重构");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Azure TTS never uses spoken fallback for 401 and retries 429 with the original phoneme SSML", { concurrency: false }, async () => {
  resetAzureProviderStateForTests();
  const root = await mkdtemp(path.join(tmpdir(), "scene-gen-azure-strategy-"));
  const { plan } = await compilePronunciationPlan({ displayText: "重构" });
  const unauthorizedBodies: string[] = [];
  const unauthorized = await mockServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    unauthorizedBodies.push(body);
    response.statusCode = 401;
    response.end("unauthorized");
  });
  try {
    const config = azureConfig(root, unauthorized.endpoint, { AZURE_TTS_MAX_RETRIES: "2" });
    await assert.rejects(azureTts({ ...input(path.join(root, "unauthorized-phoneme.wav"), 3, plan.displayText), pronunciationPlan: plan, pronunciationPlanHash: plan.planHash }, config), (error: unknown) => error instanceof AzureTtsError && error.result.errorType === "authentication_error");
    assert.equal(unauthorizedBodies.length, 1);
    assert.match(unauthorizedBodies[0], /<phoneme/);
  } finally {
    await unauthorized.close();
  }

  resetAzureProviderStateForTests();
  const retryBodies: string[] = [];
  const rateLimited = await mockServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    retryBodies.push(body);
    if (retryBodies.length === 1) {
      response.statusCode = 429;
      response.end("retry");
      return;
    }
    response.end(wavBuffer());
  });
  try {
    const config = azureConfig(root, rateLimited.endpoint, { AZURE_TTS_MAX_RETRIES: "1" });
    await azureTts({ ...input(path.join(root, "retry-phoneme.wav"), 4, plan.displayText), pronunciationPlan: plan, pronunciationPlanHash: plan.planHash }, config);
    assert.equal(retryBodies.length, 2);
    assert.equal(retryBodies[0], retryBodies[1]);
    assert.match(retryBodies[0], /<phoneme/);
  } finally {
    await rateLimited.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Azure TTS handles timeout, AbortSignal, and malformed SSML without leaking requests", { concurrency: false }, async () => {
  resetAzureProviderStateForTests();
  const root = await mkdtemp(path.join(tmpdir(), "scene-gen-azure-cancel-"));
  let calls = 0;
  const server = await mockServer(async (_request, response) => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 150));
    response.end(wavBuffer());
  });
  try {
    const timeoutConfig = azureConfig(root, server.endpoint, { AZURE_TTS_TIMEOUT_MS: "20" });
    await assert.rejects(synthesizeAzureSpeech(input(path.join(root, "timeout.wav")), timeoutConfig), (error: unknown) => error instanceof AzureTtsError && error.result.errorType === "timeout");
    const controller = new AbortController();
    controller.abort(new Error("cancel test"));
    await assert.rejects(synthesizeAzureSpeech({ ...input(path.join(root, "abort.wav"), 1), signal: controller.signal }, timeoutConfig), (error: unknown) => error instanceof AzureTtsError && error.result.errorType === "cancelled");
    const beforeMalformed = calls;
    await assert.rejects(synthesizeAzureSpeech({ ...input(path.join(root, "invalid.wav"), 2), ssml: "<speak>" }, timeoutConfig), (error: unknown) => error instanceof AzureTtsError && error.result.errorType === "invalid_ssml");
    assert.equal(calls, beforeMalformed);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Azure TTS rejects overlapping pronunciation spans before sending HTTP", { concurrency: false }, async () => {
  resetAzureProviderStateForTests();
  const root = await mkdtemp(path.join(tmpdir(), "scene-gen-azure-invalid-plan-"));
  let calls = 0;
  const server = await mockServer((_request, response) => {
    calls += 1;
    response.end(wavBuffer());
  });
  try {
    const config = azureConfig(root, server.endpoint);
    const { plan } = await compilePronunciationPlan({ displayText: "重构系统" });
    const withoutHash = {
      ...plan,
      spans: [...plan.spans, { ...plan.spans[0], phrase: "构系", start: 1, end: 3, expectedPinyin: ["gou4", "xi4"] }],
    };
    const invalidPlan: PronunciationPlan = { ...withoutHash, planHash: pronunciationPlanHash(withoutHash) };
    await assert.rejects(
      azureTts({ ...input(path.join(root, "invalid-plan.wav"), 5, invalidPlan.displayText), pronunciationPlan: invalidPlan, pronunciationPlanHash: invalidPlan.planHash }, config),
      (error: unknown) => error instanceof AzureTtsError && error.result.errorType === "pronunciation_plan_invalid",
    );
    assert.equal(calls, 0);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Azure TTS enforces provider concurrency and monthly character budget", { concurrency: false }, async () => {
  resetAzureProviderStateForTests();
  const root = await mkdtemp(path.join(tmpdir(), "scene-gen-azure-budget-"));
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const server = await mockServer(async (_request, response) => {
    calls += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 50));
    active -= 1;
    response.end(wavBuffer());
  });
  try {
    const config = azureConfig(root, server.endpoint, { AZURE_TTS_CONCURRENCY: "2", AZURE_TTS_MONTHLY_CHARACTER_BUDGET: "20" });
    await Promise.all(Array.from({ length: 4 }, (_, index) => synthesizeAzureSpeech(input(path.join(root, `scene-${index}.wav`), index, "重构"), config)));
    assert.equal(maximumActive, 2);
    assert.equal(calls, 4);
    assert.equal((await readAzureUsage(config)).usedCharacters, 16);
    await assert.rejects(synthesizeAzureSpeech(input(path.join(root, "over-budget.wav"), 5, "重构系统"), config), (error: unknown) => error instanceof AzureTtsError && error.result.errorType === "budget_exceeded");
    assert.equal(calls, 4);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Azure TTS converts compressed API output to the project WAV format", { concurrency: false }, async () => {
  resetAzureProviderStateForTests();
  const root = await mkdtemp(path.join(tmpdir(), "scene-gen-azure-mp3-"));
  const sourceWav = path.join(root, "source.wav");
  const sourceMp3 = path.join(root, "source.mp3");
  await writeFile(sourceWav, wavBuffer(0.2, 24_000));
  await runExternalProcess("ffmpeg", ["-y", "-v", "error", "-i", sourceWav, sourceMp3], { timeoutMs: 30_000 });
  const mp3 = await readFile(sourceMp3);
  const server = await mockServer((_request, response) => response.end(mp3));
  try {
    const config = azureConfig(root, server.endpoint, { AZURE_TTS_OUTPUT_FORMAT: "audio-24khz-48kbitrate-mono-mp3" });
    const outputPath = path.join(root, "converted.wav");
    const result = await synthesizeAzureSpeech(input(outputPath), config);
    assert.ok(result.durationSeconds > 0);
    assert.equal((await readFile(outputPath)).subarray(0, 4).toString("ascii"), "RIFF");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
