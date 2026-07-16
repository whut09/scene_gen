export function generatedAudioSceneIndexes(value: unknown) {
  return String(value ?? "").split(",").filter(Boolean).map(Number).filter(Number.isInteger);
}
