import assert from "node:assert/strict";
import test from "node:test";
import { prepareF5SynthesisText, removeLoneSurrogates } from "./tts";

test("removes lone Unicode surrogates while preserving valid pairs", () => {
  const input = "IPO\udc80筹备 😀 估值\ud800";
  assert.equal(removeLoneSurrogates(input), "IPO筹备 😀 估值");
  assert.doesNotThrow(() => Buffer.from(prepareF5SynthesisText(input), "utf8"));
  assert.equal(prepareF5SynthesisText(input).includes("\udc80"), false);
});


test("pronounces a headline-leading 曝 as bao", () => {
  const prepared = prepareF5SynthesisText("曝某项目发布新版本");
  assert.match(prepared, /爆料称/);
  assert.equal(prepared.includes("曝"), false);
});

test("normalizes Claude for Mandarin synthesis", () => {
  assert.equal(prepareF5SynthesisText("Claude 推进了相关研究。"), "克劳德 推进了相关研究。");
  assert.equal(prepareF5SynthesisText("Claude Code 继续保留产品原名。"), "Claude Code 继续保留产品原名。");
});

test("normalizes C2PA as a stable acronym", () => {
  assert.equal(prepareF5SynthesisText("使用 C2PA 元数据。"), "使用 C、二、P、A 元数据。");
});
