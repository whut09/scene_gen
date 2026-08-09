import assert from "node:assert/strict";
import test from "node:test";
import { acronymsRequiringSpelledLetters, replaceAcronymsWithSpelledLetters } from "../../src/pipeline/pronunciation/provider-adapters";
import { prepareF5SynthesisText } from "../../src/pipeline/tts/text-normalization";

test("normalizes standalone AI regardless of source casing", () => {
  assert.equal(replaceAcronymsWithSpelledLetters("AI模型"), "A-I模型");
  assert.equal(replaceAcronymsWithSpelledLetters("ai模型"), "A-I模型");
  assert.equal(replaceAcronymsWithSpelledLetters("OpenAI模型"), "OpenAI模型");
  assert.deepEqual(acronymsRequiringSpelledLetters("ai模型与AI工具"), ["AI"]);
});

test("does not rewrite ordinary English words", () => {
  assert.equal(replaceAcronymsWithSpelledLetters("This is an api."), "This is an A-P-I.");
  assert.equal(replaceAcronymsWithSpelledLetters("For use"), "For use");
});

test("keeps ChatGPT as an English product name", () => {
  const prepared = prepareF5SynthesisText("ChatGPT 免费版升级。");
  assert.match(prepared, /恰特 G-P-T/);
  assert.doesNotMatch(prepared, /聊天/);
});

test("uses a stable Mandarin reading for Sol", () => {
  assert.match(prepareF5SynthesisText("GPT-5.6 Sol 更新。"), /索尔/);
});
