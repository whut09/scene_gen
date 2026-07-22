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
