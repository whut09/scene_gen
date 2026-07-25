import assert from "node:assert/strict";
import test from "node:test";
import { splitIndexTtsText } from "./indextts";

test("IndexTTS splits long narration on sentence boundaries", () => {
  const chunks = splitIndexTtsText("第一句说明背景，第二句说明方法。第三句说明结果，第四句说明边界。", 18);

  assert.deepEqual(chunks, ["第一句说明背景，第二句说明方法。", "第三句说明结果，第四句说明边界。"]);
  assert.ok(chunks.every((chunk) => chunk.length <= 18));
});

test("IndexTTS keeps a short title in one synthesis unit", () => {
  assert.deepEqual(splitIndexTtsText("现在介绍，Kimi Code，开源项目推荐。", 88), ["现在介绍，Kimi Code，开源项目推荐。"]);
});
