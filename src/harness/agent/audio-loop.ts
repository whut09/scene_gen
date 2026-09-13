export function generatedAudioSceneIndexes(value: unknown) {
  return String(value ?? "").split(",").filter(Boolean).map(Number).filter(Number.isInteger);
}

export function verificationRetrySceneIndexes(issues: Array<{ code: string; sceneIndex?: number }>) {
  return [...new Set(issues
    .filter((issue) => ["verification_inconclusive", "audio_entity_mismatch", "audio_number_mismatch", "audio_semantic_mismatch", "audio_segment_cross_talk", "audio_opening_mismatch", "speech_alignment_unavailable"].includes(issue.code))
    .map((issue) => issue.sceneIndex ?? 0))];
}

export function nextAudioLoopIteration(iterations: Array<{ iteration: number; audio?: unknown }>) {
  const completed = iterations.filter((item) => item.audio !== undefined).map((item) => item.iteration);
  return completed.length > 0 ? Math.max(...completed) + 1 : 1;
}

export function shouldSynthesizeAudio(input: { hasAudio: boolean; startStage: string; forceAudioRebuild: boolean; forceSceneIndexes?: number[] }) {
  return !input.hasAudio || input.startStage === "synthesize" || input.forceAudioRebuild || Boolean(input.forceSceneIndexes?.length);
}
