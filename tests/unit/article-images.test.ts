import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { extractArticleImageCandidates, hasWatermarkSignal } from "../../src/pipeline/article-images";
import { applyArticleImageEvidence } from "../../src/pipeline/story";
import type { VideoProject } from "../../src/pipeline/types";

test("article image extraction keeps editorial images and drops UI assets", () => {
  const dom = new JSDOM(`
    <article>
      <img src="/images/story.jpg" alt="产品操作界面">
      <img src="/images/story.jpg" alt="重复图片">
      <img src="/images/avatar.png" class="author-avatar" alt="作者头像">
    </article>
  `);
  assert.deepEqual(extractArticleImageCandidates(dom.window.document, "https://www.ithome.com/0/996/265.htm"), [
    { alt: "产品操作界面", url: "https://www.ithome.com/images/story.jpg", watermarkHint: "" },
  ]);
});

test("watermark screening checks image metadata without rejecting the publisher domain", () => {
  assert.equal(hasWatermarkSignal("产品界面 /images/story.jpg"), false);
  assert.equal(hasWatermarkSignal("产品界面 /images/story.jpg?x-image-process=watermark"), true);
  assert.equal(hasWatermarkSignal("产品界面 data-vmark=5341"), true);
  assert.equal(hasWatermarkSignal("右下角版权水印"), true);
});

test("screened article images become a news evidence scene", () => {
  const project: VideoProject = {
    meta: { title: "测试新闻", createdAt: "2026-08-31T00:00:00.000Z", width: 1080, height: 1920, fps: 30, durationSeconds: 40, sourceCount: 1 },
    narration: "标题。\n重点一。\n重点二。",
    narrationSegments: [
      { sceneIndex: 0, text: "标题。" },
      { sceneIndex: 1, text: "重点一。" },
      { sceneIndex: 2, text: "重点二。" },
    ],
    scenes: [
      { type: "title", duration: 8, kicker: "新闻", headline: "测试新闻", subhead: "副标题", sources: [] },
      { type: "briefing_points", duration: 16, headline: "重点一", source: "", title: "重点一", summary: "重点一", points: ["事实"], metrics: [] },
      { type: "outro", duration: 16, headline: "重点二", bullets: ["结论"] },
    ],
    sources: [{ id: "source", kind: "webpage", contentType: "news", title: "测试新闻", url: "https://example.com/news", source: "example.com", summary: "摘要", score: 1, tags: [] }],
    screenshots: [],
    assets: [{ id: "image", kind: "image", role: "evidence", title: "产品界面", sourceUrl: "https://example.com/story.jpg", src: "/generated/story.jpg", contentType: "image/jpeg", license: "article-provided; watermark screen passed" }],
  };
  const result = applyArticleImageEvidence(project);
  assert.equal(result.scenes[2].type, "web_screenshot_zoom");
  assert.equal(result.narrationSegments?.[2].text, "重点二。");
  assert.match((result.scenes[2] as { headline: string }).headline, /重点二/u);
});
