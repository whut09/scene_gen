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
  const durationRetry = planRepair("video", [{ severity: "error", code: "video_project_duration_drift", message: "drift" }], undefined, 3, 2);
  assert.notEqual(durationRetry.action, "rerender-scenes");
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

test("duration drift uses evidence instead of attempt-only escalation", () => {
  const first = planRepair("video", [{
    severity: "error", code: "video_project_duration_drift", message: "drift",
    evidence: { likelySource: "mux", confidence: 0.92 },
  }], undefined, 5, 1);
  assert.equal(first.action, "remux");
  assert.equal(first.candidates.length, 2);
  assert.equal(first.decision.selectedAction, "remux");

  const concat = planRepair("video", [{
    severity: "error", code: "video_project_duration_drift", message: "drift",
    evidence: { likelySource: "concat", confidence: 0.9 },
  }], undefined, 5, 1);
  assert.equal(concat.action, "reconcat-video");
  assert.equal(concat.dirtyPlan.concatVideo, true);
  assert.deepEqual(concat.videoSceneIndexes, []);
  assert.equal(concat.forceVideoRebuild, false);

  const scene = planRepair("video", [{
    severity: "error", code: "video_project_duration_drift", message: "drift",
    evidence: { likelySource: "scene", confidence: 0.95, invalidSceneIndexes: ["2"] },
  }], undefined, 5, 1);
  assert.equal(scene.action, "rerender-scenes");
  assert.deepEqual(scene.videoSceneIndexes, [2]);
  assert.equal(scene.candidates.some((candidate) => candidate.action === "rerender-scenes"), true);
});

test("repair utility exposes cost, latency, risk and evidence confidence", () => {
  const plan = planRepair("audio", [{
    severity: "error", code: "audio_pronunciation_mismatch", sceneIndex: 1,
    evidence: { phrase: "重构", confidence: 0.91 },
  }], undefined, 4);
  const selected = plan.candidates[plan.decision.selectedCandidateIndex];
  assert.equal(selected.action, "resynthesize-audio");
  assert.equal(selected.evidenceConfidence, 0.91);
  assert.equal(selected.estimatedCost > 0, true);
  assert.equal(selected.estimatedDurationMs > 0, true);
  assert.equal(selected.risk > 0, true);
  assert.equal(Number.isFinite(selected.utility), true);
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
