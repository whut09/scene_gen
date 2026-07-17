import assert from "node:assert/strict";
import test from "node:test";
import type { VideoProject } from "../../pipeline/types";
import { narrationRateMetrics } from "./audio-rules";

test("narration speed metrics use synthesis text when ttsText differs from display text", () => {
  const project = {
    narration: "这是很长的屏幕展示文本，但语音只读短标题。第二屏保持正常旁白。",
    narrationSegments: [
      { sceneIndex: 0, text: "这是很长的屏幕展示文本，但语音只读短标题。", ttsText: "短标题", durationSeconds: 1 },
      { sceneIndex: 1, text: "第二屏正常", durationSeconds: 2 },
    ],
  } as VideoProject;
  const metrics = narrationRateMetrics(project);
  assert.equal(metrics.narrationChars, 8);
  assert.deepEqual(metrics.segmentRates, [3, 2.5]);
});
