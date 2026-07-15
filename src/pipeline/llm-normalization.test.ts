import assert from "node:assert/strict";
import test from "node:test";
import { directedStorySchema } from "./schemas";
import { normalizeDirectedStoryPayload } from "./llm";
import type { StoryPlanCandidate } from "./types";

const selectedPlan: StoryPlanCandidate = {
  id: "candidate-1",
  angle: "事实边界",
  title: "DeepSeek上市筹备传闻引关注",
  titleClaimIds: ["fact-title"],
  estimatedSeconds: 95,
  scenes: ["title", "briefing", "chart", "flow", "outro"].map((visual, index) => ({
    visual: visual as StoryPlanCandidate["scenes"][number]["visual"],
    purpose: "scene",
    focus: `focus-${index}`,
    claimIds: [`fact-${index}`],
  })),
};

test("normalizes recoverable directed story shape drift", () => {
  const raw = {
    title: { text: selectedPlan.title },
    sections: selectedPlan.scenes.map((scene, index) => ({
      visual: scene.visual,
      headline: scene.focus,
      narration: scene.focus,
      bars: index === 2 ? [{ label: "市场消息", value: "约4800亿元" }] : undefined,
    })),
  };
  const parsed = directedStorySchema.parse(normalizeDirectedStoryPayload(raw, selectedPlan));
  assert.equal(parsed.title, selectedPlan.title);
  assert.deepEqual(parsed.titleClaimIds, selectedPlan.titleClaimIds);
  assert.equal(parsed.sections?.[2].bars?.[0].value, 4800);
  assert.deepEqual(parsed.sections?.[4].claimIds, ["fact-4"]);
});
