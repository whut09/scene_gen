import type { RuntimeConfig } from "../../config/runtime-config";
import { getRuntimeConfig } from "../../config/runtime-config";
import type { VideoProject } from "../../pipeline/types";
import { prepareF5SynthesisText } from "../../pipeline/tts";
import { canonicalSpeechText } from "../speech-normalization";
import { finalizeQualityEvaluation, type QualityEvaluation, type QualityIssueInput } from "../quality-protocol";
import { runAudioPronunciationGate } from "./audio-pronunciation-gate";
import { runAudioSemanticGate } from "./audio-semantic-gate";
import { runAudioStructuralGate } from "./audio-structural-gate";
import type { AudioStructuralProbe } from "./audio-structural-gate";
import type { AsrSceneTranscript } from "../scene-audio-verification";
import type { PronunciationAssessmentResult } from "./azure-pronunciation-assessment";
import type { PronunciationSpan } from "../../pipeline/pronunciation/schema";

export interface AudioGateDependencies {
  structuralProbe?: (audioPath: string, signal?: AbortSignal) => Promise<AudioStructuralProbe>;
  transcribe?: (project: VideoProject, signal?: AbortSignal) => Promise<AsrSceneTranscript[] | null>;
  pronunciationVerify?: (request: { sceneIndex: number; span: PronunciationSpan; audioPath: string; signal?: AbortSignal }) => Promise<PronunciationAssessmentResult>;
}

