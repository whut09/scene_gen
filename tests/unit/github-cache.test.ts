import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findCompletedGithubCache, githubRepositoryKey } from "../../src/pipeline/github-cache";

function project(url: string) {
  return {
    meta: { title: "今日开源热点趋势项目推荐：heretic", createdAt: "2026-08-31T00:00:00.000Z", width: 1080, height: 1920, fps: 30, durationSeconds: 45, sourceCount: 1 },
    narration: "heretic",
    narrationSegments: [{ sceneIndex: 0, text: "heretic", ttsText: "heretic" }],
    scenes: [{ type: "title", duration: 45, kicker: "开源项目推荐", headline: "heretic", subhead: "研究工具", sources: ["项目资料"] }],
    sources: [{ id: "heretic", kind: "github", title: "heretic", url, source: "GitHub", summary: "summary", content: "content", publishedAt: "2026年8月31日", contentType: "repository", score: 1, tags: [], repo: "p-e-w/heretic" }],
  };
}

test("completed GitHub cache scans successful dist runs and returns the newest output", async () => {
  assert.equal(githubRepositoryKey("https://github.com/p-e-w/heretic"), "p-e-w/heretic");
  const root = await mkdtemp(path.join(os.tmpdir(), "scene-gen-github-cache-"));
  const storiesDir = path.join(root, "stories");
  const runsDir = path.join(root, "runs");
  await mkdir(storiesDir, { recursive: true });
  await mkdir(path.join(runsDir, "completed"), { recursive: true });
  const projectPath = path.join(runsDir, "completed", "project.json");
  const outputPath = path.join(runsDir, "completed", "heretic.mp4");
  await writeFile(projectPath, JSON.stringify(project("https://github.com/p-e-w/heretic")));
  await writeFile(outputPath, "mp4");
  await writeFile(path.join(runsDir, "completed", "run.json"), JSON.stringify({ status: "succeeded", artifacts: { projectPath, outputPath } }));
  const result = await findCompletedGithubCache({ url: "https://github.com/P-E-W/heretic/", storiesDir, runsDir, manifest: [] });
  assert.equal(result?.outputPath, outputPath);
  assert.equal(result?.project.sources[0]?.repo, "p-e-w/heretic");
});

test("incomplete GitHub runs are not cache hits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scene-gen-github-cache-"));
  const storiesDir = path.join(root, "stories");
  const runsDir = path.join(root, "runs");
  await mkdir(path.join(runsDir, "failed"), { recursive: true });
  await writeFile(path.join(runsDir, "failed", "run.json"), JSON.stringify({ status: "failed", artifacts: {} }));
  assert.equal(await findCompletedGithubCache({ url: "https://github.com/p-e-w/heretic", storiesDir, runsDir, manifest: [] }), null);
});
