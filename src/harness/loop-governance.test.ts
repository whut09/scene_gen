import assert from "node:assert/strict";
import test from "node:test";
import { calculateLoopBudgetUsage, evaluateLoopBudget, finalizePendingStrategies, issueEvidenceSignature, selectNextLoopStrategy, type LoopStrategyTrace } from "./loop-governance";
import { finalizeQualityEvaluation } from "./quality-protocol";
import type { RunJournal } from "./run-journal";

const issueCode = "scene_narration_mismatch";
const evaluation = finalizeQualityEvaluation({ stage: "draft", issues: [{ severity: "error", code: issueCode, message: "same", evidence: { field: "headline" } }], revisionNotes: [], scores: { quality: 60 }, metrics: {} });

test("no-progress strategy escalates through applicable alternatives", () => {
  const trajectory: LoopStrategyTrace[] = [];
  const first = selectNextLoopStrategy({ stage: "draft", iteration: 1, issues: evaluation.issues, repairAction: "revise-scenes", affectedScenes: [1], trajectory, fallbackProviderId: "backup" });
  assert.equal(first.strategyId, "local-evidence-constraints");
  trajectory.push({ ...first, outcome: "no-progress", observedSuccess: false });
  const second = selectNextLoopStrategy({ stage: "draft", iteration: 2, issues: evaluation.issues, repairAction: "revise-scenes", affectedScenes: [1], trajectory, fallbackProviderId: "backup" });
  assert.equal(second.strategyId, "alternate-revision-prompt");
  trajectory.push({ ...second, outcome: "no-progress", observedSuccess: false });
  assert.equal(selectNextLoopStrategy({ stage: "draft", iteration: 3, issues: evaluation.issues, repairAction: "revise-scenes", affectedScenes: [1], trajectory, fallbackProviderId: "backup" }).strategyId, "alternate-provider");
});

test("strategy outcome uses issue evidence changes and tracks success rate", () => {
  const strategy = selectNextLoopStrategy({ stage: "audio", iteration: 1, issues: evaluation.issues, repairAction: "resynthesize-audio", affectedScenes: [0], trajectory: [] });
  const changed = finalizeQualityEvaluation({ stage: "audio", issues: [{ severity: "error", code: issueCode, message: "same", evidence: { field: "narration" } }], revisionNotes: [], metrics: {} });
  const finalized = finalizePendingStrategies([strategy], "audio", changed);
  assert.equal(finalized[0].outcome, "improved");
  assert.notEqual(issueEvidenceSignature(evaluation.issues), issueEvidenceSignature(changed.issues));
});

test("loop budgets block token, media and per-issue overruns", () => {
  const status = evaluateLoopBudget(
    { maxLlmTokens: 100, maxTtsRebuilds: 2, maxRenderMinutes: 1, maxEstimatedCost: 1, maxRepairsPerIssue: 2 },
    { llmTokens: 100, ttsRebuilds: 2, renderMinutes: 1, estimatedCost: 1, repairsByIssue: { [issueCode]: 2 } },
    evaluation.issues,
  );
  assert.equal(status.allowed, false);
  assert.deepEqual(status.exceeded, ["max-llm-tokens", "max-tts-rebuilds", "max-render-minutes", "max-estimated-cost", `max-issue-repairs:${issueCode}`]);
});

test("video no-progress starts with an alternate template and budget usage reads journals", () => {
  const video = selectNextLoopStrategy({
    stage: "video", iteration: 2, issues: evaluation.issues, repairAction: "rerender-scenes", affectedScenes: [0], trajectory: [],
    templateSelections: [{ sceneIndex: 0, templateId: "kinetic-title", variantId: "launch-impact" }],
  });
  assert.equal(video.strategyId, "alternate-template-variant");
  assert.equal(video.templateSelections[0].variantId, "launch-impact");
  const usage = calculateLoopBudgetUsage({
    specVersion: 2, runId: "run", url: "https://example.com", status: "running", createdAt: "now", updatedAt: "now",
    config: { targetSeconds: 10, maxIterations: 4, engine: "html-video", qualityProfile: "balanced", runtimeProfile: "test", outputDir: "out", screenshotLimit: 0 },
    artifacts: {}, migrationHistory: [], error: undefined,
    stages: [{ name: "synthesize", status: "succeeded", attempt: 1, inputHash: "x", durationMs: 1000, outputs: {}, issues: [], metrics: { generatedSceneCount: 2, forcedAudioRebuild: true }, suggestedAction: "none" }],
  }, [{ cost: { totalTokens: 50, promptTokens: 30, completionTokens: 20, durationMs: 100 }, iteration: 1, stage: "draft", beforeHash: "a", afterHash: "b", issueSignatureBefore: "same", scoreBefore: 60, reasons: [], patch: [], resolvedIssues: [], newIssues: [], progress: "improved", dirtyPlan: { audioSceneIndexes: [], videoSceneIndexes: [], concatAudio: false, concatVideo: false, remux: false, fullRebuild: false, reasons: [] } }]);
  assert.equal(usage.llmTokens, 50);
  assert.equal(usage.ttsRebuilds, 2);
});

test("loop budget counts executed repair audits instead of repeated gate observations", () => {
  const baseIssue = { stage: "audio" as const, severity: "warning" as const, issueClass: "soft" as const, evidence: {}, message: "inconclusive" };
  const journal: RunJournal = {
    specVersion: 2, runId: "run", url: "https://example.com", status: "running", createdAt: "now", updatedAt: "now",
    config: { targetSeconds: 10, maxIterations: 4, engine: "html-video", qualityProfile: "balanced", runtimeProfile: "test", outputDir: "out", screenshotLimit: 0 },
    artifacts: {}, migrationHistory: [], error: undefined,
    stages: [{
      name: "audio-gate", status: "succeeded", attempt: 1, inputHash: "x", durationMs: 10, outputs: {}, metrics: {}, suggestedAction: "check-environment",
      issues: [
        { ...baseIssue, code: "verification_inconclusive", repairAction: "none", retryable: false },
        { ...baseIssue, code: "verification_inconclusive", repairAction: "none", retryable: false },
        { ...baseIssue, severity: "error", issueClass: "environment", code: "asr_verification_failed", repairAction: "check-environment", retryable: true },
        { ...baseIssue, severity: "error", issueClass: "environment", code: "asr_verification_failed", repairAction: "check-environment", retryable: true },
      ],
    }],
  };
  assert.deepEqual(calculateLoopBudgetUsage(journal, []).repairsByIssue, {});
  const usage = calculateLoopBudgetUsage(journal, [{
    iteration: 1, stage: "audio", beforeHash: "a", afterHash: "b", issueSignatureBefore: "x", reasons: [
      { code: "verification_inconclusive", repairAction: "none" },
      { code: "asr_verification_failed", repairAction: "check-environment" },
      { code: "asr_verification_failed", repairAction: "check-environment" },
    ], patch: [], resolvedIssues: [], newIssues: [], cost: { durationMs: 1, promptTokens: 0, completionTokens: 0, totalTokens: 0 }, progress: "improved",
    dirtyPlan: { audioSceneIndexes: [], videoSceneIndexes: [], concatAudio: false, concatVideo: false, remux: false, fullRebuild: false, reasons: [] },
  }]);
  assert.deepEqual(usage.repairsByIssue, { asr_verification_failed: 1 });
});
