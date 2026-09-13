import type { RuntimeConfig } from "../config/runtime-config";
import type { VideoProject } from "./types";

export const FIXED_REFERENCE_TTS_PROVIDER = "indextts" as const;
export const FIXED_REFERENCE_TTS_VOICE = "IndexTTS2.Fixed.Reference";
export const FIXED_REFERENCE_TTS_LANGUAGE = "zh-cn";
export const FIXED_REFERENCE_TTS_RATE = 1.22;

export function requiresFixedReferenceNarration(config: RuntimeConfig) {
  return config.profile === "production"
    || config.profile === "indextts-local";
}

export function hasFixedReferenceNarrationProvenance(project: VideoProject) {
  const audio = project.audio;
  const metrics = audio?.metrics;
  const segments = project.narrationSegments ?? [];
  const rate = metrics?.ttsRate;
  const language = metrics?.ttsLanguage?.toLowerCase();
  return audio?.provider === FIXED_REFERENCE_TTS_PROVIDER
    && metrics?.selectedProvider === FIXED_REFERENCE_TTS_PROVIDER
    && metrics.ttsVoice === FIXED_REFERENCE_TTS_VOICE
    && language === FIXED_REFERENCE_TTS_LANGUAGE
    && rate !== undefined
    && Math.abs(rate - FIXED_REFERENCE_TTS_RATE) <= 0.02
    && segments.length === project.scenes.length
    && segments.every((segment) => segment.ttsProvider === FIXED_REFERENCE_TTS_PROVIDER
      && segment.ttsVoice === FIXED_REFERENCE_TTS_VOICE
      && segment.ttsLanguage?.toLowerCase() === FIXED_REFERENCE_TTS_LANGUAGE);
}
