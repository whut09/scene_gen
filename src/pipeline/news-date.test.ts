import assert from "node:assert/strict";
import test from "node:test";
import { ensureNewsDateNarration, projectNewsDate } from "./news-date";
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
