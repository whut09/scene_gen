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

function runCapture(command: string, args: string[], signal?: AbortSignal) {
  return runExternalProcess(command, args, {
    signal,
    retries: 1,
    retryOnExit: true,
    timeoutMs: getRuntimeConfig().rendering.processTimeoutMs,
  });
}


async function sampleMotionMetrics(videoPath: string, sceneDurations: number[] = [], signal?: AbortSignal) {
  const capture = await runCapture("ffmpeg", [
    "-v", "error", "-i", videoPath, "-map", "0:v:0", "-an",
    "-vf", "fps=2,scale=64:64,select='gte(scene,0)',metadata=print:file=-", "-f", "null", "-",
  ], signal);
  const scores = [...capture.stdout.matchAll(/lavfi\.scene_score=([0-9.]+)/g)].map((match) => Number(match[1]));
  const threshold = getRuntimeConfig().rendering.motionSceneThreshold;
  function summarize(values: number[]) {
    if (values.length < 2) return { activeMotionRatio: 1, meanSceneChange: 0, longestStaticRun: 0 };
    let currentStatic = 0;
    let longestStatic = 0;
    let active = 0;
    for (const score of values.slice(1)) {
      if (score >= threshold) { active += 1; currentStatic = 0; }
      else { currentStatic += 1; longestStatic = Math.max(longestStatic, currentStatic); }
    }
    return {
      activeMotionRatio: Number((active / Math.max(1, values.length - 1)).toFixed(3)),
      meanSceneChange: Number((values.reduce((sum, score) => sum + score, 0) / values.length).toFixed(6)),
      longestStaticRun: Number((longestStatic / 2).toFixed(2)),
    };
  }
  const global = summarize(scores);
  const boundaries = sceneDurations.reduce<number[]>((items, value) => [...items, (items.at(-1) ?? 0) + value], []);
  const sceneMotion = sceneDurations.map((_, sceneIndex) => {
    const start = sceneIndex === 0 ? 0 : boundaries[sceneIndex - 1];
    const end = boundaries[sceneIndex];
    const values = scores.filter((__, frameIndex) => frameIndex / 2 >= start && frameIndex / 2 < end);
    return { sceneIndex, ...summarize(values) };
  });
  return { sampledFrames: scores.length, ...global, sceneMotion };
}

