import assert from "node:assert/strict";
import test from "node:test";
import { storyPlanCandidateSchema } from "./schemas";
import {
  allocateSceneDurations,
  contentDurationPolicy,
  defaultTargetSecondsForUrl,
} from "./content-strategy";

test("content duration defaults favor short social videos", () => {
  assert.equal(defaultTargetSecondsForUrl("https://www.36kr.com/p/123"), 40);
  assert.equal(defaultTargetSecondsForUrl("https://github.com/example/project"), 48);
  assert.equal(defaultTargetSecondsForUrl("https://cloud.tencent.com/developer/article/123"), 60);
  assert.deepEqual(contentDurationPolicy("news").visuals, ["title", "briefing", "flow", "outro"]);
  assert.equal(contentDurationPolicy("repository").hardMaximumSeconds, 60);
});

test("short story plans accept four scenes and preserve the target duration", () => {
  const visuals = contentDurationPolicy("news").visuals;
  const durations = allocateSceneDurations(40, visuals);
  assert.equal(durations.length, 4);
  assert.equal(durations.reduce((sum, duration) => sum + duration, 0), 40);
  assert.equal(durations[0] < durations[1], true);

  assert.doesNotThrow(() => storyPlanCandidateSchema.parse({
    id: "short",
    angle: "先给结果，再给证据",
    title: "一次更新把三步操作压缩成一步",
    titleClaimIds: ["claim-1"],
    estimatedSeconds: 40,
    scenes: visuals.map((visual, index) => ({ visual, purpose: `目的${index}`, focus: `事实焦点${index}`, claimIds: ["claim-1"] })),
  }));
});
