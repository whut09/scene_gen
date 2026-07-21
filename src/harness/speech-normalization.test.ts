import assert from "node:assert/strict";
import test from "node:test";
import { canonicalSpeechText, loadedSpeechPackages } from "./speech-normalization";

test("speech normalization loads base and domain dictionaries", () => {
  const previous = process.env.ASR_DOMAIN_PACKAGES;
  process.env.ASR_DOMAIN_PACKAGES = "scene-gen";
  try {
    assert.deepEqual(loadedSpeechPackages(), ["base", "scene-gen"]);
  assert.equal(canonicalSpeechText("Open AI 與 Money Printer Turbo"), "openai与moneyprinterturbo");
  assert.equal(canonicalSpeechText("字節發布 Seed Audio"), "字节发布seedaudio");
    assert.equal(canonicalSpeechText("兩文封的新手複"), "梁文锋的新首富");
    assert.equal(canonicalSpeechText("據美國網站XiaOS報導，約職按面推出K-Mix-3"), "据美国网站axios报道月之暗面推出kimik3");
    assert.equal(canonicalSpeechText("Mozila Social與GIPCQG"), "mozilla与deepseek");
    assert.equal(canonicalSpeechText("第一架大模型，新文日期，第三平解图證文面想副雜任務"), "低价大模型新闻日期第三屏截图正文面向复杂任务");
    assert.equal(canonicalSpeechText("優庫總裁無欠表示人工智能無法取代真任演員"), "优酷总裁吴倩表示人工智能无法取代真人演员");
    assert.equal(canonicalSpeechText("人工智能從領感落地、視覺成先到分敬設計影像影視行業"), "人工智能从灵感落地视觉呈现到分镜设计影响影视行业");
  } finally {
    if (previous === undefined) delete process.env.ASR_DOMAIN_PACKAGES;
    else process.env.ASR_DOMAIN_PACKAGES = previous;
  }
});
