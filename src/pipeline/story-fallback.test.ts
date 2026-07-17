import assert from "node:assert/strict";
import test from "node:test";
import { createStoryProject } from "./story";
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
  assert.equal(project.meta.title.includes("人工智能"), true);
  assert.equal(project.narrationSegments?.every((segment) => !segment.ttsText?.includes("AI")), true);
  assert.equal(project.narrationSegments?.[0].ttsText, `这条新闻讲的是，${project.meta.title}。`);
});
