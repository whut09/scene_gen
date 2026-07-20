import assert from "node:assert/strict";
import test from "node:test";
import { ensureNewsDateNarration, ensureTitleSpokenFirst, isTechnicalArticleProject, normalizeProjectDatePrecision, projectNewsDate } from "./news-date";
import type { VideoProject } from "./types";

function project(kind: "webpage" | "github"): VideoProject {
  return {
    meta: { title: "中文新闻标题示例", createdAt: "2026-07-14T00:00:00.000Z", width: 1080, height: 1920, fps: 30, durationSeconds: 12, sourceCount: 1 },
    narration: "中文新闻标题示例。正文内容。",
    narrationSegments: [{ sceneIndex: 0, text: "中文新闻标题示例。正文内容。" }],
    scenes: [{ type: "title", duration: 12, kicker: "今日新闻", headline: "中文新闻标题示例", subhead: "副标题", sources: ["事实"] }],
    sources: [{ id: "one", kind, title: "来源标题", url: kind === "github" ? "https://github.com/a/b" : "https://example.com/news", source: "source", summary: "summary", publishedAt: "2026-07-13T16:30:00.000Z", score: 1, tags: [] }],
  };
}

test("news publication date is formatted in Asia/Shanghai and inserted after title", () => {
  const input = project("webpage");
  assert.equal(projectNewsDate(input), "2026年7月14日");
  const output = ensureNewsDateNarration(input);
  assert.equal(output.narrationSegments?.[0]?.text, "中文新闻标题示例。新闻日期：2026年7月14日。正文内容。");
});

test("GitHub projects do not receive a news date narration", () => {
  const input = project("github");
  assert.equal(projectNewsDate(input), "");
  assert.equal(ensureNewsDateNarration(input).narrationSegments?.[0]?.text, "中文新闻标题示例。正文内容。");
});

test("Tencent Cloud developer articles never receive a news date", () => {
  const input = project("webpage");
  input.sources[0] = {
    ...input.sources[0],
    url: "https://cloud.tencent.com/developer/article/2710377",
    contentType: "technical-article",
    publishedAt: "2026-07-17T04:26:11.000Z",
  };
  assert.equal(isTechnicalArticleProject(input), true);
  assert.equal(projectNewsDate(input), "");
  assert.equal(ensureNewsDateNarration(input).narrationSegments?.[0]?.text, input.narrationSegments?.[0]?.text);
});

test("technical article narration starts with the title without adding a date", () => {
  const input = project("webpage");
  input.sources[0] = { ...input.sources[0], contentType: "technical-article" };
  input.narrationSegments![0] = { sceneIndex: 0, text: "\u8fd9\u7bc7\u6280\u672f\u6587\u7ae0\u89e3\u91ca\u8ba1\u7b97\u65b9\u6cd5\u3002" };
  const output = ensureTitleSpokenFirst(input);
  assert.equal(output.narrationSegments?.[0]?.text.startsWith(input.meta.title), true);
  assert.equal(output.narrationSegments?.[0]?.text.includes("\u65b0\u95fb\u65e5\u671f"), false);
});

test("title-first policy removes an early duplicate title", () => {
  const input = project("webpage");
  input.sources[0] = { ...input.sources[0], contentType: "technical-article" };
  input.narrationSegments![0] = { sceneIndex: 0, text: `\u8fd9\u7bc7\u6280\u672f\u6587\u7ae0\u8ba8\u8bba\u7684\u662f\uff1a${input.meta.title}\u3002\u540e\u7eed\u89e3\u91ca\u8ba1\u7b97\u65b9\u6cd5\u3002` };
  const output = ensureTitleSpokenFirst(input);
  assert.equal(output.narrationSegments?.[0]?.text, `${input.meta.title}\u3002\u540e\u7eed\u89e3\u91ca\u8ba1\u7b97\u65b9\u6cd5\u3002`);
});

test("title-first policy removes a second exact title from the opening narration", () => {
  const input = project("webpage");
  input.narrationSegments![0] = {
    sceneIndex: 0,
    text: `${input.meta.title}。新闻日期：2026年7月20日。这条新闻讲的是：${input.meta.title}。正文。`,
    ttsText: `${input.meta.title}。新闻日期：二零二六年七月二十日。这条新闻讲的是：${input.meta.title}。正文。`,
  };
  const output = ensureTitleSpokenFirst(input);
  assert.equal(output.narrationSegments?.[0]?.text.includes(`这条新闻讲的是：${input.meta.title}`), false);
  assert.equal(output.narrationSegments?.[0]?.ttsText?.includes(`这条新闻讲的是：${input.meta.title}`), false);
  assert.equal(output.narrationSegments?.[0]?.text.includes("这条新闻讲的是：。"), false);
});


test("technical article removes publication metadata and exact timestamps", () => {
  const input = project("webpage");
  input.sources[0] = { ...input.sources[0], url: "https://cloud.tencent.com/developer/article/2709808", contentType: "technical-article" };
  input.narrationSegments![0] = { sceneIndex: 0, text: "技术正文。新闻日期：2026年7月18日。发布于2026-07-15 14:53:43。" };
  const titleScene = input.scenes[0];
  if (titleScene.type !== "title") throw new Error("Expected title scene fixture.");
  input.scenes[0] = { ...titleScene, subhead: "技术正文发布于2026-07-15T14:53:43.427Z" };
  const output = normalizeProjectDatePrecision(input);
  assert.equal(output.narrationSegments?.[0]?.text.includes("新闻日期"), false);
  assert.equal(output.narrationSegments?.[0]?.text.includes("14:53"), false);
  assert.equal((output.scenes[0] as { subhead: string }).subhead.includes("发布于"), false);
});
