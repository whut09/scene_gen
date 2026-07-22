import type { IterationReport } from "../video-stages";
import type { QualityEvaluation } from "../quality";
import { stageIndex, type VideoStageName } from "../stage-types";

export function latestStageEvaluations(iterations: IterationReport[]): {
  finalDraft: QualityEvaluation | undefined;
  finalAudio: QualityEvaluation | undefined;
} {
  let draftCandidate: { value: QualityEvaluation; order: number } | undefined;
  let audioCandidate: { value: QualityEvaluation; order: number } | undefined;
  iterations.forEach((iteration, index) => {
    const draftOrder = iteration.draftUpdatedAtMs ?? index;
    const audioOrder = iteration.audioUpdatedAtMs ?? index;
    if (!draftCandidate || draftOrder >= draftCandidate.order) draftCandidate = { value: iteration.draft, order: draftOrder };
    if (iteration.audio && (!audioCandidate || audioOrder >= audioCandidate.order)) audioCandidate = { value: iteration.audio, order: audioOrder };
  });
  return { finalDraft: draftCandidate?.value, finalAudio: audioCandidate?.value };
}

export function initialDraftLoopState(iterations: IterationReport[]) {
  const finalDraft = latestStageEvaluations(iterations).finalDraft;
  const draftPassed = finalDraft?.passed ?? false;
  const latestDraftIteration = iterations
    .filter((item) => item.draft === finalDraft)
    .at(-1)?.iteration ?? 0;
  const iteration = Math.max(1, latestDraftIteration + (draftPassed ? 0 : 1));
  return { draftPassed, iteration };
}

export function shouldContinueDraftLoop(input: { draftPassed: boolean; draftStageRequested: boolean; draftGateRequested: boolean; iteration: number; maxIterations: number; forced?: boolean }) {
  return Boolean(input.forced) || ((!input.draftPassed || input.draftStageRequested || input.draftGateRequested) && input.iteration <= input.maxIterations);
}

export function shouldRevalidateDraftBeforeResume(input: { resumeValue?: string; explicitFromStage?: VideoStageName; draftPassed: boolean }) {
  return Boolean(input.resumeValue && input.explicitFromStage && !input.draftPassed && stageIndex(input.explicitFromStage) > stageIndex("draft-gate"));
}
