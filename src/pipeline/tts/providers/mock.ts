import { silentAudio } from "../postprocess";

export async function mockTts(text: string, outputPath: string) {
  await silentAudio(outputPath, Math.max(0.5, [...text].length / 12));
}
