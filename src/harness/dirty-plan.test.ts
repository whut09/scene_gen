import assert from "node:assert/strict";
import test from "node:test";
import { dirtyPlanFromIssues, dirtyPlanFromPatch } from "./dirty-plan";

test("DirtyPlan routes quality issues to the minimum media work", () => {
  assert.deepEqual(dirtyPlanFromIssues([{
    code: "audio_pronunciation_mismatch", severity: "error", message: "bad", stage: "audio",
    sceneIndex: 2, issueClass: "hard", evidence: {}, repairAction: "resynthesize-audio", retryable: true,
  }], 5), {
    audioSceneIndexes: [2], videoSceneIndexes: [], concatAudio: true, concatVideo: false,
    remux: true, fullRebuild: false,
    reasons: [{ code: "audio_pronunciation_mismatch", stage: "audio", sceneIndex: 2 }],
  });
  assert.deepEqual(dirtyPlanFromIssues([{
    code: "blank_frame", severity: "error", message: "blank", stage: "video",
    sceneIndex: 3, issueClass: "hard", evidence: {}, repairAction: "rerender-scenes", retryable: true,
  }], 5).videoSceneIndexes, [3]);
  assert.deepEqual(dirtyPlanFromIssues([{
    code: "stream_duration_drift", severity: "error", message: "drift", stage: "video",
    issueClass: "hard", evidence: {}, repairAction: "remux", retryable: true,
  }], 5), {
    audioSceneIndexes: [], videoSceneIndexes: [], concatAudio: false, concatVideo: false,
    remux: true, fullRebuild: false,
    reasons: [{ code: "stream_duration_drift", stage: "video" }],
  });
  assert.deepEqual(dirtyPlanFromIssues([{
    code: "wrong_dimensions", severity: "error", message: "size", stage: "video",
    issueClass: "hard", evidence: {}, repairAction: "rerender-scenes", retryable: true,
  }], 3).videoSceneIndexes, [0, 1, 2]);
});

test("DirtyPlan derives audio and video dirtiness from JSON Patch", () => {
  const plan = dirtyPlanFromPatch([
    { op: "replace", path: "/narrationSegments/1/ttsText", value: "new speech" },
    { op: "replace", path: "/scenes/3/headline", value: "new visual" },
  ], 5);
  assert.deepEqual(plan.audioSceneIndexes, [1]);
  assert.deepEqual(plan.videoSceneIndexes, [3]);
  assert.equal(plan.concatAudio, true);
  assert.equal(plan.concatVideo, true);
  assert.equal(plan.remux, true);
});
