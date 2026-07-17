import assert from "node:assert/strict";
import test from "node:test";
import { XMLValidator } from "fast-xml-parser";
import { compilePronunciationPlan } from "../../src/pipeline/pronunciation/compiler";
import { pronunciationPlanHash, type PronunciationPlan } from "../../src/pipeline/pronunciation/schema";
import {
  AzureSsmlError,
  azureSpokenFallbackText,
  buildAzurePronunciationSsml,
  runAzureSsmlSelfTest,
  tone3ToAzureSapi,
} from "../../src/pipeline/tts/providers/azure-ssml";

test("Azure zh-CN SAPI conversion keeps syllables and separates tones explicitly", async () => {
  assert.equal(tone3ToAzureSapi("chong2"), "chong 2");
  assert.equal(tone3ToAzureSapi("gou4"), "gou 4");
  const { plan } = await compilePronunciationPlan({ displayText: "系统完成核心模块重构，这是重要更新和重量指标。" });
  const ssml = buildAzurePronunciationSsml(plan, { voice: "zh-CN-XiaoxiaoNeural" });
  assert.match(ssml, /ph="chong 2 - gou 4">重构/);
  assert.match(ssml, /ph="zhong 4 - yao 4">重要/);
  assert.match(ssml, /ph="zhong 4 - liang 4">重量/);
  assert.equal(plan.displayText, "系统完成核心模块重构，这是重要更新和重量指标。");
  assert.equal(XMLValidator.validate(ssml), true);
});

test("Azure SSML preserves multiple span order and escapes XML", async () => {
  const { plan } = await compilePronunciationPlan({ displayText: "A&B <重构> 后重复" });
  const ssml = buildAzurePronunciationSsml(plan, { voice: 'zh-CN-"Test"', style: "cheerful", role: "YoungAdultFemale" });
  assert.ok(ssml.indexOf("chong 2 - gou 4") < ssml.indexOf("chong 2 - fu 4"));
  assert.match(ssml, /A&amp;B &lt;/);
  assert.match(ssml, /name="zh-CN-&quot;Test&quot;"/);
  assert.equal(XMLValidator.validate(ssml), true);
});

test("Azure SSML rejects overlapping and malformed pronunciation plans", async () => {
  const { plan } = await compilePronunciationPlan({ displayText: "重构系统" });
  const overlappingBase = {
    ...plan,
    spans: [...plan.spans, { ...plan.spans[0], phrase: "构系", start: 1, end: 3, expectedPinyin: ["gou4", "xi4"] }],
  };
  const overlapping: PronunciationPlan = { ...overlappingBase, planHash: pronunciationPlanHash(overlappingBase) };
  assert.throws(() => buildAzurePronunciationSsml(overlapping, { voice: "zh-CN-XiaoxiaoNeural" }), (error: unknown) => error instanceof AzureSsmlError && error.errorType === "pronunciation_plan_invalid");
  assert.throws(() => tone3ToAzureSapi("not-pinyin"), AzureSsmlError);
});

test("Azure spoken fallback changes synthesis only and self-test is offline", async () => {
  const { plan } = await compilePronunciationPlan({ displayText: "系统完成重构" });
  assert.equal(azureSpokenFallbackText(plan), "系统完成重新构建");
  assert.equal(plan.displayText, "系统完成重构");
  assert.equal(plan.semanticText, "系统完成重构");
  await runAzureSsmlSelfTest();
});
