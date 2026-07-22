import assert from "node:assert/strict";
import test from "node:test";
import { expectedVideoFileName, projectHomepageTitle } from "./output-naming";
import { ensureRepositoryProjectIdentity, repositoryProjectName } from "./repository-project";
import type { VideoProject } from "./types";

function fixture(): VideoProject {
  return {
    meta: { title: "中文项目标题", createdAt: "2026-07-22T00:00:00.000Z", width: 1080, height: 1920, fps: 30, durationSeconds: 10, sourceCount: 1 },
    narration: "中文项目标题。项目介绍。",
    narrationSegments: [{ sceneIndex: 0, text: "中文项目标题。项目介绍。" }],
    scenes: [{ type: "title", duration: 10, kicker: "项目速览", headline: "中文项目标题", subhead: "项目介绍", sources: ["事实"] }],
    sources: [{ id: "repo", kind: "github", title: "text-to-cad", url: "https://github.com/earthtojake/text-to-cad", source: "项目资料", summary: "项目介绍", score: 1, tags: [], repo: "earthtojake/text-to-cad", contentType: "repository" }],
  };
}

test("repository identity uses the original repository name", () => {
  const project = fixture();
  assert.equal(repositoryProjectName(project), "text-to-cad");
  const normalized = ensureRepositoryProjectIdentity(project);
  assert.equal(normalized.meta.title, "text-to-cad");
  assert.equal(normalized.scenes[0].type, "title");
  assert.equal((normalized.scenes[0] as Extract<typeof normalized.scenes[number], { type: "title" }>).headline, "开源项目推荐：text-to-cad");
  assert.match(normalized.narrationSegments![0].text, /^text-to-cad，开源项目推荐。/u);
  assert.equal(projectHomepageTitle(normalized), "开源项目推荐：text-to-cad");
  assert.equal(expectedVideoFileName(normalized), "开源项目推荐：text-to-cad.mp4");
});
