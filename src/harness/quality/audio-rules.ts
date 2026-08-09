import type { RuntimeConfig } from "../../config/runtime-config";
import { getRuntimeConfig } from "../../config/runtime-config";
import type { VideoProject } from "../../pipeline/types";
import { acronymsRequiringSpelledLetters, spelledLatinAcronym } from "../../pipeline/pronunciation/provider-adapters";
import { prepareF5SynthesisText } from "../../pipeline/tts";
import { pronounceYearDigits } from "../../pipeline/tts/text-normalization";
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

export function narrationRateMetrics(project: VideoProject) {
  const segments = project.narrationSegments ?? [];
  const narrationChars = segments.length
    ? segments.reduce((sum, segment) => sum + (segment.providerSynthesisText ?? segment.ttsText ?? segment.text).replace(/\s+/g, "").length, 0)
    : project.narration.replace(/\s+/g, "").length;
  const segmentRates = segments.map((segment) => {
    const segmentDuration = segment.durationSeconds ?? 0;
    return segmentDuration > 0 ? (segment.providerSynthesisText ?? segment.ttsText ?? segment.text).replace(/\s+/g, "").length / segmentDuration : 0;
  }).filter((value) => value > 0);
  return { narrationChars, segmentRates };
}

export function ttsConventionIssues(project: VideoProject): QualityIssueInput[] {
  const issues: QualityIssueInput[] = [];
  for (const segment of project.narrationSegments ?? []) {
    const synthesisInput = segment.providerSynthesisText?.trim() || segment.ttsText?.trim() || segment.text;
    const prepared = prepareF5SynthesisText(synthesisInput);
    if (segment.pronunciationPlan && segment.pronunciationPlan.displayText !== segment.text) {
      issues.push({ severity: "error", code: "tts_derived_text_stale", message: `第 ${segment.sceneIndex + 1} 屏展示文本已修改，但发音计划仍来自旧文本。`, sceneIndex: segment.sceneIndex, repairAction: "resynthesize-audio", retryable: true, evidence: { displayText: segment.text, plannedDisplayText: segment.pronunciationPlan.displayText, pronunciationPlanHash: segment.pronunciationPlan.planHash } });
    }
    if ((segment.ttsProvider === "indextts" || segment.ttsProvider === "nvidia") && segment.providerSynthesisText) {
      for (const acronym of acronymsRequiringSpelledLetters(segment.text)) {
        const requiredReading = spelledLatinAcronym(acronym);
        const separatedLetters = new RegExp([...acronym].join("[\\s、，,。.;；:]+"), "i");
        if (!segment.providerSynthesisText.includes(requiredReading) || separatedLetters.test(segment.providerSynthesisText)) {
          issues.push({ severity: "error", code: "audio_acronym_plan_unprotected", message: `第 ${segment.sceneIndex + 1} 屏缩写 ${acronym} 的最终 TTS 输入没有连续发音。`, sceneIndex: segment.sceneIndex, repairAction: "resynthesize-audio", retryable: true, evidence: { acronym, requiredReading, provider: segment.ttsProvider, providerSynthesisText: segment.providerSynthesisText } });
        }
      }
    }
    for (const match of segment.text.matchAll(/(\d+)\s*[\/／]\s*(\d+)/g)) {
      const [, numerator, denominator] = match;
      const expected = `${prepareF5SynthesisText(denominator)}分之${prepareF5SynthesisText(numerator)}`;
      if (!prepared.includes(expected)) issues.push({ severity: "error", code: "tts_fraction_pronunciation_invalid", message: `第 ${segment.sceneIndex + 1} 屏分数 ${match[0]} 必须读作 ${expected}。`, sceneIndex: segment.sceneIndex, repairAction: "resynthesize-audio", retryable: true, evidence: { fraction: match[0], expected, synthesisText: prepared } });
    }
    const spellsAi = /(?:^|[^A-Za-z])A\s*[、，,。.;；:\s-]+\s*I(?:[^A-Za-z]|$)/i.test(synthesisInput);
    if (/\bAI\b/i.test(segment.text) && !/\bAI\b/i.test(synthesisInput) && !spellsAi && synthesisInput.includes("人工智能")) {
      issues.push({ severity: "error", code: "tts_ai_expanded", message: `第 ${segment.sceneIndex + 1} 屏把 AI 扩写成了“人工智能”，应保持 AI 字母读法。`, sceneIndex: segment.sceneIndex, repairAction: "resynthesize-audio", retryable: true, evidence: { displayText: segment.text, synthesisText: synthesisInput } });
    }
    const protectedLatinNames = segment.text.match(/\b[A-Za-z][A-Za-z0-9]*(?:\s+[A-Za-z][A-Za-z0-9]*)+\b/g) ?? [];
    for (const name of protectedLatinNames) {
      const normalizedName = canonicalSpeechText(prepareF5SynthesisText(name));
      if (!canonicalSpeechText(prepared).includes(normalizedName)) issues.push({ severity: "error", code: "tts_proper_name_translated", message: `Scene ${segment.sceneIndex + 1} translated or rewrote the protected name '${name}'.`, sceneIndex: segment.sceneIndex, repairAction: "resynthesize-audio", retryable: true, evidence: { properName: name, normalizedName, displayText: segment.text, synthesisText: synthesisInput } });
    }
    const normalizedTitle = project.meta.title.replace(/[\s。！？!?，,:："“”'‘’]/g, "").toLowerCase();
    const normalizedSynthesis = synthesisInput.replace(/[\s。！？!?，,:："“”'‘’]/g, "").toLowerCase();
    if (segment.sceneIndex === 0 && normalizedTitle.length >= 4 && normalizedSynthesis.split(normalizedTitle).length - 1 > 1) issues.push({ severity: "error", code: "title_spoken_repeated", message: "The opening TTS text repeats the full title.", sceneIndex: 0, repairAction: "revise-scenes", retryable: true, evidence: { title: project.meta.title, synthesisText: synthesisInput } });
    for (const year of segment.text.match(/(?<!\d)(?:19|20)\d{2}(?!\d|元|块|美元|人民币)/g) ?? []) {
      const expected = pronounceYearDigits(year);
      if (!prepared.includes(expected)) issues.push({ severity: "error", code: "tts_year_pronunciation_invalid", message: `第 ${segment.sceneIndex + 1} 屏年份 ${year} 必须逐位读作 ${expected}。`, sceneIndex: segment.sceneIndex, repairAction: "resynthesize-audio", retryable: true, evidence: { year, expected, synthesisText: prepared } });
    }
    for (const match of segment.text.matchAll(/(?<!\d)90后/g)) {
      if (!prepared.includes("九零后")) issues.push({ severity: "error", code: "tts_contextual_number_pronunciation_invalid", message: `第 ${segment.sceneIndex + 1} 屏“90后”必须读作“九零后”。`, sceneIndex: segment.sceneIndex, repairAction: "resynthesize-audio", retryable: true, evidence: { phrase: match[0], expected: "九零后", synthesisText: prepared } });
    }
    for (const match of segment.text.matchAll(/(?<!\d)2000(?=元|块|美元|人民币)/g)) {
      if (!prepared.includes("两千")) issues.push({ severity: "error", code: "tts_contextual_number_pronunciation_invalid", message: `第 ${segment.sceneIndex + 1} 屏“${match[0]}”必须按金额读作“两千”。`, sceneIndex: segment.sceneIndex, repairAction: "resynthesize-audio", retryable: true, evidence: { phrase: match[0], expected: "两千", synthesisText: prepared } });
    }
  }
  return issues;
}

export async function evaluateAudio(project: VideoProject, targetSeconds: number, signal?: AbortSignal, config: RuntimeConfig = getRuntimeConfig(), dependencies: AudioGateDependencies = {}): Promise<QualityEvaluation> {
  const issues: QualityIssueInput[] = [];
  issues.push(...ttsConventionIssues(project));
  const segments = project.narrationSegments ?? [];
  const duration = project.audio?.durationSeconds ?? 0;
  const { narrationChars, segmentRates } = narrationRateMetrics(project);
  const charsPerSecond = duration > 0 ? narrationChars / duration : 0;
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
  const providerNaturalSpeech = project.audio?.provider === "nvidia" || project.audio?.provider === "indextts";
  const minimumCharsPerSecond = providerNaturalSpeech ? Math.min(config.quality.minCharsPerSecond, 3.5) : config.quality.minCharsPerSecond;
  const maximumSegmentSpeedRatio = providerNaturalSpeech ? Math.max(config.quality.maxSegmentSpeedRatio, 1.65) : config.quality.maxSegmentSpeedRatio;
  const maximumSegmentSpeedCv = providerNaturalSpeech ? Math.max(config.quality.maxSegmentSpeedCv, 0.2) : config.quality.maxSegmentSpeedCv;

  if (ttsNumericResidue > 0) issues.push({ severity: "error", code: "tts_arabic_digits", message: `TTS synthesis text contains ${ttsNumericResidue} Arabic digits.` });
  if (charsPerSecond > config.quality.maxCharsPerSecond) issues.push({ severity: "error", code: "speech_too_fast", message: `Narration density ${charsPerSecond.toFixed(1)} chars/s exceeds ${config.quality.maxCharsPerSecond}.` });
  if (charsPerSecond > 0 && charsPerSecond < minimumCharsPerSecond) issues.push({ severity: "error", code: "speech_too_slow", message: `Narration density ${charsPerSecond.toFixed(1)} chars/s is below ${minimumCharsPerSecond}.` });
  if (segmentRates.length >= 2 && segmentSpeedRatio > maximumSegmentSpeedRatio) issues.push({ severity: "error", code: "segment_speed_uneven", message: `Scene speech speed ratio ${segmentSpeedRatio.toFixed(2)} exceeds ${maximumSegmentSpeedRatio}.` });
  if (segmentRates.length >= 3 && segmentSpeedCv > maximumSegmentSpeedCv) issues.push({ severity: "error", code: "segment_speed_variance", message: `Scene speech speed variation ${(segmentSpeedCv * 100).toFixed(1)}% exceeds ${(maximumSegmentSpeedCv * 100).toFixed(0)}%.` });

  const structural = await runAudioStructuralGate({ project, targetSeconds, config, signal, probe: dependencies.structuralProbe });
  issues.push(...structural.issues);
  let semantic = { issues: [] as QualityIssueInput[], results: [] as Array<Record<string, string | number | boolean>>, titleTranscript: "", titleAudioCoverage: 0, titleOpeningCoverage: 0, metrics: { semanticVerifiedCount: 0, semanticAsrCacheHit: false, semanticAsrProvider: config.asr.provider } };
  let pronunciation = { issues: [] as QualityIssueInput[], metrics: { pronunciationCheckedScenes: "", pronunciationRiskSpanCount: 0, pronunciationVerifierCalls: 0 } };
  if (structural.passed && !config.asr.disabled) {
    try {
      semantic = await runAudioSemanticGate({ project, config, signal, transcribe: dependencies.transcribe });
      issues.push(...semantic.issues);
      const titleInconclusive = semantic.issues.some((issue) => issue.code === "verification_inconclusive" && issue.sceneIndex === 0);
      if (!titleInconclusive && semantic.titleTranscript) {
        if (semantic.titleOpeningCoverage < config.asr.titleCoverageMin) issues.push({ severity: "error", code: "audio_title_opening_missing", message: `Title opening coverage ${(semantic.titleOpeningCoverage * 100).toFixed(1)}% is below ${(config.asr.titleCoverageMin * 100).toFixed(0)}%.`, sceneIndex: 0 });
        if (semantic.titleAudioCoverage < config.asr.titleCoverageMin) issues.push({ severity: "error", code: "audio_title_incomplete", message: `Title coverage ${(semantic.titleAudioCoverage * 100).toFixed(1)}% is below ${(config.asr.titleCoverageMin * 100).toFixed(0)}%.`, sceneIndex: 0 });
      }
    } catch (error) {
      const blocking = config.profile === "production" || config.quality.profile === "strict";
      issues.push({ severity: blocking ? "error" : "warning", code: blocking ? "asr_verification_failed" : "verification_inconclusive", message: `Semantic ASR unavailable: ${(error as Error).message}`, issueClass: "environment", repairAction: blocking ? "check-environment" : "retry-stage", retryable: !blocking, evidence: { verifier: config.asr.provider, reason: "semantic_asr_failed", verifierActions: ["retry-verifier", "switch-asr-provider", "inject-entity-hotwords"] } });
    }
    pronunciation = await runAudioPronunciationGate({ project, config, signal, verify: dependencies.pronunciationVerify });
    issues.push(...pronunciation.issues);
  }

  const minimumDuration = targetSeconds * config.quality.minDurationFactor;
  const maximumDuration = targetSeconds * config.quality.maxDurationFactor;
  return finalizeQualityEvaluation({
    stage: "audio",
    issues,
    profile: { name: config.quality.profile, blockWarnings: config.quality.profile === "strict", blockingWarningCodes: [...config.quality.blockingWarningCodes] },
    revisionNotes: issues.some((issue) => issue.code === "duration_out_of_range") ? [duration < minimumDuration ? "Allow a naturally shorter video instead of padding narration." : "Reduce narration length instead of accelerating speech further."] : [],
    metrics: {
      targetSeconds,
      audioDuration: duration,
      charsPerSecond: Number(charsPerSecond.toFixed(2)),
      segmentCharsPerSecond: segmentRates.map((value) => Number(value.toFixed(2))).join(", "),
      segmentSpeedRatio: Number(segmentSpeedRatio.toFixed(3)),
      segmentSpeedCv: Number(segmentSpeedCv.toFixed(3)),
      firstToMedianSpeed: Number(firstToMedianSpeed.toFixed(3)),
      minimumCharsPerSecond,
      maximumSegmentSpeedRatio,
      maximumSegmentSpeedCv,
      ttsNumericResidue,
      minimumDuration,
      maximumDuration,
      titleTranscript: semantic.titleTranscript,
      titleAudioCoverage: Number(semantic.titleAudioCoverage.toFixed(3)),
      titleOpeningCoverage: Number(semantic.titleOpeningCoverage.toFixed(3)),
      sceneAsrVerifiedCount: semantic.results.length,
      sceneAsrInconclusiveCount: semantic.issues.filter((issue) => issue.code === "verification_inconclusive").length,
      sceneAsrResults: JSON.stringify(semantic.results),
      ...structural.metrics,
      ...semantic.metrics,
      ...pronunciation.metrics,
    },
  });
}
