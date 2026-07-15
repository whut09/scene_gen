import assert from "node:assert/strict";
import test from "node:test";
import { attachFactReferences, buildFactLedger } from "../pipeline/fact-ledger";
import type { VideoProject } from "../pipeline/types";
import { evaluateDraft } from "./quality";

test("draft gate rejects unsupported actions and dropped qualifiers", async () => {
  const source = {
    id: "source-1", kind: "webpage" as const, title: "产品测试", url: "https://example.com/product", source: "测试来源",
    summary: "产品仅向部分用户开放。", content: "实验结果显示产品仅向部分用户开放，仍需进一步验证。", score: 1, tags: [],
  };
  const ledger = buildFactLedger([source]);
  const claim = ledger.claims.find((item) => item.evidenceText.includes("部分用户开放"));
  assert.ok(claim);
  const project = attachFactReferences({
    meta: { title: "产品正式发布并向用户开放", createdAt: "2026-07-15T00:00:00.000Z", width: 1080, height: 1920, fps: 30, durationSeconds: 10, sourceCount: 1 },
    narration: "产品正式发布并向用户开放。",
    narrationSegments: [{ sceneIndex: 0, text: "产品正式发布并向用户开放。", claimIds: [claim.id] }],
    scenes: [{ type: "title", duration: 10, kicker: "产品更新", headline: "产品正式发布并向用户开放", subhead: "测试结果", sources: ["测试来源"], claimIds: [claim.id] }],
    sources: [source], factLedger: ledger, titleClaimIds: [claim.id],
  } satisfies VideoProject);
  const previousKey = process.env.NEWS_LLM_API_KEY;
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  delete process.env.NEWS_LLM_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const evaluation = await evaluateDraft(project, 10, "");
    const codes = new Set(evaluation.issues.map((issue) => issue.code));
    assert.equal(codes.has("scene_high_risk_predicate_unverified"), true);
    assert.equal(codes.has("scene_fact_qualifier_dropped"), true);
  } finally {
    if (previousKey === undefined) delete process.env.NEWS_LLM_API_KEY; else process.env.NEWS_LLM_API_KEY = previousKey;
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousOpenAiKey;
  }
});
