import assert from "node:assert/strict";
import test from "node:test";
import { compilePronunciationPlan } from "../../pronunciation/compiler";
import { assertIndexTtsAcronymReadings, indexTtsPronunciationInput, normalizeIndexTtsAcronyms } from "../../pronunciation/provider-adapters";
import { prepareF5SynthesisText } from "../text-normalization";
import { INDEXTTS_FRONTEND_VERSION, splitIndexTtsText } from "./indextts";

test("IndexTTS splits long narration on sentence boundaries", () => {
  const chunks = splitIndexTtsText("第一句说明背景，第二句说明方法。第三句说明结果，第四句说明边界。", 18);

  assert.deepEqual(chunks, ["第一句说明背景，第二句说明方法。", "第三句说明结果，第四句说明边界。"]);
  assert.ok(chunks.every((chunk) => chunk.length <= 18));
});

test("IndexTTS keeps a short title in one synthesis unit", () => {
  assert.deepEqual(splitIndexTtsText("Kimi Code，开源项目推荐。", 88), ["Kimi Code，开源项目推荐。"]);
});

test("IndexTTS uses official glossary-compatible acronym spelling", async () => {
  const { plan } = await compilePronunciationPlan({ displayText: "AI 和 AGI 通过 OpenAI API 接入模型。" });

  const providerText = indexTtsPronunciationInput(plan).text;
  assert.equal(providerText, "A-I 和 A-G-I 通过 OpenAI A-P-I 接入模型。");
  assert.deepEqual(splitIndexTtsText(providerText), [providerText]);
  assert.equal(INDEXTTS_FRONTEND_VERSION, "indextts2-fixed-reference-v16-stable-seed-glossary-acronym-audio-gate");
});

test("IndexTTS keeps standalone LLM in one glossary-protected synthesis unit", () => {
  assert.equal(prepareF5SynthesisText("LLM 可以处理长文本。"), "LLM 可以处理长文本。");
  assert.equal(prepareF5SynthesisText("llm_wiki 仍保留项目名。"), "llm_wiki 仍保留项目名。");
  assert.equal(indexTtsPronunciationInput({
    displayText: "LLM Wiki",
    semanticText: "LLM Wiki",
    synthesisText: "LLM Wiki",
    spans: [],
    planHash: "0".repeat(64),
    frontendVersion: "test",
  }).text, "L-L-M Wiki");
});

test("TTS does not translate a word inside an English project title", () => {
  assert.equal(
    prepareF5SynthesisText("System Prompts Leaks 用于整理公开提示词。"),
    "System Prompts Leaks 用于整理公开提示词。",
  );
});

test("IndexTTS does not split AI or GB into standalone audio chunks", async () => {
  const { plan } = await compilePronunciationPlan({ displayText: "AI 模型可在16GB GPU运行。" });
  const providerText = indexTtsPronunciationInput(plan).text;
  assert.equal(providerText, "A-I 模型可在16G-B G-P-U运行。");
  assert.deepEqual(
    splitIndexTtsText(providerText),
    [providerText],
  );
});

test("IndexTTS joins separated acronyms and capacity units only in provider input", () => {
  assert.equal(normalizeIndexTtsAcronyms("A I、L L M 和 16 G B 显卡"), "A-I、L-L-M 和 16G-B 显卡");
  assert.equal(normalizeIndexTtsAcronyms("llm_wiki 使用 AI。"), "L-L-M_wiki 使用 A-I。");
});

test("IndexTTS rejects a provider input that can split LLM", () => {
  assert.throws(() => assertIndexTtsAcronymReadings("LLM Wiki", "L L M Wiki"), /continuous reading/);
  assert.doesNotThrow(() => assertIndexTtsAcronymReadings("LLM Wiki", "L-L-M Wiki"));
  assert.throws(() => assertIndexTtsAcronymReadings("LLM Wiki", "拉玛 Wiki"), /continuous reading/);
});
