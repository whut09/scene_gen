import assert from "node:assert/strict";
import test from "node:test";
import { generatedAudioSceneIndexes } from "./audio-loop";
import { initialDraftLoopState, shouldContinueDraftLoop } from "./draft-loop";
import { addTemplateExclusions, affectedVideoScenes } from "./video-loop";

test("agent loop helpers isolate stage decisions", () => {
  assert.deepEqual(initialDraftLoopState([]), { draftPassed: false, iteration: 1 });
  assert.equal(shouldContinueDraftLoop({ draftPassed: true, draftStageRequested: false, draftGateRequested: false, iteration: 1, maxIterations: 3 }), false);
  assert.deepEqual(generatedAudioSceneIndexes("1,3"), [1, 3]);
  assert.deepEqual(affectedVideoScenes([], [{ code: "blank_frame", stage: "video", severity: "error", issueClass: "hard", sceneIndex: 2, evidence: {}, repairAction: "rerender-scenes", retryable: true, message: "blank" }]), [2]);
  assert.deepEqual(addTemplateExclusions({}, [{ sceneIndex: 2, templateId: "title", variantId: "bold" }]), { "2": ["title:bold"] });
});
