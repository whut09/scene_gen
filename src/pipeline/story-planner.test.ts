import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildFactLedger } from "./fact-ledger";
import { rankStoryPlanCandidates, recordStoryPlanOutcome, resolveStoryPlanCandidateCount, storyPlanFingerprint } from "./story-planner";
import type { StoryPlanCandidate, VideoProject } from "./types";

const source = { id: "source", kind: "webpage" as const, title: "工具发布更新", url: "https://example.com", source: "来源", summary: "工具发布更新并提升离线质量。", content: "工具发布更新，增加缓存检查，提升离线质量，并保留验证边界。", score: 1, tags: [] };
const ledger = buildFactLedger([source]);
const claimIds = ledger.claims.map((claim) => claim.id);

function candidate(id: string, angle: string): StoryPlanCandidate {
  return {
    id, angle, title: "工具发布更新提升离线质量", titleClaimIds: claimIds, estimatedSeconds: 90,
    scenes: [
      { visual: "title", purpose: "开场", focus: "工具更新与质量提升", claimIds },
      { visual: "briefing", purpose: "事实", focus: "缓存检查进入生成链路", claimIds: [claimIds[1] ?? claimIds[0]] },
      { visual: "chart", purpose: "比较", focus: "质量覆盖维度对比", claimIds: [claimIds[1] ?? claimIds[0]] },
      { visual: "flow", purpose: "流程", focus: "生成检查输出流程", claimIds: [claimIds[1] ?? claimIds[0]] },
      { visual: "outro", purpose: "结论", focus: "验证边界与适用范围", claimIds: [claimIds.at(-1)!] },
    ],
  };
}

test("story plan candidate count follows profiles and rejects invalid overrides", () => {
  assert.equal(resolveStoryPlanCandidateCount("fast-preview", undefined), 1);
  assert.equal(resolveStoryPlanCandidateCount("local-f5", undefined), 2);
  assert.equal(resolveStoryPlanCandidateCount("production", undefined), 4);
  assert.equal(resolveStoryPlanCandidateCount("production", "3"), 3);
  assert.throws(() => resolveStoryPlanCandidateCount("production", "5"));
});

test("deterministic ranking rejects duplicate scenes and unknown claims", () => {
  const invalid = candidate("invalid", "重复方案");
  invalid.scenes = invalid.scenes.map((scene) => ({ ...scene, focus: "相同重点" }));
  invalid.scenes[0].claimIds = ["fact-missing"];
  const valid = candidate("valid", "证据优先方案");
  const rankings = rankStoryPlanCandidates([invalid, valid], ledger, 90);
  assert.equal(rankings[0].candidate.id, "valid");
  assert.equal(rankings[0].rejectedReasons.length, 0);
  assert.equal(rankings[1].rejectedReasons.includes("duplicate-scene-focus"), true);
  assert.equal(rankings[1].rejectedReasons.some((reason) => reason.startsWith("unknown-claims")), true);
});

test("historical outcomes influence otherwise valid candidates", () => {
  const first = candidate("first", "产品功能角度");
  const second = candidate("second", "工程验证角度");
  const history = Array.from({ length: 5 }, () => ({ fingerprint: storyPlanFingerprint(second), succeeded: true, scoreDelta: 8, createdAt: new Date().toISOString() }));
  const rankings = rankStoryPlanCandidates([first, second], ledger, 90, history);
  assert.equal(rankings[0].candidate.id, "second");
  assert.equal(rankings[0].scores.historicalEffect > rankings[1].scores.historicalEffect, true);
});

test("selected plan outcome is persisted for future ranking", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scene-gen-story-plan-"));
  const previous = process.env.STORY_PLAN_HISTORY_FILE;
  process.env.STORY_PLAN_HISTORY_FILE = path.join(directory, "outcomes.jsonl");
  const selected = candidate("selected", "工程验证角度");
  const ranking = rankStoryPlanCandidates([selected], ledger, 90)[0];
  const project = { storyPlanning: { profile: "test", requestedCandidates: 1, selectedCandidateId: selected.id, planningMs: 1, planningTokens: 10, expansionTokens: 20, rankings: [ranking] } } as VideoProject;
  try {
    await recordStoryPlanOutcome(project, true, 6);
    const stored = JSON.parse((await readFile(process.env.STORY_PLAN_HISTORY_FILE, "utf8")).trim());
    assert.equal(stored.fingerprint, ranking.fingerprint);
    assert.equal(stored.succeeded, true);
    assert.equal(stored.scoreDelta, 6);
  } finally {
    if (previous === undefined) delete process.env.STORY_PLAN_HISTORY_FILE; else process.env.STORY_PLAN_HISTORY_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  }
});


test("accepts a detailed but still drawable Chinese focus", () => {
  const detailed = candidate("detailed", "evidence-led visual plan");
  detailed.scenes[3].focus = "媒体消息对应筹备节点与监管审核节点的时间线关系，以及尚未获得公司确认的事实边界说明";
  const ranking = rankStoryPlanCandidates([detailed], ledger, 90)[0];
  assert.equal(ranking.rejectedReasons.includes("scene-3-unvisualizable-focus"), false);
});
