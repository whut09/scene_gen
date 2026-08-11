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

test("focused news compaction matches draft gate scene limits", () => {
  const repeated = "这段事实用于验证新闻旁白压缩后仍然保持完整句子。".repeat(8);
  const project = {
    meta: { title: "新闻标题", createdAt: "2026-08-11T00:00:00.000Z", width: 1080, height: 1920, fps: 30, durationSeconds: 60, sourceCount: 1 },
    narration: repeated,
    narrationSegments: [
      { sceneIndex: 0, text: repeated },
      { sceneIndex: 1, text: repeated },
      { sceneIndex: 2, text: repeated },
    ],
    scenes: [
      { type: "title", duration: 15, kicker: "新闻", headline: "新闻标题", subhead: "核心变化", sources: ["事实"] },
      { type: "briefing_points", duration: 25, headline: "证据", source: "事实", title: "证据", summary: "摘要", points: ["事实"], metrics: [{ label: "类型", value: "事实" }] },
      { type: "outro", duration: 20, headline: "结论", bullets: ["边界"] },
    ],
    sources: [{ id: "news", kind: "webpage", contentType: "news", title: "新闻标题", url: "https://example.com/news", source: "核心事实", summary: "摘要", score: 1, tags: [] }],
  } satisfies VideoProject;

  const compacted = compactProjectNarration(project);
  assert.ok(compacted.narrationSegments![0].text.length <= 80);
  assert.ok(compacted.narrationSegments![1].text.length <= 110);
  assert.ok(compacted.narrationSegments![2].text.length <= 80);
});

test("technical article compaction preserves enough connected narration", () => {
  const paragraphs = [
    "文章先说明隐形水印要解决的原创归属问题。",
    "系统会在不明显改变阅读体验的情况下嵌入统计特征。",
    "检测端需要知道对应规则才能判断文本是否来自模型。",
    "这种方法不能单独证明作者身份，也可能受到改写影响。",
  ];
  const project = {
    meta: { title: "文本隐形水印如何工作", createdAt: "2026-08-11T00:00:00.000Z", width: 1080, height: 1920, fps: 30, durationSeconds: 60, sourceCount: 1 },
    narration: paragraphs.join(""),
    narrationSegments: Array.from({ length: 5 }, (_, sceneIndex) => ({ sceneIndex, text: paragraphs.join("") })),
    scenes: [
      { type: "title", duration: 10, kicker: "技术解读", headline: "文本隐形水印如何工作", subhead: "识别模型生成内容", sources: ["问题"] },
      { type: "briefing_points", duration: 14, headline: "问题", source: "核心事实", title: "问题", summary: "摘要", points: paragraphs, metrics: [{ label: "目标", value: "识别" }] },
      { type: "flow", duration: 13, headline: "流程", steps: paragraphs.map((detail, index) => ({ label: `步骤${index + 1}`, detail })) },
      { type: "briefing_points", duration: 13, headline: "实现", source: "核心事实", title: "实现", summary: "摘要", points: paragraphs, metrics: [{ label: "方式", value: "统计特征" }] },
      { type: "outro", duration: 10, headline: "边界", bullets: paragraphs },
    ],
    sources: [{ id: "article", kind: "webpage", contentType: "technical-article", title: "文本隐形水印如何工作", url: "https://example.com/article", source: "核心事实", summary: "摘要", score: 1, tags: [] }],
  } satisfies VideoProject;

  const compacted = compactProjectNarration(project);
  assert.ok(compacted.narration.replace(/\s+/g, "").length >= 252);
  assert.ok(compacted.narrationSegments![0].text.length <= 80);
  assert.ok(compacted.narrationSegments![4].text.length <= 95);
});
