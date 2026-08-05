import assert from "node:assert/strict";
import test from "node:test";
import { compilePronunciationPlan } from "../../pronunciation/compiler";
import { indexTtsPronunciationInput } from "../../pronunciation/provider-adapters";
import { INDEXTTS_FRONTEND_VERSION, splitIndexTtsText } from "./indextts";

test("IndexTTS splits long narration on sentence boundaries", () => {
  const chunks = splitIndexTtsText("第一句说明背景，第二句说明方法。第三句说明结果，第四句说明边界。", 18);

  assert.deepEqual(chunks, ["第一句说明背景，第二句说明方法。", "第三句说明结果，第四句说明边界。"]);
  assert.ok(chunks.every((chunk) => chunk.length <= 18));
});

test("IndexTTS keeps a short title in one synthesis unit", () => {
  assert.deepEqual(splitIndexTtsText("Kimi Code，开源项目推荐。", 88), ["Kimi Code，开源项目推荐。"]);
});

test("IndexTTS keeps acronyms connected to surrounding Mandarin", async () => {
  const { plan } = await compilePronunciationPlan({ displayText: "AI 和 AGI 通过 OpenAI API 接入模型。" });

  const providerText = indexTtsPronunciationInput(plan).text;
  assert.equal(providerText, "A I 和 A G I 通过 OpenAI A P I 接入模型。");
  assert.deepEqual(splitIndexTtsText(providerText), [providerText]);
  assert.equal(INDEXTTS_FRONTEND_VERSION, "indextts2-fixed-reference-v8-protected-pinyin");
});

test("IndexTTS does not split AI or GB into standalone audio chunks", async () => {
  const { plan } = await compilePronunciationPlan({ displayText: "AI 模型可在16GB显卡运行。" });
  const providerText = indexTtsPronunciationInput(plan).text;
  assert.equal(providerText, "A I 模型可在16G B显卡运行。");
  assert.deepEqual(
    splitIndexTtsText(providerText),
    [providerText],
  );
});
