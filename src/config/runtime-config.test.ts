import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRuntimeConfig,
  restoreRuntimeConfig,
  runtimeConfigHash,
  runtimeConfigProcessEnv,
  runtimeConfigSnapshot,
  runtimeConfigWithRunOverrides,
} from "./runtime-config";

function testEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    SCENE_GEN_PROFILE: "test",
    NEWS_LLM_API_KEY: "news-secret",
    NEWS_LLM_MODEL: "test-model",
    QUALITY_LLM_API_KEY: "quality-secret",
    AZURE_SPEECH_KEY: "azure-secret",
    AZURE_SPEECH_REGION: "eastasia",
    OPENAI_TTS_API_KEY: "tts-secret",
    HTML_RENDER_CONCURRENCY: "3",
    VIDEO_OCR_ENABLED: "true",
    F5_TTS_NFE_STEP: "24",
    ...overrides,
  };
}

test("runtime config parses values and is deeply immutable", () => {
  const config = buildRuntimeConfig(testEnv());
  assert.equal(config.rendering.html.concurrency, 3);
  assert.equal(config.rendering.ocr.enabled, true);
  assert.equal(config.tts.f5.nfeStep, 24);
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.rendering), true);
  assert.equal(Object.isFrozen(config.rendering.html), true);
  assert.equal(Reflect.set(config.rendering.html, "concurrency", 9), false);
  assert.equal(config.rendering.html.concurrency, 3);
});

test("runtime config snapshots redact secrets and hash only behavior", () => {
  const first = buildRuntimeConfig(testEnv());
  const second = buildRuntimeConfig(testEnv({ NEWS_LLM_API_KEY: "rotated", QUALITY_LLM_API_KEY: "rotated-quality", AZURE_SPEECH_KEY: "rotated-azure", OPENAI_TTS_API_KEY: "rotated-tts" }));
  const snapshot = runtimeConfigSnapshot(first);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(snapshot.llm.news.apiKey, undefined);
  assert.equal(snapshot.llm.quality.apiKey, undefined);
  assert.equal(snapshot.tts.azure.apiKey, undefined);
  assert.equal(snapshot.tts.openai.apiKey, undefined);
  assert.equal(snapshot.asr.pronunciation.apiKey, undefined);
  assert.equal(runtimeConfigHash(first), runtimeConfigHash(second));
  assert.notEqual(runtimeConfigHash(first), runtimeConfigHash(runtimeConfigWithRunOverrides(first, { screenshotLimit: 2 })));
});

test("restoring a snapshot preserves behavior and reloads current secrets", () => {
  const original = buildRuntimeConfig(testEnv({ VIDEO_RENDER_ENGINE: "remotion", OPENAI_TTS_SPEED: "1.25" }));
  const restored = restoreRuntimeConfig(runtimeConfigSnapshot(original), testEnv({ NEWS_LLM_API_KEY: "new-news", QUALITY_LLM_API_KEY: "new-quality", AZURE_SPEECH_KEY: "new-azure", OPENAI_TTS_API_KEY: "new-tts", VIDEO_RENDER_ENGINE: "html-video", OPENAI_TTS_SPEED: "0.8" }));
  assert.equal(restored.rendering.engine, "remotion");
  assert.equal(restored.tts.openai.speed, 1.25);
  assert.equal(restored.llm.news.apiKey, "new-news");
  assert.equal(restored.llm.quality.apiKey, "new-quality");
  assert.equal(restored.tts.azure.apiKey, "new-azure");
  assert.equal(restored.tts.openai.apiKey, "new-tts");
  assert.equal(restored.asr.pronunciation.apiKey, "new-azure");
});

test("legacy runtime snapshots default new ASR verification fields", () => {
  const legacy = runtimeConfigSnapshot(buildRuntimeConfig(testEnv())) as unknown as { asr: Record<string, unknown> };
  delete legacy.asr.provider;
  delete legacy.asr.pronunciation;
  const restored = restoreRuntimeConfig(legacy, testEnv());
  assert.equal(restored.asr.provider, "whisper");
  assert.equal(restored.asr.pronunciation.provider, "disabled");
});

test("subprocess config propagation is validated and independent of ambient env", () => {
  const config = buildRuntimeConfig(testEnv({ TTS_PROVIDER: "f5" }));
  const childEnv = runtimeConfigProcessEnv(config, { PATH: "test-path", TTS_PROVIDER: "openai" });
  const childConfig = buildRuntimeConfig(childEnv);
  assert.equal(childConfig.tts.provider, "f5");
  assert.equal(childConfig.rendering.html.concurrency, 3);
  assert.equal(childEnv.PATH, "test-path");
});
