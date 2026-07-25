import assert from "node:assert/strict";
import test from "node:test";
import type { VideoProject } from "../../pipeline/types";
import { narrationRateMetrics, ttsConventionIssues } from "./audio-rules";

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

test("proper-name guard accepts numeric speech normalization without translation", () => {
  const project = {
    meta: { title: "fixture", createdAt: "2026-07-25T00:00:00.000Z", width: 1080, height: 1920, fps: 30, durationSeconds: 5, sourceCount: 1 },
    narration: "Frontier-Bench v0.1 的结果已经公布。",
    narrationSegments: [{ sceneIndex: 0, text: "Frontier-Bench v0.1 的结果已经公布。", ttsText: "Frontier-Bench v零点一 的结果已经公布。" }],
    scenes: [{ type: "title" as const, duration: 5, kicker: "fixture", headline: "fixture", subhead: "fixture", sources: ["fixture"] }],
    sources: [],
  } satisfies VideoProject;

  assert.equal(ttsConventionIssues(project).some((issue) => issue.code === "tts_proper_name_translated"), false);
});
