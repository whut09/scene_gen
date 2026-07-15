import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { improveWithOpenAI } from "../../src/pipeline/llm";
import { createFixtureProject } from "../fixtures/project";
import { buildFactLedger } from "../../src/pipeline/fact-ledger";

test("fixed article is directed by a mocked OpenAI-compatible response", async () => {
  let requestBody = "";
  const claimIds = buildFactLedger(createFixtureProject().sources).claims.map((claim) => claim.id);
  const response = {
    title: "开源视频工具升级离线质量门禁",
    titleClaimIds: [claimIds[0]],
    sections: [
      { claimIds: [claimIds[0]], narration: "本次更新先说明离线质量门禁。", kicker: "工程更新", subhead: "固定文章离线集成测试", keywords: ["离线", "质量", "视频"] },
      { claimIds: [claimIds[1]], narration: "第一步验证固定文章事实。", headline: "固定事实进入结构化脚本", summary: "文章明确描述模板、缓存和门禁改进。", metrics: [{ label: "模式", value: "离线" }, { label: "输入", value: "固定文章" }], points: ["不访问真实模型", "保留文章事实"] },
      { claimIds: [claimIds[1]], narration: "第二步比较三个验证层。", headline: "三个验证层覆盖关键边界", bars: [{ label: "单元", value: 80, detail: "纯函数与规则" }, { label: "媒体", value: 70, detail: "音视频门禁" }, { label: "模板", value: 60, detail: "截图与安全区" }] },
      { claimIds: [claimIds[1]], narration: "第三步串联生成检查发布。", headline: "离线流程串联关键阶段", steps: [{ label: "生成", detail: "模拟模型响应" }, { label: "检查", detail: "运行质量门禁" }, { label: "发布", detail: "输出可审计结果" }] },
      { claimIds: [claimIds[1]], narration: "最终结论是离线测试可以稳定复现。", headline: "离线验证降低回归风险", bullets: ["固定输入便于复现", "模拟响应不消耗 API"] },
    ],
  };
  const server = createServer((request, reply) => {
    request.setEncoding("utf8");
    request.on("data", (chunk) => { requestBody += chunk; });
    request.on("end", () => {
      reply.writeHead(200, { "content-type": "application/json" });
      reply.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock LLM server did not bind to a TCP port.");

  const previous = {
    key: process.env.NEWS_LLM_API_KEY,
    baseUrl: process.env.NEWS_LLM_BASE_URL,
    model: process.env.NEWS_LLM_MODEL,
  };
  process.env.NEWS_LLM_API_KEY = "offline-test-key";
  process.env.NEWS_LLM_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.NEWS_LLM_MODEL = "offline-mock";
  try {
    const result = await improveWithOpenAI(createFixtureProject(), { targetSeconds: 90 });
    const parsedRequest = JSON.parse(requestBody) as { model?: string; messages?: Array<{ content?: string }> };
    assert.equal(parsedRequest.model, "offline-mock");
    assert.match(parsedRequest.messages?.at(-1)?.content ?? "", /开源视频生成工具发布新版本/);
    assert.match(parsedRequest.messages?.at(-1)?.content ?? "", /factLedger/);
    assert.equal(result.scenes.length, 5);
    assert.equal(result.meta.title, response.title);
    assert.equal(result.narrationSegments?.[0].text.startsWith(response.title), true);
    assert.equal(result.scenes[1].type, "briefing_points");
    assert.equal(result.factLedger?.claims.length, claimIds.length);
    assert.deepEqual(result.titleClaimIds, [claimIds[0]]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previous.key === undefined) delete process.env.NEWS_LLM_API_KEY; else process.env.NEWS_LLM_API_KEY = previous.key;
    if (previous.baseUrl === undefined) delete process.env.NEWS_LLM_BASE_URL; else process.env.NEWS_LLM_BASE_URL = previous.baseUrl;
    if (previous.model === undefined) delete process.env.NEWS_LLM_MODEL; else process.env.NEWS_LLM_MODEL = previous.model;
  }
});
