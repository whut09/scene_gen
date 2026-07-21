import assert from "node:assert/strict";
import test from "node:test";
import { buildRuntimeConfig } from "../../src/config/runtime-config";
import { compilePronunciationPlan } from "../../src/pipeline/pronunciation/compiler";
import { encodeNvidiaWorkerRequest, isRetryableNvidiaTtsError, NVIDIA_TTS_FRONTEND_VERSION, nvidiaHttpFallbackText, nvidiaPronunciationDictionary, nvidiaTtsCacheIdentity, splitNvidiaSynthesisText } from "../../src/pipeline/tts/providers/nvidia";

test("NVIDIA worker requests preserve Mandarin text as UTF-8", () => {
  const input = { requestId: "request-1", text: "系统完成核心模块重构，这项更新非常重要。", outputPath: "output.wav" };
  const encoded = encodeNvidiaWorkerRequest(input);
  assert.equal(encoded.toString("utf8"), `${JSON.stringify(input)}\n`);
  assert.deepEqual(JSON.parse(encoded.toString("utf8")), input);
  assert.equal(encoded.includes(Buffer.from("重构", "utf8")), true);
});

test("NVIDIA cache identity invalidates the legacy whole-sentence pinyin frontend", async () => {
  const config = buildRuntimeConfig({ NVIDIA_API_KEY: "test-only", NVIDIA_TTS_MODEL: "magpie", NVIDIA_TTS_VOICE: "Magpie-Multilingual.ZH-CN.HouZhen" }, "test");
  const { plan } = await compilePronunciationPlan({ displayText: "系统完成核心模块重构" });
  const identity = nvidiaTtsCacheIdentity({ plan }, config);
  assert.equal(identity.frontendVersion, NVIDIA_TTS_FRONTEND_VERSION);
  assert.equal(identity.frontendVersion, "nvidia-magpie-mandarin-acoustic-stability-v18");
  assert.notEqual(identity.frontendVersion, "nvidia-magpie-pinyin-v1");
  assert.equal(identity.synthesisText, plan.synthesisText);
  assert.equal(identity.speed, 1.25);
});

test("NVIDIA cache identity changes when narration speed changes", async () => {
  const { plan } = await compilePronunciationPlan({ displayText: "系统完成核心模块重构" });
  const normal = buildRuntimeConfig({ NVIDIA_API_KEY: "test-only", NVIDIA_TTS_SPEED: "1" }, "test");
  const faster = buildRuntimeConfig({ NVIDIA_API_KEY: "test-only", NVIDIA_TTS_SPEED: "1.25" }, "test");
  assert.notDeepEqual(nvidiaTtsCacheIdentity({ plan }, normal), nvidiaTtsCacheIdentity({ plan }, faster));
});

test("NVIDIA cache identity changes when transport changes", async () => {
  const { plan } = await compilePronunciationPlan({ displayText: "普通话音色测试" });
  const grpc = buildRuntimeConfig({ NVIDIA_API_KEY: "test-only", NVIDIA_TTS_TRANSPORT: "grpc" }, "test");
  const http = buildRuntimeConfig({ NVIDIA_API_KEY: "test-only", NVIDIA_TTS_TRANSPORT: "http" }, "test");
  assert.notDeepEqual(nvidiaTtsCacheIdentity({ plan }, grpc), nvidiaTtsCacheIdentity({ plan }, http));
});

test("NVIDIA synthesis splits long Mandarin at punctuation within the safe limit", () => {
  const text = "第一句介绍模型发布和来源。第二句说明参数规模、上下文窗口、视觉能力以及面向软件工程和深度研究的优化方向。第三句补充价格限定词和后续验证要求。";
  const chunks = splitNvidiaSynthesisText(text, 32);
  assert.equal(chunks.join(""), text);
  assert.equal(chunks.length > 1, true);
  assert.equal(chunks.every((chunk) => [...chunk].length <= 32), true);
});

test("NVIDIA synthesis packs short sentences into one stable voice request", () => {
  const text = "First sentence. Second sentence. Third sentence.";
  assert.deepEqual(splitNvidiaSynthesisText(text, 80), [text]);
});

test("NVIDIA pronunciation dictionary carries tone-number pinyin for risky phrases", async () => {
  const { plan } = await compilePronunciationPlan({ displayText: "系统完成核心模块重构，重复测试非常重要。" });
  assert.deepEqual(nvidiaPronunciationDictionary(plan), {
    重构: "chong2 gou4",
    重复: "chong2 fu4",
    重要: "zhong4 yao4",
  });
  assert.deepEqual(nvidiaPronunciationDictionary(plan, "重复测试非常重要。"), {
    重复: "chong2 fu4",
    重要: "zhong4 yao4",
  });
});

test("NVIDIA HTTP transport uses spoken fallbacks for risky polyphones", async () => {
  const { plan } = await compilePronunciationPlan({ displayText: "系统完成重构并处理长内容" });
  assert.equal(nvidiaHttpFallbackText(plan), "系统完成重新构建并处理长篇内容");
  assert.equal(plan.displayText, "系统完成重构并处理长内容");
});

test("NVIDIA worker request serializes the custom pronunciation dictionary", () => {
  const input = {
    requestId: "request-tone",
    text: "系统完成重构。",
    outputPath: "output.wav",
    customDictionary: { 重构: "chong2 gou4" },
  };
  assert.deepEqual(JSON.parse(encodeNvidiaWorkerRequest(input).toString("utf8")), input);
});

test("NVIDIA defaults to the configured native Mandarin Siwei voice", () => {
  const config = buildRuntimeConfig({ NVIDIA_API_KEY: "test-only" }, "test");
  assert.equal(config.tts.nvidia.voice, "Magpie-Multilingual.ZH-CN.Siwei");
});

test("NVIDIA retries closed Triton streams but not deterministic request errors", () => {
  assert.equal(isRetryableNvidiaTtsError(new Error("unavailable: Stream removed")), true);
  assert.equal(isRetryableNvidiaTtsError(new Error("Triton model failed during inference. Stream has been closed.")), true);
  assert.equal(isRetryableNvidiaTtsError(new Error("invalid pronunciation dictionary")), false);
});
