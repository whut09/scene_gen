import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { buildHtmlVideoContentGraph, readHtmlVideoContentGraphFile, type HtmlVideoContentGraph } from "../../html-video/content-graph";
import type { VideoProject, VideoScene } from "../../pipeline/types";
import { prepareF5SynthesisText } from "../../pipeline/tts";
import { getTemplateById } from "../../templates/template-registry";
import { buildProductionDecisions } from "../../production/visual-planner";
import { isNewsProject, projectNewsDate } from "../../pipeline/news-date";
import { runExternalProcess } from "../../pipeline/external-operation";
import { finalizeQualityEvaluation, type QualityEvaluation, type QualityIssueInput, type QualityProfile, type QualityScoreStatus } from "../quality-protocol";
import { getRuntimeConfig, type RuntimeConfig } from "../../config/runtime-config";
import { canonicalSpeechText } from "../speech-normalization";
import { findFactConflicts, highRiskPredicatesInText, sceneFactText } from "../../pipeline/fact-ledger";
import { storedNarrationSceneTranscripts, transcribeNarrationScenes, verifySceneTranscripts } from "../scene-audio-verification";
import { analyzeFrameVisual } from "../frame-visual-analysis";
import { readVisualAuditFile } from "../../html-video/visual-audit";

export async function evaluateAudio(project: VideoProject, targetSeconds: number, signal?: AbortSignal, config: RuntimeConfig = getRuntimeConfig()): Promise<QualityEvaluation> {
  const issues: QualityIssueInput[] = [];
  const segments = project.narrationSegments ?? [];
  const duration = project.audio?.durationSeconds ?? 0;
  const minimumDuration = targetSeconds * config.quality.minDurationFactor;
  const maximumDuration = targetSeconds * config.quality.maxDurationFactor;
  const narrationChars = project.narration.replace(/\s+/g, "").length;
  const charsPerSecond = duration > 0 ? narrationChars / duration : 0;
  const minimumCharsPerSecond = config.quality.minCharsPerSecond;
  const maximumCharsPerSecond = config.quality.maxCharsPerSecond;
  const segmentRates = segments
    .map((segment) => {
      const segmentDuration = segment.durationSeconds ?? 0;
      const chars = segment.text.replace(/\s+/g, "").length;
      return segmentDuration > 0 ? chars / segmentDuration : 0;
    })
    .filter((value) => value > 0);
  const sortedRates = [...segmentRates].sort((left, right) => left - right);
  const medianSegmentRate = sortedRates.length
    ? sortedRates.length % 2
      ? sortedRates[Math.floor(sortedRates.length / 2)]
      : (sortedRates[sortedRates.length / 2 - 1] + sortedRates[sortedRates.length / 2]) / 2
    : 0;
  const minimumSegmentRate = sortedRates[0] ?? 0;
  const maximumSegmentRate = sortedRates[sortedRates.length - 1] ?? 0;
  const segmentSpeedRatio = minimumSegmentRate > 0 ? maximumSegmentRate / minimumSegmentRate : 0;
  const meanSegmentRate = segmentRates.length ? segmentRates.reduce((sum, value) => sum + value, 0) / segmentRates.length : 0;
  const segmentSpeedCv = meanSegmentRate > 0
    ? Math.sqrt(segmentRates.reduce((sum, value) => sum + (value - meanSegmentRate) ** 2, 0) / segmentRates.length) / meanSegmentRate
    : 0;
  const firstToMedianSpeed = medianSegmentRate > 0 && segmentRates.length ? segmentRates[0] / medianSegmentRate : 0;
  const maximumSegmentSpeedRatio = config.quality.maxSegmentSpeedRatio;
  const maximumSegmentSpeedCv = config.quality.maxSegmentSpeedCv;
  const ttsNumericResidue = segments.reduce((count, segment) => {
    const prepared = prepareF5SynthesisText(segment.ttsText ?? segment.text);
    return count + (prepared.match(/\d/g)?.length ?? 0);
  }, 0);
  if (ttsNumericResidue > 0) {
    issues.push({ severity: "error", code: "tts_arabic_digits", message: `TTS 合成文本仍包含 ${ttsNumericResidue} 个阿拉伯数字，数字必须转换为中文播报。` });
  }
  if (!project.audio || project.audio.provider === "silent") {
    issues.push({ severity: "error", code: "audio_missing", message: "没有生成有效旁白音频。" });
  }
  if (duration < minimumDuration || duration > maximumDuration) {
    issues.push({ severity: "error", code: "duration_out_of_range", message: `音频 ${duration.toFixed(1)} 秒，建议范围 ${minimumDuration.toFixed(0)} 到 ${maximumDuration.toFixed(0)} 秒。` });
  }
  if (charsPerSecond > maximumCharsPerSecond) {
    issues.push({ severity: "error", code: "speech_too_fast", message: `旁白密度 ${charsPerSecond.toFixed(1)} 字/秒，超过自然播报上限 ${maximumCharsPerSecond} 字/秒。` });
  }
  if (charsPerSecond > 0 && charsPerSecond < minimumCharsPerSecond) {
    issues.push({ severity: "error", code: "speech_too_slow", message: `旁白密度 ${charsPerSecond.toFixed(1)} 字/秒，低于资讯播报下限 ${minimumCharsPerSecond} 字/秒。` });
  }
  if (segmentRates.length >= 2 && segmentSpeedRatio > maximumSegmentSpeedRatio) {
    issues.push({ severity: "error", code: "segment_speed_uneven", message: `逐屏语速最大相差 ${segmentSpeedRatio.toFixed(2)} 倍，超过 ${maximumSegmentSpeedRatio.toFixed(2)} 倍。` });
  }
  if (segmentRates.length >= 3 && segmentSpeedCv > maximumSegmentSpeedCv) {
    issues.push({ severity: "error", code: "segment_speed_variance", message: `逐屏语速离散度 ${(segmentSpeedCv * 100).toFixed(1)}%，超过 ${(maximumSegmentSpeedCv * 100).toFixed(0)}%。` });
  }
  let titleTranscript = "";
  let titleAudioCoverage = 0;
  let sceneAsrResults = "[]";
  let sceneAsrVerifiedCount = 0;
  let sceneAsrInconclusiveCount = 0;
  try {
    const transcripts = storedNarrationSceneTranscripts(project) ?? await transcribeNarrationScenes(project, signal);
    if (transcripts !== null) {
      const verification = verifySceneTranscripts(project, transcripts);
      issues.push(...verification.issues);
      titleTranscript = verification.titleTranscript;
      titleAudioCoverage = verification.titleAudioCoverage;
      sceneAsrResults = JSON.stringify(verification.results);
      sceneAsrVerifiedCount = verification.results.length;
      sceneAsrInconclusiveCount = verification.issues.filter((issue) => issue.code === "verification_inconclusive").length;
      const titleInconclusive = verification.issues.some((issue) => issue.code === "verification_inconclusive" && issue.sceneIndex === 0);
      const expectedTitle = canonicalSpeechText(project.meta.title);
      const actualTitle = canonicalSpeechText(titleTranscript);
      const hookSource = project.meta.title.split(/[：:]/)[0] ?? project.meta.title;
      const expectedHook = canonicalSpeechText(hookSource).slice(0, 24);
      if (!titleInconclusive) {
        if (!actualTitle.startsWith(expectedHook)) {
          issues.push({ severity: "error", code: "audio_title_opening_missing", message: `实际语音没有从标题开头播报。ASR：${titleTranscript}`, sceneIndex: 0 });
        }
        const minimumCoverage = config.asr.titleCoverageMin;
        if (titleAudioCoverage < minimumCoverage) {
          issues.push({ severity: "error", code: "audio_title_incomplete", message: `标题语音覆盖率 ${(titleAudioCoverage * 100).toFixed(1)}%，低于 ${(minimumCoverage * 100).toFixed(0)}%。`, sceneIndex: 0 });
        }
      }
    }
  } catch (error) {
    issues.push({ severity: "error", code: "asr_verification_failed", message: `无法执行逐场景语音验证：${(error as Error).message}` });
  }
  let cursor = 0;
  for (const [index, scene] of project.scenes.entries()) {
    const segment = segments[index];
    if (!segment || segment.audioStartSeconds === undefined || segment.durationSeconds === undefined) {
      issues.push({ severity: "error", code: "segment_timing_missing", message: `第 ${index + 1} 屏缺少音频时间信息。`, sceneIndex: index });
      continue;
    }
    const frameTolerance = 1 / project.meta.fps + 0.002;
    if (Math.abs(cursor - segment.audioStartSeconds) > frameTolerance || Math.abs(scene.duration - segment.durationSeconds) > frameTolerance) {
      issues.push({ severity: "error", code: "audio_scene_drift", message: `第 ${index + 1} 屏音画边界不一致。`, sceneIndex: index });
    }
    cursor += scene.duration;
  }
  return finalizeQualityEvaluation({
    stage: "audio",
    issues,
    revisionNotes: issues.some((issue) => issue.code === "duration_out_of_range")
      ? [duration < minimumDuration ? "允许视频自然缩短，不要用无关内容填充；必要时补充当前画面已展示的信息。" : "压缩旁白字数或允许视频自然延长，不要继续加快语速。"]
      : [],
    metrics: {
      targetSeconds,
      audioDuration: duration,
      sceneDuration: cursor,
      alignmentDelta: Math.abs(cursor - duration),
      charsPerSecond: Number(charsPerSecond.toFixed(2)),
      segmentCharsPerSecond: segmentRates.map((value) => Number(value.toFixed(2))).join(", "),
      segmentSpeedRatio: Number(segmentSpeedRatio.toFixed(3)),
      segmentSpeedCv: Number(segmentSpeedCv.toFixed(3)),
      firstToMedianSpeed: Number(firstToMedianSpeed.toFixed(3)),
      maximumSegmentSpeedRatio,
      maximumSegmentSpeedCv,
      ttsNumericResidue,
      minimumDuration,
      maximumDuration,
      titleTranscript,
      titleAudioCoverage: Number(titleAudioCoverage.toFixed(3)),
      sceneAsrVerifiedCount,
      sceneAsrInconclusiveCount,
      sceneAsrResults,
    },
  });
}

