import assert from "node:assert/strict";
import test from "node:test";
import { generationResultSchema } from "./story-manifest";
import { qualityJudgeResponseSchema, videoProjectSchema } from "./schemas";

function projectFixture() {
  return {
    meta: {
      title: "测试标题",
      createdAt: "2026-07-14T00:00:00.000Z",
      width: 1080,
      height: 1920,
      fps: 30,
      durationSeconds: 10,
      sourceCount: 1,
    },
    narration: "测试标题。这里是正文。",
    narrationSegments: [{ sceneIndex: 0, text: "测试标题。这里是正文。" }],
    scenes: [{
      type: "title" as const,
      duration: 10,
      kicker: "测试",
      headline: "测试标题",
      subhead: "正文",
      sources: ["核心事实"],
    }],
    sources: [{
      id: "source-1",
      kind: "webpage" as const,
      title: "测试标题",
      url: "https://example.com/news",
      source: "核心事实",
      summary: "测试摘要",
      score: 1,
      tags: ["test"],
    }],
  };
}

test("video project schema accepts a structurally valid project", () => {
  assert.equal(videoProjectSchema.parse(projectFixture()).meta.title, "测试标题");
});

test("video project schema rejects narration indexes that do not align with scenes", () => {
  const project = projectFixture();
  project.narrationSegments[0].sceneIndex = 2;
  assert.throws(() => videoProjectSchema.parse(project), /Expected sceneIndex 0/);
});

test("generation result requires explicit manifest and project paths", () => {
  assert.throws(() => generationResultSchema.parse({
    createdAt: "2026-07-14T00:00:00.000Z",
    cacheHit: true,
    manifestPath: "",
    stories: [],
  }));
});

test("quality judge requires structured issue protocol", () => {
  assert.throws(() => qualityJudgeResponseSchema.parse({ issues: ["vague title"] }));
  const parsed = qualityJudgeResponseSchema.parse({ issues: [{
    code: "title_vague",
    stage: "draft",
    severity: "warning",
    evidence: { summary: "title lacks a concrete subject" },
    repairAction: "regenerate-draft",
    retryable: true,
  }] });
  assert.equal(parsed.issues?.[0].code, "title_vague");
});
