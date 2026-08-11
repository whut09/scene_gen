import assert from "node:assert/strict";
import test from "node:test";
import { createFixtureProject } from "../../../tests/fixtures/project";
import { evaluateDraft } from "./draft-rules";

test("draft gate rejects long news targets and missing early value", async () => {
  const project = createFixtureProject();
  const result = await evaluateDraft(project, 75, "");
  assert.equal(result.issues.some((issue) => issue.code === "platform_duration_mismatch"), true);
  assert.equal(result.issues.some((issue) => issue.code === "hook_value_missing"), true);
});

test("draft gate reports a title repeated anywhere in narration", async () => {
  const project = createFixtureProject({
    narration: "开源视频生成工具发布新版本。它直接减少重复操作。开源视频生成工具发布新版本。",
    narrationSegments: [{
      sceneIndex: 0,
      text: "开源视频生成工具发布新版本。它直接减少重复操作。开源视频生成工具发布新版本。",
      audioStartSeconds: 0,
      durationSeconds: 10,
    }],
  });
  const result = await evaluateDraft(project, 40, "");
  assert.equal(result.issues.some((issue) => issue.code === "title_repeated_in_narration"), true);
});

test("draft gate allows repository names after one complete opening title", async () => {
  const project = createFixtureProject({
    meta: {
      title: "witr",
      createdAt: "2026-08-08T00:00:00.000Z",
      width: 1080,
      height: 1920,
      fps: 30,
      durationSeconds: 10,
      sourceCount: 1,
    },
    sources: [{
      id: "source-1",
      kind: "github",
      title: "witr",
      url: "https://github.com/pranshuparmar/witr",
      source: "GitHub",
      summary: "A process investigation tool.",
      score: 100,
      tags: ["repository"],
      repo: "pranshuparmar/witr",
    }],
    narration: "开源项目推荐：witr。端口被占用时，它能追溯启动源头。witr 会串起父子进程和命令参数。",
    narrationSegments: [{
      sceneIndex: 0,
      text: "开源项目推荐：witr。端口被占用时，它能追溯启动源头。witr 会串起父子进程和命令参数。",
      audioStartSeconds: 0,
      durationSeconds: 10,
    }],
  });
  const result = await evaluateDraft(project, 40, "");
  assert.equal(result.issues.some((issue) => issue.code === "title_repeated_in_narration"), false);
});

test("draft gate rejects cleanup-created dangling narration fragments", async () => {
  const project = createFixtureProject({
    narration: "技术说明。并为生成文件附加。实际使用还要结合检测工具，以及其他。三周内继续迭代后。",
    narrationSegments: [{
      sceneIndex: 0,
      text: "技术说明。并为生成文件附加。实际使用还要结合检测工具，以及其他。三周内继续迭代后。",
      audioStartSeconds: 0,
      durationSeconds: 10,
    }],
  });
  const result = await evaluateDraft(project, 40, "");
  assert.equal(result.issues.some((issue) => issue.code === "narration_truncated_fragment"), true);
});

test("draft gate recognizes prevention value in a long source title", async () => {
  const title = "Anthropic为Claude文本添加隐形水印 防范AI内容冒充原创";
  const project = createFixtureProject({
    meta: { title, createdAt: "2026-08-11T00:00:00.000Z", width: 1080, height: 1920, fps: 30, durationSeconds: 40, sourceCount: 1 },
    sources: [{ id: "source-1", kind: "webpage", contentType: "technical-article", title, url: "https://example.com/watermark", source: "技术资料", summary: "文本水印用于防范内容冒充原创。", score: 1, tags: [] }],
    narration: `${title}。它把可检测特征写进文本结构。`,
    narrationSegments: [{ sceneIndex: 0, text: `${title}。它把可检测特征写进文本结构。`, audioStartSeconds: 0, durationSeconds: 10 }],
  });
  const result = await evaluateDraft(project, 40, "");
  assert.equal(result.issues.some((issue) => issue.code === "value_revealed_too_late"), false);
});
