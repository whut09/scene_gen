import assert from "node:assert/strict";
import test from "node:test";
import { canonicalSpeechText, loadedSpeechPackages } from "./speech-normalization";

test("speech normalization loads base and domain dictionaries", () => {
  const previous = process.env.ASR_DOMAIN_PACKAGES;
  process.env.ASR_DOMAIN_PACKAGES = "scene-gen";
  try {
    assert.deepEqual(loadedSpeechPackages(), ["base", "scene-gen"]);
    assert.equal(canonicalSpeechText("Open AI 與 Money Printer Turbo"), "openai与moneyprinterturbo");
    assert.equal(canonicalSpeechText("兩文封的新手複"), "梁文锋的新首富");
  } finally {
    if (previous === undefined) delete process.env.ASR_DOMAIN_PACKAGES;
    else process.env.ASR_DOMAIN_PACKAGES = previous;
  }
});
