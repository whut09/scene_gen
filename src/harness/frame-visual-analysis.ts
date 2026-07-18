import { stat } from "node:fs/promises";
import { runExternalProcess } from "../pipeline/external-operation";

function runFfmpeg(args: string[], signal?: AbortSignal) {
  return runExternalProcess("ffmpeg", args, {
    signal,
    retries: 1,
    retryOnExit: true,
    timeoutMs: Number(process.env.QUALITY_PROCESS_TIMEOUT_MS ?? 300_000),
  });
}

function metadataNumber(output: string, key: string) {
  const match = output.match(new RegExp(`${key}[:=]([0-9.]+)`));
  return match ? Number(match[1]) : 0;
}

export async function analyzeFrameVisual(framePath: string, signal?: AbortSignal) {
  const info = await stat(framePath).catch(() => undefined);
  const signalStats = await runFfmpeg([
    "-v", "error", "-i", framePath,
    "-vf", "scale=160:-1,signalstats,metadata=print:file=-",
    "-frames:v", "1", "-f", "null", "-",
  ], signal);
  const edgeStats = await runFfmpeg([
    "-v", "info", "-i", framePath,
    "-vf", "scale=160:-1,format=gray,edgedetect=low=0.05:high=0.15,blackframe=amount=0:threshold=16",
    "-frames:v", "1", "-f", "null", "-",
  ], signal);
  const cropStats = await runFfmpeg([
    "-v", "info", "-i", framePath,
    "-vf", "cropdetect=limit=24:round=2:reset=0",
    "-frames:v", "1", "-f", "null", "-",
  ], signal);
  const combinedSignal = `${signalStats.stdout}\n${signalStats.stderr}`;
  const combinedEdges = `${edgeStats.stdout}\n${edgeStats.stderr}`;
  const lumaLow = metadataNumber(combinedSignal, "lavfi.signalstats.YLOW");
  const lumaHigh = metadataNumber(combinedSignal, "lavfi.signalstats.YHIGH");
  const lumaAverage = metadataNumber(combinedSignal, "lavfi.signalstats.YAVG");
  const pblack = metadataNumber(combinedEdges, "pblack");
  const lumaRange = Math.max(0, lumaHigh - lumaLow);
  const edgeDensity = Math.max(0, Math.min(1, 1 - pblack / 100));
  const minimumSize = Number(process.env.VIDEO_BLANK_FRAME_MIN_BYTES ?? 8_000);
  const minimumLumaRange = Number(process.env.VIDEO_BLANK_LUMA_RANGE_MIN ?? 8);
  const minimumEdgeDensity = Number(process.env.VIDEO_BLANK_EDGE_DENSITY_MIN ?? 0.006);
  const sizeBytes = info?.size ?? 0;
  const blank = sizeBytes < minimumSize || (lumaRange < minimumLumaRange && edgeDensity < minimumEdgeDensity);
  const cropMatch = `${cropStats.stdout}\n${cropStats.stderr}`.match(/crop=(\d+):(\d+):(\d+):(\d+)/);
  const crop = cropMatch ? { width: Number(cropMatch[1]), height: Number(cropMatch[2]), x: Number(cropMatch[3]), y: Number(cropMatch[4]) } : undefined;
  return {
    sizeBytes,
    lumaAverage: Number(lumaAverage.toFixed(2)),
    lumaRange: Number(lumaRange.toFixed(2)),
    edgeDensity: Number(edgeDensity.toFixed(5)),
    blank,
    crop,
  };
}
