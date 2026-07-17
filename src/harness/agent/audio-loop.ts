export function generatedAudioSceneIndexes(value: unknown) {
  return String(value ?? "").split(",").filter(Boolean).map(Number).filter(Number.isInteger);
}

export function shouldSynthesizeAudio(input: { hasAudio: boolean; startStage: string; forceAudioRebuild: boolean; forceSceneIndexes?: number[] }) {
  return !input.hasAudio || input.startStage === "synthesize" || input.forceAudioRebuild || Boolean(input.forceSceneIndexes?.length);
}
