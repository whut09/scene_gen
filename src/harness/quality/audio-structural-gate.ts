import { existsSync } from "node:fs";
import path from "node:path";
import type { RuntimeConfig } from "../../config/runtime-config";
import { runExternalProcess } from "../../pipeline/external-operation";
import type { VideoProject } from "../../pipeline/types";
import { fromRoot } from "../../pipeline/utils";
import type { QualityIssueInput } from "../quality-protocol";

export const AUDIO_STRUCTURAL_GATE_VERSION = "audio-structural-v2";

export interface AudioStructuralProbe {
  readable: boolean;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  silenceRatio?: number;
  peakDb?: number;
}

export function projectAudioPath(project: VideoProject) {
  if (!project.audio?.src) return undefined;
  return project.audio.src.startsWith("/generated/")
    ? fromRoot("public", ...project.audio.src.replace(/^\/+/, "").split("/"))
    : path.resolve(project.audio.src);
}

export async function probeAudioStructure(audioPath: string, signal?: AbortSignal): Promise<AudioStructuralProbe> {
  const result = await runExternalProcess("ffprobe", ["-v", "error", "-show_entries", "stream=sample_rate,channels:format=duration", "-of", "json", audioPath], { signal, timeoutMs: 60_000 });
  const parsed = JSON.parse(result.stdout) as { streams?: Array<{ sample_rate?: string; channels?: number }>; format?: { duration?: string } };
  const stream = parsed.streams?.[0];
  const analysis = await runExternalProcess("ffmpeg", ["-v", "info", "-i", audioPath, "-af", "silencedetect=noise=-50dB:d=0.1,astats=metadata=1:reset=0", "-f", "null", "-"], { signal, timeoutMs: 120_000 }).catch(() => undefined);
  const diagnostic = `${analysis?.stdout ?? ""}\n${analysis?.stderr ?? ""}`;
  const silenceSeconds = [...diagnostic.matchAll(/silence_duration:\s*([\d.]+)/g)].reduce((sum, match) => sum + Number(match[1]), 0);
  const peakMatches = [...diagnostic.matchAll(/Peak level dB:\s*(-?(?:inf|[\d.]+))/gi)];
  const peakDb = peakMatches.length ? Number(peakMatches.at(-1)![1]) : undefined;
  const durationSeconds = Number(parsed.format?.duration ?? 0);
  return {
    readable: Boolean(stream && durationSeconds > 0),
    durationSeconds,
    sampleRate: Number(stream?.sample_rate ?? 0),
    channels: Number(stream?.channels ?? 0),
    silenceRatio: durationSeconds > 0 ? Math.min(1, silenceSeconds / durationSeconds) : undefined,
    peakDb: Number.isFinite(peakDb) ? peakDb : undefined,
  };
}