export async function evaluateAudio(project: VideoProject, targetSeconds: number, signal?: AbortSignal, config: RuntimeConfig = getRuntimeConfig(), dependencies: AudioGateDependencies = {}): Promise<QualityEvaluation> {
  const issues: QualityIssueInput[] = [];
  const segments = project.narrationSegments ?? [];
  const duration = project.audio?.durationSeconds ?? 0;
  const narrationChars = project.narration.replace(/\s+/g, "").length;
  const charsPerSecond = duration > 0 ? narrationChars / duration : 0;
  const segmentRates = segments.map((segment) => {
    const segmentDuration = segment.durationSeconds ?? 0;
    return segmentDuration > 0 ? segment.text.replace(/\s+/g, "").length / segmentDuration : 0;
  }).filter((value) => value > 0);
  const sortedRates = [...segmentRates].sort((left, right) => left - right);
  const medianSegmentRate = sortedRates.length
    ? sortedRates.length % 2 ? sortedRates[Math.floor(sortedRates.length / 2)] : (sortedRates[sortedRates.length / 2 - 1] + sortedRates[sortedRates.length / 2]) / 2
    : 0;
  const minimumSegmentRate = sortedRates[0] ?? 0;
  const maximumSegmentRate = sortedRates.at(-1) ?? 0;
  const segmentSpeedRatio = minimumSegmentRate > 0 ? maximumSegmentRate / minimumSegmentRate : 0;
  const meanSegmentRate = segmentRates.length ? segmentRates.reduce((sum, value) => sum + value, 0) / segmentRates.length : 0;
  const segmentSpeedCv = meanSegmentRate > 0 ? Math.sqrt(segmentRates.reduce((sum, value) => sum + (value - meanSegmentRate) ** 2, 0) / segmentRates.length) / meanSegmentRate : 0;
  const firstToMedianSpeed = medianSegmentRate > 0 && segmentRates.length ? segmentRates[0] / medianSegmentRate : 0;
  const ttsNumericResidue = segments.reduce((count, segment) => count + (prepareF5SynthesisText(segment.ttsText ?? segment.text).match(/\d/g)?.length ?? 0), 0);

  if (ttsNumericResidue > 0) issues.push({ severity: "error", code: "tts_arabic_digits", message: `TTS synthesis text contains ${ttsNumericResidue} Arabic digits.` });
  if (charsPerSecond > config.quality.maxCharsPerSecond) issues.push({ severity: "error", code: "speech_too_fast", message: `Narration density ${charsPerSecond.toFixed(1)} chars/s exceeds ${config.quality.maxCharsPerSecond}.` });
  if (charsPerSecond > 0 && charsPerSecond < config.quality.minCharsPerSecond) issues.push({ severity: "error", code: "speech_too_slow", message: `Narration density ${charsPerSecond.toFixed(1)} chars/s is below ${config.quality.minCharsPerSecond}.` });
  if (segmentRates.length >= 2 && segmentSpeedRatio > config.quality.maxSegmentSpeedRatio) issues.push({ severity: "error", code: "segment_speed_uneven", message: `Scene speech speed ratio ${segmentSpeedRatio.toFixed(2)} exceeds ${config.quality.maxSegmentSpeedRatio}.` });
  if (segmentRates.length >= 3 && segmentSpeedCv > config.quality.maxSegmentSpeedCv) issues.push({ severity: "error", code: "segment_speed_variance", message: `Scene speech speed variation ${(segmentSpeedCv * 100).toFixed(1)}% exceeds ${(config.quality.maxSegmentSpeedCv * 100).toFixed(0)}%.` });

  const structural = await runAudioStructuralGate({ project, targetSeconds, config, signal, probe: dependencies.structuralProbe });
  issues.push(...structural.issues);
  let semantic = { issues: [] as QualityIssueInput[], results: [] as Array<Record<string, string | number | boolean>>, titleTranscript: "", titleAudioCoverage: 0, metrics: { semanticVerifiedCount: 0, semanticAsrCacheHit: false, semanticAsrProvider: config.asr.provider } };
  let pronunciation = { issues: [] as QualityIssueInput[], metrics: { pronunciationCheckedScenes: "", pronunciationRiskSpanCount: 0, pronunciationVerifierCalls: 0 } };
  if (structural.passed && !config.asr.disabled) {
    try {
      semantic = await runAudioSemanticGate({ project, config, signal, transcribe: dependencies.transcribe });
      issues.push(...semantic.issues);
      const titleInconclusive = semantic.issues.some((issue) => issue.code === "verification_inconclusive" && issue.sceneIndex === 0);
      if (!titleInconclusive && semantic.titleTranscript) {
        const actualTitle = canonicalSpeechText(semantic.titleTranscript);
        const expectedHook = canonicalSpeechText(project.meta.title.split(/[，,]/)[0] ?? project.meta.title).slice(0, 24);
        if (!actualTitle.startsWith(expectedHook)) issues.push({ severity: "error", code: "audio_title_opening_missing", message: "Narration does not start with the title.", sceneIndex: 0 });
        if (semantic.titleAudioCoverage < config.asr.titleCoverageMin) issues.push({ severity: "error", code: "audio_title_incomplete", message: `Title coverage ${(semantic.titleAudioCoverage * 100).toFixed(1)}% is below ${(config.asr.titleCoverageMin * 100).toFixed(0)}%.`, sceneIndex: 0 });
      }
    } catch (error) {
      issues.push({ severity: "warning", code: "verification_inconclusive", message: `Semantic ASR unavailable: ${(error as Error).message}`, issueClass: "environment", repairAction: "retry-stage", retryable: true, evidence: { verifier: config.asr.provider, reason: "semantic_asr_failed", verifierActions: ["retry-verifier", "switch-asr-provider", "inject-entity-hotwords"] } });
    }
    pronunciation = await runAudioPronunciationGate({ project, config, signal, verify: dependencies.pronunciationVerify });
    issues.push(...pronunciation.issues);
  }

  const minimumDuration = targetSeconds * config.quality.minDurationFactor;
  const maximumDuration = targetSeconds * config.quality.maxDurationFactor;
  return finalizeQualityEvaluation({
    stage: "audio",
    issues,
    revisionNotes: issues.some((issue) => issue.code === "duration_out_of_range") ? [duration < minimumDuration ? "Allow a naturally shorter video instead of padding narration." : "Reduce narration length instead of accelerating speech further."] : [],
    metrics: {
      targetSeconds,
      audioDuration: duration,
      charsPerSecond: Number(charsPerSecond.toFixed(2)),
      segmentCharsPerSecond: segmentRates.map((value) => Number(value.toFixed(2))).join(", "),
      segmentSpeedRatio: Number(segmentSpeedRatio.toFixed(3)),
      segmentSpeedCv: Number(segmentSpeedCv.toFixed(3)),
      firstToMedianSpeed: Number(firstToMedianSpeed.toFixed(3)),
      maximumSegmentSpeedRatio: config.quality.maxSegmentSpeedRatio,
      maximumSegmentSpeedCv: config.quality.maxSegmentSpeedCv,
      ttsNumericResidue,
      minimumDuration,
      maximumDuration,
      titleTranscript: semantic.titleTranscript,
      titleAudioCoverage: Number(semantic.titleAudioCoverage.toFixed(3)),
      sceneAsrVerifiedCount: semantic.results.length,
      sceneAsrInconclusiveCount: semantic.issues.filter((issue) => issue.code === "verification_inconclusive").length,
      sceneAsrResults: JSON.stringify(semantic.results),
      ...structural.metrics,
      ...semantic.metrics,
      ...pronunciation.metrics,
    },
  });
}
