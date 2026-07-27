import assert from "node:assert/strict";
import test from "node:test";
import type { VideoProject } from "../pipeline/types";
import { evaluateDraft } from "./quality/draft-rules";

function project(): VideoProject {
  return {
    meta: { title: "中文改写标题", createdAt: "2026-07-22T00:00:00.000Z", width: 1080, height: 1920, fps: 30, durationSeconds: 12, sourceCount: 1 },
    narration: "中文改写标题。介绍项目能力和使用边界。",
    narrationSegments: [{ sceneIndex: 0, text: "中文改写标题。介绍项目能力和使用边界。" }],
    scenes: [{ type: "title", duration: 12, kicker: "项目速览", headline: "中文改写标题", subhead: "能力与边界", sources: ["项目资料"] }],
    sources: [{ id: "repo", kind: "github", title: "ai-agent-book", url: "https://github.com/bojieli/ai-agent-book", source: "项目资料", summary: "介绍项目能力和使用边界", score: 1, tags: [], repo: "bojieli/ai-agent-book", contentType: "repository" }],
  };
}

test("repository draft gate requires recommendation banner and original name", async () => {
  const result = await evaluateDraft(project(), 12, "");
  assert.equal(result.issues.some((issue) => issue.code === "repository_recommendation_missing"), true);
  assert.equal(result.issues.some((issue) => issue.code === "repository_name_not_canonical"), true);
  assert.equal(result.issues.some((issue) => issue.code === "repository_name_not_spoken_first"), true);
});

test("repository draft gate accepts the canonical recommendation opening", async () => {
  const value = project();
  value.meta.title = "ai-agent-book";
  value.scenes[0] = { type: "title", duration: value.scenes[0].duration, kicker: "开源项目推荐", headline: "开源项目推荐：ai-agent-book", subhead: "面向非技术读者的智能体实践", sources: ["项目资料"] };
  value.narrationSegments![0].text = "开源项目推荐：ai-agent-book。它帮助非技术读者理解智能体的用途和实践方法。";
  value.narration = value.narrationSegments![0].text;

  const result = await evaluateDraft(value, 12, "");

  assert.equal(result.issues.some((issue) => issue.code === "repository_name_not_spoken_first"), false);
  assert.equal(result.issues.some((issue) => issue.code === "title_not_spoken_first"), false);
});
