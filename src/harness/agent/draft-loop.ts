import type { IterationReport } from "../video-stages";

export function initialDraftLoopState(iterations: IterationReport[]) {
  const draftPassed = iterations.at(-1)?.draft?.passed ?? false;
  const iteration = Math.max(1, (iterations.at(-1)?.iteration ?? 0) + (draftPassed ? 0 : 1));
  return { draftPassed, iteration };
}

export function shouldContinueDraftLoop(input: { draftPassed: boolean; draftStageRequested: boolean; draftGateRequested: boolean; iteration: number; maxIterations: number }) {
  return (!input.draftPassed || input.draftStageRequested || input.draftGateRequested) && input.iteration <= input.maxIterations;
}
