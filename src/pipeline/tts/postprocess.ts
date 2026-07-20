import { getRuntimeConfig } from "../../config/runtime-config";
import { mapWithConcurrency } from "../bounded-task-queue";
import { probeDuration, run } from "./process";

export async function concatNarrationSegments(
  inputs: string[],
  durations: number[],
  gaps: number[],
  outputPath: string,
  leadingSilenceSeconds = 0,
) {
  const args = ["-y"];
  for (const input of inputs) args.push("-i", input);
  const filters = inputs.map((_, index) => {
    const total = durations[index] + gaps[index];
    const fadeOutStart = Math.max(0.02, durations[index] - 0.06);
    return `[${index}:a]aresample=24000,aformat=sample_fmts=s16:channel_layouts=mono,afade=t=in:st=0:d=0.02,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.06,apad=pad_dur=${gaps[index].toFixed(3)},atrim=duration=${total.toFixed(3)}[a${index}]`;
  });
  const delayMs = Math.round(Math.max(0, leadingSilenceSeconds) * 1000);
  const delay = delayMs > 0 ? `,adelay=${delayMs}:all=1` : "";
  filters.push(`${inputs.map((_, index) => `[a${index}]`).join("")}concat=n=${inputs.length}:v=0:a=1${delay},volume=-1dB[out]`);
  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[out]",
    "-ar",
    "24000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    outputPath,
  );
  await run("ffmpeg", args);
}

export async function fitNarrationSegmentsToTarget(
  segmentPaths: string[],
  durations: number[],
  targetSeconds: number,
  totalGapSeconds: number,
) {
  const durationPolicy = getRuntimeConfig().tts.durationPolicy;
  if (
    durationPolicy !== "fit" ||
    !getRuntimeConfig().tts.fitTarget ||
    !Number.isFinite(targetSeconds) ||
    targetSeconds <= totalGapSeconds + 5
  ) {
    return { paths: segmentPaths, durations };
  }
  const speechDuration = durations.reduce((sum, duration) => sum + duration, 0);
  const targetSpeechDuration = targetSeconds - totalGapSeconds;
  const desiredTempo = speechDuration / targetSpeechDuration;
  const minimumTempo = getRuntimeConfig().tts.minTempo;
  const maximumTempo = getRuntimeConfig().tts.maxTempo;
  const tempo = Math.max(minimumTempo, Math.min(maximumTempo, desiredTempo));
  if (Math.abs(tempo - 1) < 0.03) return { paths: segmentPaths, durations };

  const fitted = await mapWithConcurrency(segmentPaths, getRuntimeConfig().tts.ffmpegConcurrency, async (inputPath, index) => {
    const fittedPath = inputPath.replace(/\.[^.]+$/, `-fitted-${tempo.toFixed(2)}x.wav`);
    await run("ffmpeg", [
      "-y", "-i", inputPath,
      "-filter:a", `atempo=${tempo.toFixed(6)}`,
      "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", fittedPath,
    ]);
    const fittedDuration = await probeDuration(fittedPath);
    if (fittedDuration <= 0) throw new Error(`Fitted narration segment ${index + 1} is invalid.`);
    return { path: fittedPath, duration: fittedDuration };
  });
  return { paths: fitted.map((item) => item.path), durations: fitted.map((item) => item.duration) };
}
export async function silentAudio(outputPath: string, duration: number) {
  await run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-t",
    String(duration),
    "-q:a",
    "9",
    "-acodec",
    "libmp3lame",
    outputPath,
  ]);
}
