import assert from "node:assert/strict";
import test from "node:test";
import { finalizeQualityEvaluation, loadQualityProfile, qualityIssueSchema } from "./quality-protocol";

test("quality issues are normalized to the stable protocol", () => {
  const evaluation = finalizeQualityEvaluation({ stage: "audio", issues: [{ severity: "error", code: "asr_verification_failed", message: "model missing" }], revisionNotes: [], metrics: {} });
  assert.equal(evaluation.outcome, "blocked");
  assert.equal(evaluation.issues[0].issueClass, "environment");
  assert.equal(evaluation.issues[0].repairAction, "check-environment");
  assert.equal(evaluation.issues[0].retryable, false);
  assert.doesNotThrow(() => qualityIssueSchema.parse(evaluation.issues[0]));
});

test("quality profiles decide whether warnings block", () => {
  const input = { stage: "video" as const, issues: [{ severity: "warning" as const, code: "scene_motion_too_static", message: "static", sceneIndex: 0 }], revisionNotes: [], metrics: {} };
  assert.equal(finalizeQualityEvaluation({ ...input, profile: loadQualityProfile("balanced") }).passed, true);
  assert.equal(finalizeQualityEvaluation({ ...input, profile: loadQualityProfile("strict") }).passed, false);
});

test("pronunciation mismatch uses the stable scene-scoped repair protocol", () => {
  const evaluation = finalizeQualityEvaluation({
    stage: "audio",
    issues: [{
      severity: "error",
      code: "audio_pronunciation_mismatch",
      sceneIndex: 2,
      evidence: { phrase: "重构", expectedPinyin: "chong2 gou4", actualPinyin: "zhong4 gou4" },
      repairAction: "resynthesize-audio",
      retryable: true,
    }],
    revisionNotes: [],
    metrics: {},
  });
  assert.equal(evaluation.issues[0].stage, "audio");
  assert.equal(evaluation.issues[0].sceneIndex, 2);
  assert.equal(evaluation.issues[0].repairAction, "resynthesize-audio");
  assert.equal(evaluation.issues[0].retryable, true);
  assert.deepEqual(evaluation.issues[0].evidence, { phrase: "重构", expectedPinyin: "chong2 gou4", actualPinyin: "zhong4 gou4" });
});