export async function runAudioStructuralGate(input: {
  project: VideoProject;
  targetSeconds: number;
  config: RuntimeConfig;
  probe?: (audioPath: string, signal?: AbortSignal) => Promise<AudioStructuralProbe>;
  signal?: AbortSignal;
}): Promise<{ issues: QualityIssueInput[]; passed: boolean; metrics: Record<string, string | number | boolean> }> {
  const { project, targetSeconds, config } = input;
  const issues: QualityIssueInput[] = [];
  const audioPath = projectAudioPath(project);
  if (!audioPath || !existsSync(audioPath) || !project.audio || project.audio.provider === "silent") {
    issues.push({ severity: "error", code: "audio_missing", message: "Audio file is missing or silent." });
    return { issues, passed: false, metrics: { structuralPassed: false, audioExists: false, structuralGateVersion: AUDIO_STRUCTURAL_GATE_VERSION } };
  }
  let probe: AudioStructuralProbe;
  try {
    probe = await (input.probe ?? probeAudioStructure)(audioPath, input.signal);
  } catch (error) {
    issues.push({ severity: "error", code: "audio_missing", message: `Audio cannot be read: ${(error as Error).message}` });
    return { issues, passed: false, metrics: { structuralPassed: false, audioExists: true, structuralGateVersion: AUDIO_STRUCTURAL_GATE_VERSION } };
  }
  const minimumDuration = targetSeconds * config.quality.minDurationFactor;
  const maximumDuration = targetSeconds * config.quality.maxDurationFactor;
  if (!probe.readable) issues.push({ severity: "error", code: "audio_missing", message: "Audio WAV is unreadable." });
  if (probe.durationSeconds < minimumDuration || probe.durationSeconds > maximumDuration) issues.push({ severity: "error", code: "duration_out_of_range", message: `Audio duration ${probe.durationSeconds.toFixed(1)}s is outside ${minimumDuration.toFixed(1)}-${maximumDuration.toFixed(1)}s.` });
  if (probe.sampleRate > 0 && probe.sampleRate < 16_000) issues.push({ severity: "error", code: "audio_format_invalid", message: `Audio sample rate ${probe.sampleRate}Hz is below 16kHz.`, evidence: { sampleRate: probe.sampleRate } });
  if (probe.channels > 1) issues.push({ severity: "error", code: "audio_format_invalid", message: `Audio must be mono, received ${probe.channels} channels.`, evidence: { channels: probe.channels } });
  if ((probe.silenceRatio ?? 0) > 0.92) issues.push({ severity: "error", code: "audio_silence_excessive", message: "Audio is predominantly silent.", evidence: { silenceRatio: probe.silenceRatio! } });
  if ((probe.peakDb ?? -3) >= -0.1) issues.push({ severity: "error", code: "audio_clipping", message: "Audio peak indicates clipping.", evidence: { peakDb: probe.peakDb! } });
  const segmentVoices = (project.narrationSegments ?? []).map((segment) => segment.ttsVoice).filter((voice): voice is string => Boolean(voice));
  const segmentLanguages = (project.narrationSegments ?? []).map((segment) => segment.ttsLanguage).filter((language): language is string => Boolean(language));
  const uniqueVoices = [...new Set(segmentVoices)];
  const uniqueLanguages = [...new Set(segmentLanguages.map((language) => language.toLowerCase()))];
  if (uniqueVoices.length > 1) issues.push({ severity: "error", code: "audio_voice_inconsistent", message: "Narration scenes use different voices.", evidence: { voices: uniqueVoices } });
  if (uniqueLanguages.length > 1 || uniqueLanguages.some((language) => language !== "zh-cn" && language !== "zh" && language !== "chinese")) issues.push({ severity: "error", code: "audio_language_inconsistent", message: "Narration scenes use inconsistent or non-Mandarin languages.", evidence: { languages: uniqueLanguages } });
  let cursor = 0;
  for (const [index, scene] of project.scenes.entries()) {
    const segment = project.narrationSegments?.[index];
    if (!segment || segment.audioStartSeconds === undefined || segment.durationSeconds === undefined) {
      issues.push({ severity: "error", code: "segment_timing_missing", message: `Scene ${index + 1} lacks narration timing.`, sceneIndex: index });
      continue;
    }
    const tolerance = 1 / project.meta.fps + 0.002;
    if (Math.abs(cursor - segment.audioStartSeconds) > tolerance || Math.abs(scene.duration - segment.durationSeconds) > tolerance) issues.push({ severity: "error", code: "audio_scene_drift", message: `Scene ${index + 1} audio timeline is misaligned.`, sceneIndex: index });
    cursor += scene.duration;
  }
  const passed = !issues.some((issue) => issue.severity === "error");
  return { issues, passed, metrics: { structuralPassed: passed, audioExists: true, sampleRate: probe.sampleRate, channels: probe.channels, silenceRatio: probe.silenceRatio ?? -1, peakDb: probe.peakDb ?? -999, concatDuration: cursor, ttsVoice: uniqueVoices.join(","), ttsLanguage: uniqueLanguages.join(","), ttsSceneVoiceConsistency: uniqueVoices.length <= 1, structuralGateVersion: AUDIO_STRUCTURAL_GATE_VERSION } };
}
