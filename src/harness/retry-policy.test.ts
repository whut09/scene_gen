import assert from "node:assert/strict";
import test from "node:test";
import { planRepair } from "./retry-policy";
import { loadQualityProfile } from "./quality-protocol";

test("repair policy routes content, environment and render failures separately", () => {
  const mismatch = planRepair("draft", [{ severity: "error", code: "scene_narration_mismatch", message: "mismatch", sceneIndex: 2 }]);
  assert.equal(mismatch.action, "revise-scenes");
  assert.deepEqual(mismatch.sceneIndexes, [2]);
  assert.equal(planRepair("audio", [{ severity: "error", code: "asr_verification_failed", message: "missing model" }]).action, "check-environment");
  assert.equal(planRepair("video", [{ severity: "error", code: "stream_duration_drift", message: "drift" }]).action, "remux");
  const durationEscalation = planRepair("video", [{ severity: "error", code: "video_project_duration_drift", message: "drift" }], undefined, 3, 2);
  assert.equal(durationEscalation.action, "rerender-scenes");
  assert.deepEqual(durationEscalation.videoSceneIndexes, [0, 1, 2]);
  const blank = planRepair("video", [{ severity: "error", code: "blank_frame", message: "blank", sceneIndex: 3 }]);
  assert.equal(blank.action, "rerender-scenes");
  assert.deepEqual(blank.videoSceneIndexes, [3]);
  assert.equal(blank.muxRequired, true);
  assert.equal(blank.dirtyPlan.concatVideo, true);
  const date = planRepair("draft", [{ severity: "error", code: "news_date_not_spoken", message: "date", sceneIndex: 0 }]);
  assert.equal(date.action, "revise-scenes");
  assert.deepEqual(date.sceneIndexes, [0]);
  assert.equal(planRepair("draft", [{ severity: "error", code: "news_date_missing", message: "missing date" }]).action, "regenerate-draft");
  assert.equal(planRepair("draft", [{ severity: "error", code: "title_not_chinese_summary", message: "title" }]).action, "regenerate-draft");
  assert.equal(planRepair("video", [{ severity: "warning", code: "scene_motion_too_static", message: "static", sceneIndex: 1 }], loadQualityProfile("balanced")).action, "none");
  assert.equal(planRepair("video", [{ severity: "warning", code: "scene_motion_too_static", message: "static", sceneIndex: 1 }], loadQualityProfile("strict")).action, "switch-template");
});

test("pronunciation mismatches request scene-scoped audio regeneration", () => {
  const plan = planRepair("audio", [{
    severity: "error",
    code: "audio_pronunciation_mismatch",
    sceneIndex: 2,
    evidence: { phrase: "重构", expectedPinyin: "chong2 gou4", actualPinyin: "zhong4 gou4" },
    repairAction: "resynthesize-audio",
    retryable: true,
  }]);
  assert.equal(plan.action, "resynthesize-audio");
  assert.deepEqual(plan.audioSceneIndexes, [2]);
  assert.equal(plan.muxRequired, true);
  assert.equal(plan.dirtyPlan.concatAudio, true);
});

test("global audio failures request a full audio rebuild", () => {
  const plan = planRepair("audio", [{ severity: "error", code: "audio_missing", message: "missing" }]);
  assert.equal(plan.forceAudioRebuild, true);
  assert.deepEqual(plan.audioSceneIndexes, []);
  assert.equal(plan.muxRequired, true);
});
