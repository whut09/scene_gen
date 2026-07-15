import assert from "node:assert/strict";
import test from "node:test";
import { planRepair } from "./retry-policy";
import { loadQualityProfile } from "./quality-protocol";

test("repair policy routes content, environment and render failures separately", () => {
  assert.deepEqual(planRepair("draft", [{ severity: "error", code: "scene_narration_mismatch", message: "mismatch", sceneIndex: 2 }]), {
    action: "revise-scenes",
    sceneIndexes: [2],
    audioSceneIndexes: [],
    videoSceneIndexes: [],
    muxRequired: false,
    forceAudioRebuild: false,
    forceVideoRebuild: false,
    retryable: true,
    reason: "scene_narration_mismatch",
  });
  assert.equal(planRepair("audio", [{ severity: "error", code: "asr_verification_failed", message: "missing model" }]).action, "check-environment");
  assert.equal(planRepair("video", [{ severity: "error", code: "stream_duration_drift", message: "drift" }]).action, "remux");
  assert.deepEqual(planRepair("video", [{ severity: "error", code: "blank_frame", message: "blank", sceneIndex: 3 }]), {
    action: "rerender-scenes",
    sceneIndexes: [3],
    audioSceneIndexes: [],
    videoSceneIndexes: [3],
    muxRequired: false,
    forceAudioRebuild: false,
    forceVideoRebuild: true,
    retryable: true,
    reason: "blank_frame",
  });
  assert.deepEqual(planRepair("draft", [{ severity: "error", code: "news_date_not_spoken", message: "date", sceneIndex: 0 }]), {
    action: "revise-scenes",
    sceneIndexes: [0],
    audioSceneIndexes: [],
    videoSceneIndexes: [],
    muxRequired: false,
    forceAudioRebuild: false,
    forceVideoRebuild: false,
    retryable: true,
    reason: "news_date_not_spoken",
  });
  assert.equal(planRepair("draft", [{ severity: "error", code: "news_date_missing", message: "missing date" }]).action, "regenerate-draft");
  assert.equal(planRepair("draft", [{ severity: "error", code: "title_not_chinese_summary", message: "title" }]).action, "regenerate-draft");
  assert.equal(planRepair("video", [{ severity: "warning", code: "scene_motion_too_static", message: "static", sceneIndex: 1 }], loadQualityProfile("balanced")).action, "none");
  assert.equal(planRepair("video", [{ severity: "warning", code: "scene_motion_too_static", message: "static", sceneIndex: 1 }], loadQualityProfile("strict")).action, "switch-template");
});

test("pronunciation mismatches request scene-scoped audio regeneration", () => {
  assert.deepEqual(planRepair("audio", [{
    severity: "error",
    code: "audio_pronunciation_mismatch",
    sceneIndex: 2,
    evidence: { phrase: "重构", expectedPinyin: "chong2 gou4", actualPinyin: "zhong4 gou4" },
    repairAction: "resynthesize-audio",
    retryable: true,
  }]), {
    action: "resynthesize-audio",
    sceneIndexes: [2],
    audioSceneIndexes: [2],
    videoSceneIndexes: [],
    muxRequired: true,
    forceAudioRebuild: true,
    forceVideoRebuild: false,
    retryable: true,
    reason: "audio_pronunciation_mismatch",
  });
});

test("global audio failures request a full audio rebuild", () => {
  const plan = planRepair("audio", [{ severity: "error", code: "audio_missing", message: "missing" }]);
  assert.equal(plan.forceAudioRebuild, true);
  assert.deepEqual(plan.audioSceneIndexes, []);
  assert.equal(plan.muxRequired, true);
});
