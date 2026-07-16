import assert from "node:assert/strict";
import test from "node:test";
import { issueCodeSchema, issueRegistry } from "../../src/harness/issue-registry";
import { finalizeQualityEvaluation, qualityIssueSchema } from "../../src/harness/quality-protocol";
import { readRunJournal } from "../../src/harness/run-journal";
import { stageResultSchema } from "../../src/harness/stage-types";
import {
  f5WorkerReadySchema,
  f5WorkerRequestSchema,
  f5WorkerResultSchema,
} from "../../src/pipeline/generated/f5-worker-protocol";

const hash = "a".repeat(64);

test("issue registry is the canonical code enum", () => {
  for (const code of Object.keys(issueRegistry)) assert.equal(issueCodeSchema.parse(code), code);
  assert.equal(issueCodeSchema.safeParse("future_unknown_issue").success, false);
  assert.equal(qualityIssueSchema.safeParse({
    code: "future_unknown_issue",
    stage: "draft",
    severity: "error",
    issueClass: "hard",
    evidence: {},
    repairAction: "stop",
    retryable: false,
    message: "unknown",
  }).success, false);
});

test("unknown boundary issue codes normalize without corrupting canonical data", () => {
  const evaluation = finalizeQualityEvaluation({
    stage: "draft",
    issues: [{ code: "legacy_custom_issue", severity: "error", message: "legacy" }],
    revisionNotes: [],
    metrics: {},
  });
  assert.equal(evaluation.issues[0].code, "unregistered_issue");
  assert.equal(evaluation.issues[0].evidence.originalCode, "legacy_custom_issue");
  assert.doesNotThrow(() => stageResultSchema.shape.issues.parse(evaluation.issues));
});

test("pronunciation evidence is validated by the registered issue schema", () => {
  const valid = finalizeQualityEvaluation({
    stage: "audio",
    issues: [{
      code: "audio_pronunciation_mismatch",
      severity: "error",
      sceneIndex: 2,
      evidence: { phrase: "重构", expectedPinyin: "chong2 gou4", actualPinyin: "zhong4 gou4" },
    }],
    revisionNotes: [],
    metrics: {},
  });
  assert.equal(valid.issues[0].repairAction, "resynthesize-audio");
  assert.equal(qualityIssueSchema.safeParse({ ...valid.issues[0], evidence: { phrase: 42 } }).success, false);
});

test("legacy journal issue codes normalize before strict persistence parsing", () => {
  const issue = {
    code: "legacy_custom_issue",
    stage: "draft",
    severity: "error",
    issueClass: "hard",
    evidence: {},
    repairAction: "stop",
    retryable: false,
    message: "legacy",
  };
  const journal = readRunJournal({
    specVersion: 2,
    runId: "legacy-code",
    url: "https://example.com/article",
    status: "failed",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:01:00.000Z",
    config: {
      targetSeconds: 30,
      maxIterations: 1,
      engine: "html-video",
      outputDir: "dist/output",
      screenshotLimit: 0,
    },
    artifacts: {},
    stages: [{
      name: "draft",
      status: "failed",
      attempt: 1,
      inputHash: "input",
      startedAt: "2026-07-01T00:00:00.000Z",
      durationMs: 1,
      outputs: {},
      issues: [issue],
      metrics: {},
      suggestedAction: "stop",
    }],
  });
  assert.equal(journal.value.stages[0].issues[0].code, "unregistered_issue");
  assert.equal(journal.value.stages[0].issues[0].evidence.originalCode, "legacy_custom_issue");
});

test("generated F5 protocol schemas validate both directions", () => {
  assert.doesNotThrow(() => f5WorkerReadySchema.parse({
    type: "ready", status: "ready", pid: 123, model: "F5TTS_v1_Base", device: "cpu",
    pronunciationLexiconHash: hash, workerStartupMs: 10, modelLoadMs: 8,
  }));
  assert.doesNotThrow(() => f5WorkerRequestSchema.parse({
    type: "synthesize", requestId: "request-1", sceneIndex: 2, text: "重构系统",
    outputPath: "scene-2.wav", speed: 1, nfeStep: 32, seed: -1, pronunciationLexiconHash: hash,
  }));
  assert.doesNotThrow(() => f5WorkerResultSchema.parse({
    type: "result", requestId: "request-1", sceneIndex: 2, status: "failed", outputPath: "scene-2.wav",
    durationSeconds: 0, synthesisMs: 2, errorType: "worker_error", retryable: false,
    error: "failed", traceback: "trace",
  }));
});
