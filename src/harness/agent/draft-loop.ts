import type { IterationReport } from "../video-stages";
import { stageIndex, type VideoStageName } from "../stage-types";

export function initialDraftLoopState(iterations: IterationReport[]) {
  const draftPassed = iterations.at(-1)?.draft?.passed ?? false;
  const iteration = Math.max(1, (iterations.at(-1)?.iteration ?? 0) + (draftPassed ? 0 : 1));
  return { draftPassed, iteration };
}

export function shouldContinueDraftLoop(input: { draftPassed: boolean; draftStageRequested: boolean; draftGateRequested: boolean; iteration: number; maxIterations: number; forced?: boolean }) {
  return Boolean(input.forced) || ((!input.draftPassed || input.draftStageRequested || input.draftGateRequested) && input.iteration <= input.maxIterations);
}

export function shouldRevalidateDraftBeforeResume(input: { resumeValue?: string; explicitFromStage?: VideoStageName; draftPassed: boolean }) {
  return Boolean(input.resumeValue && input.explicitFromStage && !input.draftPassed && stageIndex(input.explicitFromStage) > stageIndex("draft-gate"));
}
