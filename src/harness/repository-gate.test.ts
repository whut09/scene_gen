import assert from "node:assert/strict";
import test from "node:test";
import { createStoryProject } from "../pipeline/story";
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
  assert.equal(result.issues.some((issue) => issue.code === "repository_promotion_structure_missing"), true);
});

test("repository draft gate accepts the canonical recommendation opening", async () => {
  const value = project();
  value.meta.title = "ai-agent-book";
  value.scenes[0] = { type: "title", duration: value.scenes[0].duration, kicker: "今日开源热点趋势项目推荐", headline: "今日开源热点趋势项目推荐：ai-agent-book", subhead: "面向非技术读者的智能体实践", sources: ["项目资料"] };
  value.narrationSegments![0].text = "开源项目推荐：ai-agent-book。它帮助非技术读者理解智能体的用途和实践方法。";
  value.narration = value.narrationSegments![0].text;

  const result = await evaluateDraft(value, 12, "");

  assert.equal(result.issues.some((issue) => issue.code === "repository_name_not_spoken_first"), false);
  assert.equal(result.issues.some((issue) => issue.code === "title_not_spoken_first"), false);
  assert.equal(result.issues.some((issue) => issue.code === "repository_date_spoken"), false);
});

test("generated repository recommendation follows the promotion structure", async () => {
  const value = createStoryProject({
    id: "voicebox", kind: "github", contentType: "repository", title: "voicebox: local-first voice studio",
    url: "https://github.com/jamiepine/voicebox", source: "项目资料", summary: "Local-first voice studio",
    content: "Local-first voice studio with voice cloning, dictation and story editing.", score: 1, tags: [], repo: "jamiepine/voicebox", metrics: { stars: 48_672 },
  });

  const result = await evaluateDraft(value, value.meta.durationSeconds, "");

  assert.equal(result.issues.some((issue) => issue.code === "repository_promotion_structure_missing"), false);
  assert.deepEqual(value.scenes.map((scene) => scene.headline), [
    "今日开源热点趋势项目推荐：voicebox",
    "先看它替你省掉什么麻烦",
    "核心价值、证据和使用前提",
    "怎么开始，什么情况别急",
  ]);
  assert.equal(value.meta.durationSeconds >= 40 && value.meta.durationSeconds <= 55, true);
});

test("stock analysis repository cannot fall through to the PCB profile", async () => {
  const value = createStoryProject({
    id: "daily-stock-analysis",
    kind: "github",
    contentType: "repository",
    title: "daily_stock_analysis: LLM-powered multi-market stock analysis system",
    url: "https://github.com/ZhuLinsen/daily_stock_analysis",
    source: "项目资料",
    summary: "多市场股票智能分析系统，支持行情、新闻、决策看板和自动推送。",
    content: "覆盖 A股、港股、美股、K 线、技术指标、公告、基本面和回测。示例新闻可能提到 AI PCB 微钻领域公司。",
    score: 1,
    tags: [],
    repo: "ZhuLinsen/daily_stock_analysis",
    metrics: { stars: 61_667 },
  });

  assert.match(value.narration, /多市场行情|股票分析报告/);
  assert.doesNotMatch(value.narration, /电路板|自动走线|板厂/);

  const result = await evaluateDraft(value, value.meta.durationSeconds, "");
  assert.equal(result.issues.some((issue) => issue.code === "repository_domain_mismatch"), false);
});

test("repository gate rejects stock sources rendered with PCB narration", async () => {
  const value = createStoryProject({
    id: "daily-stock-analysis",
    kind: "github",
    contentType: "repository",
    title: "daily_stock_analysis: multi-market stock analysis",
    url: "https://github.com/ZhuLinsen/daily_stock_analysis",
    source: "项目资料",
    summary: "多市场股票分析、行情、K线和决策看板。",
    content: "覆盖 A股、港股、美股、行情、K线、回测、买卖点和风险提示。",
    score: 1,
    tags: [],
    repo: "ZhuLinsen/daily_stock_analysis",
    metrics: { stars: 61_667 },
  });
  const wrongNarration = "开源项目推荐：daily_stock_analysis。它自动规划电路板走线，导入板图后设置禁布区，并检查高速信号和板厂规则。";
  value.narration = wrongNarration;
  value.narrationSegments = value.narrationSegments?.map((segment, index) => ({ ...segment, text: index === 0 ? wrongNarration : "自动走线完成后，还要核对板图和电路板生产规则。" }));

  const result = await evaluateDraft(value, value.meta.durationSeconds, "");
  assert.equal(result.issues.some((issue) => issue.code === "repository_domain_mismatch"), true);
});
