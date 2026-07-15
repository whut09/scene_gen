import assert from "node:assert/strict";
import test from "node:test";
import { createJsonPatch, hasRepeatedNoProgress } from "./loop-engineering";
import { finalizeQualityEvaluation } from "./quality-protocol";

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
});
