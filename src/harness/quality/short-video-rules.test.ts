import assert from "node:assert/strict";
import test from "node:test";
import { createFixtureProject } from "../../../tests/fixtures/project";
import { evaluateDraft } from "./draft-rules";

test("draft gate rejects long news targets", async () => {
  const project = createFixtureProject();
  const result = await evaluateDraft(project, 75, "");
  assert.equal(result.issues.some((issue) => issue.code === "platform_duration_mismatch"), true);
});

test("draft gate rejects news narration that cannot finish within a scene", async () => {
  const project = createFixtureProject({
    meta: { ...createFixtureProject().meta, durationSeconds: 10 },
    scenes: [{ type: "title", duration: 3, kicker: "新闻", headline: "核心结果", subhead: "普通读者需要知道的变化", sources: ["事实"] }],
    narration: "这是一段超过当前画面时长的新闻旁白，需要完整讲清楚结果、影响、证据和限制，否则画面会在句子播完之前切换到下一屏。",
    narrationSegments: [{ sceneIndex: 0, text: "这是一段超过当前画面时长的新闻旁白，需要完整讲清楚结果、影响、证据和限制，否则画面会在句子播完之前切换到下一屏。" }],
  });
  const result = await evaluateDraft(project, 40, "");
  assert.equal(result.issues.some((issue) => issue.code === "narration_scene_overflow"), true);
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

test("draft gate rejects equivalent repository homepage titles repeated with different separators", async () => {
  const project = createFixtureProject({
    meta: { title: "diagram-design", createdAt: "2026-08-12T00:00:00.000Z", width: 1080, height: 1920, fps: 30, durationSeconds: 40, sourceCount: 1 },
    sources: [{ id: "source-1", kind: "github", title: "diagram-design", url: "https://github.com/cathrynlavery/diagram-design", source: "项目资料", summary: "让智能体生成专业技术图表", score: 100, tags: ["repository"], repo: "cathrynlavery/diagram-design", metrics: { stars: 8000 } }],
    scenes: [{ type: "title", duration: 10, kicker: "今日开源热点趋势项目推荐", headline: "今日开源热点趋势项目推荐：diagram-design｜让智能体生成专业技术图表", subhead: "用途：让智能体生成专业技术图表；适用场景：架构图", sources: ["8000 Stars"] }],
    narration: "今日开源热点趋势项目推荐：diagram-design｜让智能体生成专业技术图表。今日开源热点趋势项目推荐：diagram-design，让智能体生成专业技术图表。",
    narrationSegments: [{ sceneIndex: 0, text: "今日开源热点趋势项目推荐：diagram-design｜让智能体生成专业技术图表。今日开源热点趋势项目推荐：diagram-design，让智能体生成专业技术图表。" }],
  });
  const result = await evaluateDraft(project, 40, "");
  assert.equal(result.issues.some((issue) => issue.code === "title_repeated_in_narration"), true);
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

test("draft gate rejects generic narration filler in every synthesis field", async () => {
  const phrases = [
    "这意味着",
    "这说明",
    "这条新闻讲的是",
    "这条新闻说的是",
    "这条新闻的核心价值",
    "这条新闻真正的信号",
    "这条新闻的重点",
    "这次真正改变的是",
    "真正改变的是",
    "这条新闻真正说了什么",
    "对普通用户来说",
    "普通读者先看",
    "能不能让创作更简单",
    "用途：用于文字和推理任务",
    "用途：用于文字生成和推理任务",
  ];
  for (const phrase of phrases) {
    const project = createFixtureProject({
      scenes: [{ type: "title", duration: 10, kicker: "新闻", headline: "产品负责人创办新公司", subhead: `${phrase}：公司开始研发长期任务智能体。`, sources: ["事实"] }],
      narration: `产品负责人创办新公司。${phrase}：公司开始研发长期任务智能体。`,
      narrationSegments: [{
        sceneIndex: 0,
        text: "产品负责人创办新公司。公司开始研发长期任务智能体。",
        ttsText: `产品负责人创办新公司。${phrase}：公司开始研发长期任务智能体。`,
      }],
    });
    const result = await evaluateDraft(project, 40, "");
    assert.equal(result.issues.some((issue) => issue.code === "generic_transition_filler"), true, phrase);
  }
});

test("draft gate preserves the source news title and rejects article wording", async () => {
  const title = "刚刚，全球最强GPT-6 Astra来了，人类进入AGI时代";
  const project = createFixtureProject({
    meta: { title: "GPT-6 Astra 发布：评测、操作与开放限制", createdAt: "2026-09-04T00:00:00.000Z", width: 1080, height: 1920, fps: 30, durationSeconds: 40, sourceCount: 1 },
    sources: [{ id: "source-1", kind: "webpage", contentType: "news", title, url: "https://www.36kr.com/p/3968652629422337", source: "核心事实", summary: "模型发布和公开演示。", score: 1, tags: [] }],
    scenes: [{ type: "title", duration: 10, kicker: "模型发布", headline: "GPT-6 Astra 发布：评测、操作与开放限制", subhead: "文章披露了评测结果。", sources: ["公开信息"] }],
    narration: "GPT-6 Astra 发布：评测、操作与开放限制。",
    narrationSegments: [{ sceneIndex: 0, text: "GPT-6 Astra 发布：评测、操作与开放限制。文章披露了评测结果。" }],
  });
  const result = await evaluateDraft(project, 40, "");
  assert.equal(result.issues.some((issue) => issue.code === "source_title_not_preserved"), true);
  assert.equal(result.issues.some((issue) => issue.code === "news_article_wording_exposed"), true);
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

test("draft gate recognizes an immediate market-exit result without generic filler", async () => {
  const title = "批量博主集体停更，AI漫剧泡沫开始破裂";
  const project = createFixtureProject({
    meta: { title, createdAt: "2026-08-19T00:00:00.000Z", width: 1080, height: 1920, fps: 30, durationSeconds: 40, sourceCount: 1 },
    sources: [{ id: "source-1", kind: "webpage", contentType: "news", title, url: "https://example.com/news", source: "核心事实", summary: "粗放生产者正在退场。", score: 1, tags: [] }],
    narration: `${title}。监管收紧、成本上涨和低质内容失去流量，粗放生产者正在退场。`,
    narrationSegments: [{ sceneIndex: 0, text: `${title}。监管收紧、成本上涨和低质内容失去流量，粗放生产者正在退场。` }],
  });
  const result = await evaluateDraft(project, 40, "");
  assert.equal(result.issues.some((issue) => issue.code === "value_revealed_too_late"), false);
  assert.equal(result.issues.some((issue) => issue.code === "generic_transition_filler"), false);
});
