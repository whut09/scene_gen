import assert from "node:assert/strict";
import test from "node:test";
import { XMLValidator } from "fast-xml-parser";
import { compilePronunciationPlan } from "../../src/pipeline/pronunciation/compiler";
import { cosyVoicePronunciationInput, edgePronunciationText, f5PronunciationInput, indexTtsPronunciationInput, localPronunciationText } from "../../src/pipeline/pronunciation/provider-adapters";
import { buildAzurePronunciationSsml } from "../../src/pipeline/tts/providers/azure-ssml";
import type { PronunciationSpan } from "../../src/pipeline/pronunciation/schema";

test("manual pronunciation plan covers required Chinese polyphones", async () => {
  const text = "重构、重复、重要、重量、重启、重试、函数重载、重载运输、银行、行走、长内容、长视频、长音频、延长、长大、长度、音乐、快乐";
  const { plan } = await compilePronunciationPlan({ displayText: text, domain: "software" });
  const pronunciations = new Map(plan.spans.map((span) => [span.phrase, span.expectedPinyin.join(" ")]));
  assert.equal(pronunciations.get("重构"), "chong2 gou4");
  assert.equal(pronunciations.get("重复"), "chong2 fu4");
  assert.equal(pronunciations.get("重要"), "zhong4 yao4");
  assert.equal(pronunciations.get("重量"), "zhong4 liang4");
  assert.equal(pronunciations.get("重启"), "chong2 qi3");
  assert.equal(pronunciations.get("重试"), "chong2 shi4");
  assert.equal(pronunciations.get("函数重载"), "han2 shu4 chong2 zai4");
  assert.equal(pronunciations.get("重载运输"), "zhong4 zai4 yun4 shu1");
  assert.equal(pronunciations.get("银行"), "yin2 hang2");
  assert.equal(pronunciations.get("行走"), "xing2 zou3");
  assert.equal(pronunciations.get("长内容"), "chang2 nei4 rong2");
  assert.equal(pronunciations.get("长视频"), "chang2 shi4 pin2");
  assert.equal(pronunciations.get("长音频"), "chang2 yin1 pin2");
  assert.equal(pronunciations.get("延长"), "yan2 chang2");
  assert.equal(pronunciations.get("长大"), "zhang3 da4");
  assert.equal(pronunciations.get("长度"), "chang2 du4");
  assert.equal(pronunciations.get("音乐"), "yin1 yue4");
  assert.equal(pronunciations.get("快乐"), "kuai4 le4");
  assert.equal(plan.displayText, text);
  assert.equal(plan.spans.find((span) => span.phrase === "重构")?.risk, "high");
  assert.equal(plan.spans.find((span) => span.phrase === "重构")?.spokenFallback, "重新构建");
});

test("local TTS removes ambiguous chang pronunciations without changing display text", async () => {
  const { plan } = await compilePronunciationPlan({ displayText: "把长内容和长视频继续延长" });
  assert.equal(localPronunciationText(plan), "把长篇内容和长篇视频继续延伸");
  assert.equal(plan.displayText, "把长内容和长视频继续延长");
});

test("longest phrase wins and manual entries override G2PW", async () => {
  const g2pw = { predict: async () => [{ phrase: "重构", start: 0, end: 2, pinyin: ["zhong4", "gou4"], confidence: 0.99 }] };
  const { plan } = await compilePronunciationPlan({ displayText: "重构后重载模型", domain: "software", g2pw });
  assert.equal(plan.spans.find((span) => span.phrase === "重构")?.source, "manual");
  assert.equal(plan.spans.find((span) => span.phrase === "重构")?.expectedPinyin[0], "chong2");
  assert.ok(plan.spans.some((span) => span.phrase === "重载模型"));
  assert.ok(!plan.spans.some((span) => span.phrase === "重载"));
});

test("G2PW beats pypinyin and low confidence becomes pronunciation_uncertain", async () => {
  const g2pw = { predict: async () => [
    { phrase: "朝", start: 0, end: 1, pinyin: ["zhao1"], confidence: 0.93 },
    { phrase: "薄", start: 2, end: 3, pinyin: ["bo2"], confidence: 0.4 },
  ] };
  const fallback = async (): Promise<PronunciationSpan[]> => [
    { phrase: "朝", start: 0, end: 1, expectedPinyin: ["chao2"], source: "pypinyin", confidence: 0.6, risk: "medium", providerOverrides: {} },
    { phrase: "薄", start: 2, end: 3, expectedPinyin: ["bao2"], source: "pypinyin", confidence: 0.6, risk: "medium", providerOverrides: {} },
  ];
  const { plan, issues } = await compilePronunciationPlan({ displayText: "朝阳薄雾", g2pw, pypinyinFallback: fallback, g2pwMinimumConfidence: 0.75 });
  assert.equal(plan.spans.find((span) => span.phrase === "朝")?.source, "g2pw");
  assert.equal(plan.spans.find((span) => span.phrase === "薄")?.source, "pypinyin");
  assert.deepEqual(issues, [{ code: "pronunciation_uncertain", phrase: "薄", confidence: 0.4 }]);
});

test("plan hashes are stable and scene-local changes do not invalidate unrelated plans", async () => {
  const first = await compilePronunciationPlan({ displayText: "系统完成重构" });
  const repeated = await compilePronunciationPlan({ displayText: "系统完成重构" });
  const unrelated = await compilePronunciationPlan({ displayText: "这是重要更新" });
  const changed = await compilePronunciationPlan({ displayText: "系统完成重构", overrides: [{ phrase: "重构", expectedPinyin: ["chong2", "gou4"], risk: "high", spokenFallback: "重新设计", providerOverrides: {} }] });
  const unrelatedRepeated = await compilePronunciationPlan({ displayText: "这是重要更新" });
  assert.equal(first.plan.planHash, repeated.plan.planHash);
  assert.notEqual(first.plan.planHash, changed.plan.planHash);
  assert.equal(unrelated.plan.planHash, unrelatedRepeated.plan.planHash);
});

test("provider adapters preserve display text and escape SSML", async () => {
  const { plan } = await compilePronunciationPlan({ displayText: "A&B <重构>", semanticText: "A&B <重构>" });
  const azure = buildAzurePronunciationSsml(plan, { voice: "zh-CN-XiaoxiaoNeural" });
  assert.match(azure, /<phoneme alphabet="sapi" ph="chong 2 - gou 4">重构<\/phoneme>/);
  assert.match(azure, /A&amp;B &lt;/);
  assert.equal(XMLValidator.validate(azure), true);
  assert.equal(f5PronunciationInput(plan).pronunciationPlanHash, plan.planHash);
  assert.equal(indexTtsPronunciationInput(plan).mixedPinyin.length, 1);
  assert.match(indexTtsPronunciationInput(plan).text, /CHONG2GOU4/);
  assert.doesNotMatch(indexTtsPronunciationInput(plan).text, /重构/);
  assert.equal(cosyVoicePronunciationInput(plan).pronunciationInpainting.length, 1);
  assert.equal(edgePronunciationText(plan), "A&B <重新构建>");
  assert.equal(plan.displayText, "A&B <重构>");
});
