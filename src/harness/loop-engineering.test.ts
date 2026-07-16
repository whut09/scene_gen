import assert from "node:assert/strict";
import test from "node:test";
import { audioLoopHash, createJsonPatch, hasRepeatedNoProgress } from "./loop-engineering";
import { finalizeQualityEvaluation } from "./quality-protocol";
import { createFixtureProject } from "../../tests/fixtures/project";

test("loop audit creates JSON Patch operations", () => {
  assert.deepEqual(createJsonPatch({ title: "a", points: [1, 2] }, { title: "b", points: [1, 3, 4] }), [
    { op: "replace", path: "/points/1", value: 3 },
    { op: "add", path: "/points/-", value: 4 },
    { op: "replace", path: "/title", value: "b" },
  ]);
});

test("no-progress detection requires stable project, issues and score", () => {
  const evaluation = finalizeQualityEvaluation({ stage: "draft", issues: [{ severity: "error", code: "same", message: "same" }], revisionNotes: [], scores: { quality: 60 }, metrics: {} });
  assert.equal(hasRepeatedNoProgress([{ projectHash: "one", evaluation }, { projectHash: "one", evaluation }]), true);
  assert.equal(hasRepeatedNoProgress([{ projectHash: "one", evaluation }, { projectHash: "two", evaluation }]), false);
  const changedEvidence = finalizeQualityEvaluation({ stage: "draft", issues: [{ severity: "error", code: "same", message: "same", evidence: { field: "narration" } }], revisionNotes: [], scores: { quality: 60 }, metrics: {} });
  assert.equal(hasRepeatedNoProgress([{ projectHash: "one", evaluation }, { projectHash: "one", evaluation: changedEvidence }]), false);
});

test("scene-scoped audio regeneration changes progress identity once", () => {
  const project = createFixtureProject();
  const evaluation = finalizeQualityEvaluation({ stage: "audio", issues: [{ severity: "error", code: "audio_pronunciation_mismatch", sceneIndex: 2 }], revisionNotes: [], metrics: {} });
  const initial = audioLoopHash(project);
  const repaired = audioLoopHash(project, "2:audio:audio_pronunciation_mismatch:2");
  assert.equal(hasRepeatedNoProgress([{ projectHash: initial, evaluation }, { projectHash: repaired, evaluation }]), false);
  assert.equal(hasRepeatedNoProgress([{ projectHash: repaired, evaluation }, { projectHash: repaired, evaluation }]), true);
});