async function probeMediaDuration(filePath: string, signal?: AbortSignal) {
  const probe = await runCapture("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath,
  ], signal);
  const duration = Number(probe.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Invalid media duration for ${filePath}.`);
  return duration;
}

export interface VideoDurationDiagnosis {
  likelySource: "mux" | "concat" | "scene" | "unknown";
  confidence: number;
  invalidSceneIndexes: string[];
  sceneDurationDeltas: string[];
  silentVideoDurationSeconds?: number;
  expectedSceneDurationSeconds?: number;
}

export async function diagnoseVideoDurationDrift(input: {
  htmlVideoGraphPath?: string;
  expectedDuration: number;
  signal?: AbortSignal;
  probeDuration?: (filePath: string, signal?: AbortSignal) => Promise<number>;
}): Promise<VideoDurationDiagnosis> {
  if (!input.htmlVideoGraphPath || !existsSync(input.htmlVideoGraphPath)) {
    return { likelySource: "unknown", confidence: 0.55, invalidSceneIndexes: [], sceneDurationDeltas: [] };
  }
  try {
    const graph = (await readHtmlVideoContentGraphFile(input.htmlVideoGraphPath)).value;
    const workDir = path.dirname(input.htmlVideoGraphPath);
    const probeDuration = input.probeDuration ?? probeMediaDuration;
    const invalidSceneIndexes: string[] = [];
    const sceneDurationDeltas: string[] = [];
    for (const node of graph.nodes) {
      const sceneVideoPath = path.join(workDir, `${node.id}-${node.templateId}.mp4`);
      if (!existsSync(sceneVideoPath)) {
        invalidSceneIndexes.push(String(node.sceneIndex));
        sceneDurationDeltas.push(`${node.sceneIndex}:missing`);
        continue;
      }
      const actualDuration = await probeDuration(sceneVideoPath, input.signal).catch(() => 0);
      const delta = Math.abs(actualDuration - node.durationSec);
      if (!actualDuration || delta > 0.15) invalidSceneIndexes.push(String(node.sceneIndex));
      sceneDurationDeltas.push(`${node.sceneIndex}:${delta.toFixed(3)}`);
    }
    const expectedSceneDurationSeconds = graph.nodes.reduce((sum, node) => sum + node.durationSec, 0);
    const silentVideoPath = path.join(workDir, "video-no-audio.mp4");
    const silentVideoDurationSeconds = existsSync(silentVideoPath)
      ? await probeDuration(silentVideoPath, input.signal).catch(() => undefined)
      : undefined;
    if (invalidSceneIndexes.length) {
      return { likelySource: "scene", confidence: 0.96, invalidSceneIndexes, sceneDurationDeltas, silentVideoDurationSeconds, expectedSceneDurationSeconds };
    }
    if (silentVideoDurationSeconds !== undefined && Math.abs(silentVideoDurationSeconds - expectedSceneDurationSeconds) > 0.2) {
      return { likelySource: "concat", confidence: 0.92, invalidSceneIndexes, sceneDurationDeltas, silentVideoDurationSeconds, expectedSceneDurationSeconds };
    }
    if (silentVideoDurationSeconds !== undefined && Math.abs(silentVideoDurationSeconds - input.expectedDuration) <= 0.2) {
      return { likelySource: "mux", confidence: 0.9, invalidSceneIndexes, sceneDurationDeltas, silentVideoDurationSeconds, expectedSceneDurationSeconds };
    }
    return { likelySource: "unknown", confidence: 0.65, invalidSceneIndexes, sceneDurationDeltas, silentVideoDurationSeconds, expectedSceneDurationSeconds };
  } catch {
    return { likelySource: "unknown", confidence: 0.5, invalidSceneIndexes: [], sceneDurationDeltas: [] };
  }
}

export async function evaluateVideo(
  videoPath: string,
  reportDir: string,
  expectedDuration?: number,
  sceneDurations: number[] = [],
  signal?: AbortSignal,
  options: { visualAuditPath?: string; htmlVideoGraphPath?: string; project?: VideoProject } = {},
  config: RuntimeConfig = getRuntimeConfig(),
): Promise<QualityEvaluation> {
  const issues: QualityIssueInput[] = [];
  const probe = await runCapture("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration,size",
    "-show_entries",
    "stream=codec_type,duration,width,height",
    "-of",
    "json",
    videoPath,
  ], signal);
  const data = JSON.parse(probe.stdout) as {
    format?: { duration?: string; size?: string };
    streams?: Array<{ codec_type?: string; duration?: string; width?: number; height?: number }>;
  };
  const video = data.streams?.find((stream) => stream.codec_type === "video");
  const audio = data.streams?.find((stream) => stream.codec_type === "audio");
  const duration = Number(data.format?.duration ?? 0);
  if (!video || !audio) issues.push({ severity: "error", code: "stream_missing", message: "成片缺少视频流或音频流。" });
  if (video?.width !== 1080 || video?.height !== 1920) {
    issues.push({ severity: "error", code: "wrong_dimensions", message: `成片尺寸不是 1080x1920。` });
  }
  if (expectedDuration && Math.abs(duration - expectedDuration) > 0.25) {
    const videoDuration = Number(video?.duration ?? duration);
    const audioDuration = Number(audio?.duration ?? duration);
    const projectStreamDelta = Math.abs(videoDuration - audioDuration);
    const diagnosis = await diagnoseVideoDurationDrift({ htmlVideoGraphPath: options.htmlVideoGraphPath, expectedDuration, signal });
    const likelySource = diagnosis.likelySource !== "unknown"
      ? diagnosis.likelySource
      : projectStreamDelta > 0.2 ? "mux" : "unknown";
    const confidence = diagnosis.likelySource !== "unknown"
      ? diagnosis.confidence
      : projectStreamDelta > 0.2 ? 0.92 : diagnosis.confidence;
    issues.push({
      severity: "error",
      code: "video_project_duration_drift",
      message: `视频 ${duration.toFixed(3)} 秒，与项目音频 ${expectedDuration.toFixed(3)} 秒不一致。`,
      evidence: {
        actualDurationSeconds: duration,
        expectedDurationSeconds: expectedDuration,
        deltaSeconds: Math.abs(duration - expectedDuration),
        videoStreamDurationSeconds: videoDuration,
        audioStreamDurationSeconds: audioDuration,
        streamDeltaSeconds: projectStreamDelta,
        likelySource,
        confidence,
        invalidSceneIndexes: diagnosis.invalidSceneIndexes,
        sceneDurationDeltas: diagnosis.sceneDurationDeltas,
        ...(diagnosis.silentVideoDurationSeconds === undefined ? {} : { silentVideoDurationSeconds: diagnosis.silentVideoDurationSeconds }),
        ...(diagnosis.expectedSceneDurationSeconds === undefined ? {} : { expectedSceneDurationSeconds: diagnosis.expectedSceneDurationSeconds }),
      },
    });
  }
  const streamDelta = Math.abs(Number(video?.duration ?? duration) - Number(audio?.duration ?? duration));
  if (streamDelta > 0.2) issues.push({ severity: "error", code: "stream_duration_drift", message: `音视频流相差 ${streamDelta.toFixed(3)} 秒。` });

  const motion = await sampleMotionMetrics(videoPath, sceneDurations, signal);
  if (motion.longestStaticRun >= 6 || motion.activeMotionRatio < 0.22) {
    issues.push({ severity: "warning", code: "video_motion_too_static", message: `画面连续静止约 ${motion.longestStaticRun.toFixed(1)} 秒，建议增加与旁白相关的元素运动或素材镜头。` });
  }
  for (const scene of motion.sceneMotion) {
    if (scene.longestStaticRun >= 6 || scene.activeMotionRatio < 0.18) {
      issues.push({ severity: "warning", code: "scene_motion_too_static", message: `第 ${scene.sceneIndex + 1} 屏有效运动比例 ${scene.activeMotionRatio}，最长低运动 ${scene.longestStaticRun.toFixed(1)} 秒。`, sceneIndex: scene.sceneIndex });
    }
  }

  let domAuditSceneCount = 0;
  let domAuditIssueCount = 0;
  if (options.visualAuditPath && existsSync(options.visualAuditPath)) {
    try {
      const visualAudit = await readVisualAuditFile(options.visualAuditPath);
      domAuditSceneCount = visualAudit.scenes.length;
      for (const scene of visualAudit.scenes) {
        for (const issue of scene.issues) {
          domAuditIssueCount += 1;
          issues.push({ severity: issue.severity, code: issue.code, message: issue.message, sceneIndex: scene.sceneIndex, evidence: issue.evidence });
        }
      }
    } catch (error) {
      issues.push({ severity: "warning", code: "visual_audit_unavailable", message: `无法读取 DOM 视觉审计：${(error as Error).message}`, issueClass: "environment", repairAction: "check-environment", retryable: false });
    }
  }

  await mkdir(reportDir, { recursive: true });
  const effectiveSceneDurations = sceneDurations.length ? sceneDurations : [duration];
  const frameMetrics: Array<{ sceneIndex: number; position: string; sampleTime: number; framePath: string; sizeBytes: number; lumaAverage: number; lumaRange: number; edgeDensity: number; blank: boolean; crop?: { width: number; height: number; x: number; y: number } }> = [];
  let sceneStart = 0;
  for (const [sceneIndex, sceneDuration] of effectiveSceneDurations.entries()) {
    const startOffset = Math.min(Math.max(0.6, sceneDuration * 0.15), Math.max(0.05, sceneDuration * 0.3));
    const samples = [
      { position: "start", offset: startOffset },
      { position: "middle", offset: sceneDuration * 0.5 },
      { position: "end", offset: Math.max(0.05, sceneDuration * 0.88) },
    ];
    for (const sample of samples) {
      const sampleTime = Math.min(Math.max(0, duration - 0.05), sceneStart + sample.offset);
      const framePath = path.join(reportDir, `scene-${String(sceneIndex + 1).padStart(2, "0")}-${sample.position}.jpg`);
    await runCapture("ffmpeg", [
      "-y",
      "-ss",
      sampleTime.toFixed(3),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      framePath,
    ], signal);
      const visual = await analyzeFrameVisual(framePath, signal);
      frameMetrics.push({ sceneIndex, position: sample.position, sampleTime, framePath, ...visual });
      const contentInset = visual.crop && (visual.crop.width < (video?.width ?? 0) * 0.94 || visual.crop.height < (video?.height ?? 0) * 0.94);
      if (contentInset) {
        issues.push({ severity: "error", code: "frame_content_inset", message: `第 ${sceneIndex + 1} 屏${sample.position}画面存在明显黑边、画布内缩或内容缺块。`, sceneIndex, repairAction: "rerender-scenes", retryable: true, evidence: { position: sample.position, sampleTime: Number(sampleTime.toFixed(3)), cropWidth: visual.crop!.width, cropHeight: visual.crop!.height, cropX: visual.crop!.x, cropY: visual.crop!.y, expectedWidth: video?.width ?? 0, expectedHeight: video?.height ?? 0 } });
      }
      if (visual.blank) {
        issues.push({ severity: "error", code: "blank_frame", message: `第 ${sceneIndex + 1} 屏${sample.position}抽帧可能为空白。`, sceneIndex, evidence: { position: sample.position, sampleTime: Number(sampleTime.toFixed(3)), sizeBytes: visual.sizeBytes, lumaRange: visual.lumaRange, edgeDensity: visual.edgeDensity } });
      } else if (visual.lumaRange < 14 && visual.edgeDensity < 0.012) {
        issues.push({ severity: "warning", code: "frame_low_visual_complexity", message: `第 ${sceneIndex + 1} 屏${sample.position}画面视觉信息偏少。`, sceneIndex, evidence: { position: sample.position, lumaRange: visual.lumaRange, edgeDensity: visual.edgeDensity } });
      }
    }
    sceneStart += sceneDuration;
  }

  let ocrVerifiedScenes = 0;
  if (config.rendering.ocr.enabled && options.project) {
    try {
      const command = config.rendering.ocr.command;
      for (const [sceneIndex, scene] of options.project.scenes.entries()) {
        const frame = frameMetrics.find((item) => item.sceneIndex === sceneIndex && item.position === "middle");
        if (!frame) continue;
        const result = await runCapture(command, [frame.framePath, "stdout", "-l", config.rendering.ocr.language, "--psm", "6"], signal);
        const expected = canonicalSpeechText(scene.headline);
        const actual = canonicalSpeechText(result.stdout);
        const tokens = expected.length < 2 ? [expected] : Array.from({ length: expected.length - 1 }, (_, index) => expected.slice(index, index + 2));
        const coverage = tokens.filter((token) => actual.includes(token)).length / Math.max(1, tokens.length);
        ocrVerifiedScenes += 1;
        if (coverage < config.rendering.ocr.keyTextMin) issues.push({ severity: "error", code: "key_text_ocr_missing", message: `第 ${sceneIndex + 1} 屏 OCR 未稳定识别关键标题。`, sceneIndex, evidence: { expected: scene.headline, transcript: result.stdout.trim(), coverage: Number(coverage.toFixed(3)) } });
      }
    } catch (error) {
      issues.push({ severity: "warning", code: "ocr_verification_unavailable", message: `OCR 视觉验证不可用：${(error as Error).message}`, issueClass: "environment", repairAction: "check-environment", retryable: false });
    }
  }

  return finalizeQualityEvaluation({
    stage: "video",
    issues,
    profile: { name: config.quality.profile, blockWarnings: config.quality.profile === "strict", blockingWarningCodes: [...config.quality.blockingWarningCodes] },
    revisionNotes: [],
    metrics: {
      duration,
      fileSize: Number(data.format?.size ?? 0),
      width: video?.width ?? 0,
      height: video?.height ?? 0,
      streamDelta,
      expectedDuration: expectedDuration ?? 0,
      projectDurationDelta: expectedDuration ? Math.abs(duration - expectedDuration) : 0,
      minimumFrameSize: Math.min(...frameMetrics.map((frame) => frame.sizeBytes)),
      minimumFrameLumaRange: Math.min(...frameMetrics.map((frame) => frame.lumaRange)),
      minimumFrameEdgeDensity: Math.min(...frameMetrics.map((frame) => frame.edgeDensity)),
      sceneFrameSampleCount: frameMetrics.length,
      sceneFrameMetrics: JSON.stringify(frameMetrics.map(({ framePath: _framePath, ...frame }) => frame)),
      domAuditSceneCount,
      domAuditIssueCount,
      ocrVerifiedScenes,
      sampledMotionFrames: motion.sampledFrames,
      activeMotionRatio: motion.activeMotionRatio,
      meanSceneChange: motion.meanSceneChange,
      longestStaticRun: motion.longestStaticRun,
      sceneMotionRatios: motion.sceneMotion.map((scene) => scene.activeMotionRatio.toFixed(3)).join(", "),
      sceneLongestStaticRuns: motion.sceneMotion.map((scene) => scene.longestStaticRun.toFixed(1)).join(", "),
    },
  });
}
