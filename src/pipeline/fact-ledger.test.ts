import assert from "node:assert/strict";
import test from "node:test";
import { buildHtmlVideoContentGraph } from "../html-video/content-graph";
import { attachFactReferences, buildFactLedger, findFactConflicts, highRiskPredicatesInText, qualifiersInText } from "./fact-ledger";
import type { VideoProject } from "./types";

function projectFixture(): VideoProject {
  return {
    meta: { title: "工具向部分用户开放", createdAt: "2026-07-15T00:00:00.000Z", width: 1080, height: 1920, fps: 30, durationSeconds: 10, sourceCount: 2 },
    narration: "工具向部分用户开放，测试结果提升百分之四十二。",
    narrationSegments: [{ sceneIndex: 0, text: "工具向部分用户开放，测试结果提升百分之四十二。" }],
    scenes: [{ type: "title", duration: 10, kicker: "产品更新", headline: "工具向部分用户开放", subhead: "测试结果提升42%", sources: ["第二来源"] }],
    sources: [
      { id: "source-a", kind: "webpage", title: "工具更新", url: "https://example.com/a", source: "第一来源", summary: "工具仍在测试。", score: 1, tags: [] },
      { id: "source-b", kind: "webpage", title: "工具更新", url: "https://example.com/b", source: "第二来源", summary: "工具向部分用户开放。", content: "测试结果显示性能提升42%，但仍需进一步验证。", score: 1, tags: [] },
    ],
  };
}

test("fact ledger extracts stable claims from every source", () => {
  const ledger = buildFactLedger(projectFixture().sources);
  assert.equal(new Set(ledger.claims.map((claim) => claim.sourceId)).size, 2);
  assert.equal(ledger.claims.some((claim) => claim.evidenceText.includes("提升42%")), true);
  assert.equal(ledger.claims.some((claim) => claim.qualifiers.includes("部分用户")), true);
  assert.deepEqual(highRiskPredicatesInText("产品正式发布并开放"), ["正式发布", "发布", "开放"]);
  assert.deepEqual(qualifiersInText("仅向部分用户开放，仍需测试"), ["部分用户", "仅", "仍需"]);
});

test("content graph validates numbers against referenced claims instead of source zero", () => {
  const ledger = buildFactLedger(projectFixture().sources);
  const target = ledger.claims.find((claim) => claim.evidenceText.includes("提升42%"));
  assert.ok(target);
  const project = attachFactReferences({
    ...projectFixture(), factLedger: ledger, titleClaimIds: [target.id],
    scenes: [{ ...projectFixture().scenes[0], claimIds: [target.id] }],
    narrationSegments: [{ ...projectFixture().narrationSegments![0], claimIds: [target.id] }],
  });
  const evidence = buildHtmlVideoContentGraph(project).nodes[0].sourceEvidence;
  assert.deepEqual(evidence.sourceIds, ["source-b"]);
  assert.deepEqual(evidence.unmatchedNumbers, []);
  assert.deepEqual(evidence.claimIds, [target.id]);
});

test("fact ledger reports conflicting structured metrics", () => {
  const project = projectFixture();
  project.sources[0].metrics = { users: "100万" };
  project.sources[1].metrics = { users: "120万" };
  const conflicts = findFactConflicts(buildFactLedger(project.sources));
  assert.equal(conflicts.length, 1);
  assert.deepEqual(new Set(conflicts[0].map((claim) => claim.value)), new Set(["100万", "120万"]));
});
