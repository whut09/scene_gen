import assert from "node:assert/strict";
import test from "node:test";
import { createStoryProject, splitArticleIntoSemanticChunks } from "./story";
import type { HotItem } from "./types";

test("general news fallback creates five grounded scenes", () => {
  const sentences = Array.from({ length: 12 }, (_, index) => `这是新闻正文中的第${index + 1}条完整事实描述，用于验证降级生成仍然保持事实引用和逐屏旁白。`).join("");
  const item: HotItem = {
    id: "fallback-news",
    kind: "webpage",
    title: "演员会被取代吗？平台总裁表示：AI无法取代真人演员",
    url: "https://example.com/news",
    source: "Example",
    summary: "人工智能工具正在影响影视创作流程，但创作者仍然保持核心作用。",
    content: sentences,
    publishedAt: "2026-07-17T04:26:11.000Z",
    score: 54,
    tags: ["AI", "影视"],
    domain: "example.com",
  };
  const project = createStoryProject(item);
  assert.equal(project.scenes.length, 5);
  assert.equal(project.narrationSegments?.length, 5);
  assert.equal(project.scenes.every((scene) => (scene.claimIds?.length ?? 0) > 0), true);
  assert.equal(project.narrationSegments?.every((segment) => (segment.claimIds?.length ?? 0) > 0), true);
  assert.equal([...project.narration].length >= 360, true);
  assert.equal(project.meta.title.includes("演员会被取代吗"), false);
  assert.equal(project.meta.title.includes("AI"), true);
  assert.equal(project.narrationSegments?.some((segment) => segment.ttsText?.includes("AI")), true);
  assert.equal(project.narrationSegments?.[0].ttsText?.includes("这条新闻讲的是"), false);
});

test("semantic article chunks never end with a dangling conjunction", () => {
  const text = "\u771f\u4eba\u6f14\u5458\u7684\u4ef7\u503c\u6b63\u662f\u56e0\u4e3a\uff0c\u521b\u4f5c\u4e2d\u7684\u5224\u65ad\u3001\u7ecf\u9a8c\u548c\u60c5\u611f\u65e0\u6cd5\u88ab\u7b80\u5355\u66ff\u4ee3\u3002\u6280\u672f\u53ef\u4ee5\u52a0\u901f\u6d41\u7a0b\uff0c\u4f46\u662f\u4e0d\u80fd\u53d6\u4ee3\u4eba\u7684\u8d23\u4efb\u3002";
  const chunks = splitArticleIntoSemanticChunks(text, 24);
  assert.equal(chunks.some((chunk) => /(?:\u6b63\u662f\u56e0\u4e3a|\u56e0\u4e3a|\u4f46\u662f|\u6240\u4ee5)$/u.test(chunk)), false);
  assert.match(chunks.at(-1) ?? "", /[\u3002\uff01\uff1f\uff1b]$/u);
});

test("technical article fallback uses explainer structure without news wording", () => {
  const content = Array.from({ length: 12 }, (_, index) => `\u8fd9\u662f\u6280\u672f\u6587\u7ae0\u7684\u7b2c${index + 1}\u4e2a\u5b8c\u6574\u63a8\u5bfc\u6b65\u9aa4\uff0c\u7528\u4e8e\u8bf4\u660e\u6570\u636e\u3001\u5047\u8bbe\u3001\u8ba1\u7b97\u548c\u7ed3\u8bba\u8fb9\u754c\u3002`).join("");
  const item: HotItem = {
    id: "technical-article",
    kind: "webpage",
    contentType: "technical-article",
    title: "\u5229\u7528\u6570\u636e\u4e0e\u8ba1\u7b97\u79d1\u5b66\u63a8\u7b97\u8d4c\u6ce8",
    url: "https://cloud.tencent.com/developer/article/2710377",
    source: "cloud.tencent.com",
    summary: "\u6587\u7ae0\u4ece\u6982\u7387\u548c\u6570\u636e\u51fa\u53d1\uff0c\u5c55\u793a\u5982\u4f55\u5efa\u7acb\u8ba1\u7b97\u8fc7\u7a0b\u3002",
    content,
    publishedAt: "2026-07-17T04:26:11.000Z",
    score: 50,
    tags: ["algorithm"],
  };
  const project = createStoryProject(item);
  assert.equal(project.scenes.length, 5);
  assert.equal(project.scenes[0].type, "title");
  assert.equal(project.scenes[0].kicker, "TECH / EXPLAINER");
  assert.equal(project.narration.includes("\u65b0\u95fb\u65e5\u671f"), false);
  assert.equal(project.narration.includes("\u8fd9\u6761\u65b0\u95fb"), false);
  assert.equal(project.narrationSegments?.[0]?.ttsText?.includes("\u8fd9\u7bc7\u6280\u672f\u6587\u7ae0\u8ba8\u8bba\u7684\u662f"), false);
});
