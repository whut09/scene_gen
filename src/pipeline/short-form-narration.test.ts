import assert from "node:assert/strict";
import test from "node:test";
import { compactProjectNarration } from "./story";
import type { VideoProject } from "./types";

test("short-form narration compacts complete sentences and invalidates derived TTS fields", () => {
  const first = "这是完整标题和第一条核心事实。新闻日期：2026年8月6日。";
  const repeated = "这是一段不应继续保留的低价值重复说明。".repeat(5);
  const project = {
    meta: { title: "测试标题", createdAt: "2026-08-06T00:00:00.000Z", width: 1080, height: 1920, fps: 30, durationSeconds: 10, sourceCount: 1 },
    narration: first + repeated,
    narrationSegments: [{ sceneIndex: 0, text: first + repeated, ttsText: "stale", providerSynthesisText: "stale", providerSynthesisChunks: ["stale"] }],
    scenes: [{ type: "title", duration: 10, kicker: "测试", headline: "测试标题", subhead: "核心事实", sources: ["核心事实"] }],
    sources: [],
  } satisfies VideoProject;

  const compacted = compactProjectNarration(project);
  assert.ok(compacted.narrationSegments![0].text.length <= 78);
  assert.match(compacted.narrationSegments![0].text, /新闻日期：2026年8月6日。/);
  assert.doesNotMatch(compacted.narrationSegments![0].text, /[，、：；]$/u);
  assert.equal(compacted.narrationSegments![0].ttsText, undefined);
  assert.equal(compacted.narrationSegments![0].providerSynthesisText, undefined);
  assert.equal(compacted.narration, compacted.narrationSegments![0].text);
});
