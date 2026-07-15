import assert from "node:assert/strict";
import test from "node:test";
import { planRepair } from "./retry-policy";

test("repair policy routes content, environment and render failures separately", () => {
  assert.deepEqual(planRepair("draft", [{ severity: "error", code: "scene_narration_mismatch", message: "mismatch", sceneIndex: 2 }]), {
    action: "revise-scenes",
    sceneIndexes: [2],
    retryable: true,
    reason: "scene_narration_mismatch",
  });
  assert.equal(planRepair("audio", [{ severity: "error", code: "asr_verification_failed", message: "missing model" }]).action, "check-environment");
  assert.equal(planRepair("video", [{ severity: "error", code: "stream_duration_drift", message: "drift" }]).action, "remux");
  assert.deepEqual(planRepair("video", [{ severity: "error", code: "blank_frame", message: "blank", sceneIndex: 3 }]), {
    action: "rerender-scenes",
    sceneIndexes: [3],
    retryable: true,
    reason: "blank_frame",
  });
  assert.deepEqual(planRepair("draft", [{ severity: "error", code: "news_date_not_spoken", message: "date", sceneIndex: 0 }]), {
    action: "revise-scenes",
    sceneIndexes: [0],
    retryable: true,
    reason: "news_date_not_spoken",
  });
  assert.equal(planRepair("draft", [{ severity: "error", code: "news_date_missing", message: "missing date" }]).action, "regenerate-draft");
  assert.equal(planRepair("draft", [{ severity: "error", code: "title_not_chinese_summary", message: "title" }]).action, "regenerate-draft");
});
