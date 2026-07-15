import type { VideoProject } from "../../src/pipeline/types";

export function createFixtureProject(overrides: Partial<VideoProject> = {}): VideoProject {
  const project: VideoProject = {
    meta: {
      title: "开源视频生成工具发布新版本",
      createdAt: "2026-07-15T00:00:00.000Z",
      width: 1080,
      height: 1920,
      fps: 30,
      durationSeconds: 10,
      sourceCount: 1,
    },
    narration: "开源视频生成工具发布新版本。它改进了模板选择与离线验证流程。",
    narrationSegments: [{
      sceneIndex: 0,
      text: "开源视频生成工具发布新版本。它改进了模板选择与离线验证流程。",
      audioStartSeconds: 0,
      durationSeconds: 10,
    }],
    scenes: [{
      type: "title",
      duration: 10,
      kicker: "工程更新",
      headline: "开源视频生成工具发布新版本",
      subhead: "模板、缓存与质量门禁同步改进",
      sources: ["固定测试文章"],
    }],
    sources: [{
      id: "fixed-article",
      kind: "webpage",
      title: "开源视频生成工具发布新版本",
      url: "https://example.com/fixed-article",
      source: "固定测试文章",
      summary: "新版本改进模板选择、缓存隔离与质量门禁。",
      content: "项目发布新版本，重点改进模板选择、缓存隔离、离线测试和质量门禁。",
      score: 100,
      tags: ["video", "testing", "release"],
    }],
  };
  return {
    ...project,
    ...overrides,
    meta: { ...project.meta, ...overrides.meta },
  };
}
