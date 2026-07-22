import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { generationResultSchema } from "./story-manifest";
import { fromRoot } from "./utils";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

test("GitHub cache writes an explicit run-scoped generation result", async () => {
  const cacheId = randomUUID().replace(/-/g, "");
  const repo = `scene-gen-tests/cache-${cacheId}`;
  const projectName = `cache-${cacheId}`;
  const sourceUrl = `https://github.com/${repo}`;
  const storiesDir = fromRoot("public", "generated", "stories");
  const cachedProjectPath = path.join(storiesDir, `cache-${cacheId}.json`);
  const runDir = await mkdtemp(path.join(tmpdir(), "scene-gen-cache-run-"));
  const resultPath = path.join(runDir, "generation-result.json");
  await mkdir(storiesDir, { recursive: true });
  await writeFile(cachedProjectPath, JSON.stringify({
    meta: {
      title: projectName,
      createdAt: "2026-07-14T00:00:00.000Z",
      width: 1080,
      height: 1920,
      fps: 30,
      durationSeconds: 10,
      sourceCount: 1,
    },
    narration: `${projectName}，开源项目推荐。Cache fixture。`,
    narrationSegments: [{ sceneIndex: 0, text: `${projectName}，开源项目推荐。Cache fixture。` }],
    scenes: [{
      type: "title",
      duration: 10,
      kicker: "TEST",
      headline: `开源项目推荐：${projectName}`,
      subhead: "Cache fixture",
      sources: [repo],
    }],
    sources: [{
      id: cacheId,
      kind: "github",
      title: `Cache ${cacheId}`,
      url: sourceUrl,
      source: repo,
      summary: "Cache fixture",
      score: 1,
      tags: ["test"],
      repo,
    }],
  }), "utf8");

  try {
    await execFileAsync(process.execPath, [
      tsxCli,
      fromRoot("src", "pipeline", "generate-stories.ts"),
      "--url", sourceUrl,
      "--url-only",
      "--count", "1",
      "--skip-tts",
      "--run-dir", runDir,
      "--result-file", resultPath,
    ], { cwd: fromRoot(), windowsHide: true });

    const result = generationResultSchema.parse(JSON.parse(await readFile(resultPath, "utf8")));
    assert.equal(result.cacheHit, true);
    assert.equal(result.stories[0].sourceUrl, sourceUrl);
    assert.equal(path.dirname(path.dirname(result.stories[0].projectPath)), runDir);
    assert.notEqual(result.stories[0].projectPath, cachedProjectPath);
  } finally {
    await rm(cachedProjectPath, { force: true });
    await rm(runDir, { recursive: true, force: true });
  }
});
