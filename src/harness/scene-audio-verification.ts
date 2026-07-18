import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { runExternalProcess } from "../pipeline/external-operation";
import { prepareF5SynthesisText } from "../pipeline/tts";
import type { NarrationSegment, VideoProject } from "../pipeline/types";
import { fromRoot } from "../pipeline/utils";
import { resolvePythonCommand } from "../runtime/runtime-paths";
import type { QualityIssueInput } from "./quality-protocol";
import { canonicalSpeechText } from "./speech-normalization";

const asrSceneTranscriptSchema = z.object({
  sceneIndex: z.number().int().nonnegative(),
  text: z.string(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  detectedLanguage: z.string().min(1).optional(),
  languageConfidence: z.number().min(0).max(1).optional(),
  words: z.array(z.object({
    text: z.string(),
    startSeconds: z.number().nonnegative(),
    endSeconds: z.number().nonnegative(),
    confidence: z.number().min(0).max(1).nullable().optional(),
  })).optional(),
});
const asrBatchResponseSchema = z.object({ segments: z.array(asrSceneTranscriptSchema) });

export type AsrSceneTranscript = z.infer<typeof asrSceneTranscriptSchema>;

function audioFilePath(project: VideoProject) {
  if (!project.audio?.src) throw new Error("Audio source is missing.");
  return project.audio.src.startsWith("/generated/")
    ? fromRoot("public", ...project.audio.src.replace(/^\/+/, "").split("/"))
    : path.resolve(project.audio.src);
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>) {
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  }));
}

function runCapture(command: string, args: string[], signal?: AbortSignal) {
  return runExternalProcess(command, args, {
    signal,
    retries: 1,
    retryOnExit: true,
    timeoutMs: Number(process.env.QUALITY_PROCESS_TIMEOUT_MS ?? 300_000),
  });
}

export function storedNarrationSceneTranscripts(project: VideoProject): AsrSceneTranscript[] | null {
  const segments = project.narrationSegments ?? [];
  if (!segments.length || segments.some((segment) => !segment.speechAlignment?.transcript || !segment.speechAlignment.detectedLanguage || segment.speechAlignment.languageConfidence === undefined)) return null;
  return segments.map((segment) => ({
    sceneIndex: segment.sceneIndex,
    text: segment.speechAlignment!.transcript,
    confidence: segment.speechAlignment!.confidence,
    detectedLanguage: segment.speechAlignment!.detectedLanguage,
    languageConfidence: segment.speechAlignment!.languageConfidence,
    words: segment.speechAlignment!.words.map((word) => ({
      text: word.text,
      startSeconds: word.startMs / 1000,
      endSeconds: word.endMs / 1000,
      confidence: word.confidence,
    })),
  }));
}

export async function transcribeNarrationScenes(project: VideoProject, signal?: AbortSignal) {
  if (process.env.ASR_DISABLED === "1" || !project.audio?.src) return null;
  const segments = project.narrationSegments ?? [];
  if (!segments.length || segments.some((segment) => segment.audioStartSeconds === undefined || segment.durationSeconds === undefined)) {
    throw new Error("Scene ASR requires narration segment timing.");
  }
  const workDir = await mkdtemp(path.join(tmpdir(), "scene-gen-scene-asr-"));
  const sourceAudio = audioFilePath(project);
  try {
    const requests = segments.map((segment) => ({
      sceneIndex: segment.sceneIndex,
      audio: path.join(workDir, `scene-${String(segment.sceneIndex + 1).padStart(2, "0")}.wav`),
    }));
    const preparationConcurrency = Math.max(1, Math.floor(Number(process.env.ASR_PREP_CONCURRENCY ?? 2) || 2));
    await mapWithConcurrency(requests, preparationConcurrency, async (request, index) => {
      const segment = segments[index];
      await runCapture("ffmpeg", [
        "-y", "-ss", String(segment.audioStartSeconds), "-i", sourceAudio,
        "-t", String(segment.durationSeconds), "-ar", "16000", "-ac", "1", request.audio,
      ], signal);
    });
    const requestFile = path.join(workDir, "request.json");
    await writeFile(requestFile, JSON.stringify({ segments: requests, wordTimestamps: true }), "utf8");
    const result = await runCapture(resolvePythonCommand(), [
      fromRoot("scripts", "transcribe-audio.py"),
      "--request-file", requestFile,
      "--model", process.env.ASR_MODEL ?? "openai/whisper-tiny",
      "--language", process.env.ASR_LANGUAGE ?? "chinese",
    ], signal);
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    return asrBatchResponseSchema.parse(JSON.parse(lines.at(-1) ?? "{}")).segments;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function sequenceMetrics(expected: string, actual: string) {
  const left = [...expected];
  const right = [...actual];
  const previous = new Array(right.length + 1).fill(0);
  for (const leftToken of left) {
    let diagonal = 0;
    for (let index = 1; index <= right.length; index += 1) {
      const saved = previous[index];
      previous[index] = leftToken === right[index - 1] ? diagonal + 1 : Math.max(previous[index], previous[index - 1]);
      diagonal = saved;
    }
  }
  const matched = previous[right.length];
  return { coverage: matched / Math.max(1, left.length), precision: matched / Math.max(1, right.length) };
}

function extractNumberUnits(text: string) {
  const prepared = canonicalSpeechText(prepareF5SynthesisText(text));
  return [...new Set(prepared.match(/(?:百分之[零一二三四五六七八九十百千万亿两点]+|v?[零一二三四五六七八九十百千万亿两点]+(?:点[零一二三四五六七八九十]+)+|第?[零一二三四五六七八九十百千万亿两点]+)/gi) ?? [])]
    .filter((value) => value.length > 1);
}

function expectedEntities(project: VideoProject, segment: NarrationSegment) {
  const claimIds = new Set(segment.claimIds ?? []);
  const expectedText = canonicalSpeechText(prepareF5SynthesisText(segment.ttsText ?? segment.text));
  const claimEntities = project.factLedger?.claims
    .filter((claim) => claimIds.has(claim.id))
    .flatMap((claim) => [claim.subject, /[a-zA-Z]|\d/.test(claim.value) ? claim.value : ""])
    .map(canonicalSpeechText)
    .filter((value) => value.length >= 2 && expectedText.includes(value)) ?? [];
  const textualEntities = (segment.ttsText ?? segment.text).match(/[A-Za-z][A-Za-z0-9._+-]{1,}|[A-Za-z]+(?:\s+[A-Za-z0-9._+-]+)+|v\d+(?:\.\d+)+/g) ?? [];
  return [...new Set([...claimEntities, ...textualEntities.map(canonicalSpeechText)].filter((value) => value.length >= 2))];
}
function bigramRecall(expected: string, actual: string) {
  if (expected.length < 2) return actual.includes(expected) ? 1 : 0;
  const bigrams = Array.from({ length: expected.length - 1 }, (_, index) => expected.slice(index, index + 2));
  return bigrams.filter((token) => actual.includes(token)).length / bigrams.length;
}

function boundaryRecall(expected: string, actual: string, edge: "start" | "end") {
  return Math.max(...[6, 10, 14, 18]
    .filter((length) => expected.length >= length)
    .map((length) => bigramRecall(edge === "start" ? expected.slice(0, length) : expected.slice(-length), actual)), 0);
}

export function verifySceneTranscripts(project: VideoProject, transcripts: AsrSceneTranscript[], options: { expectedLanguage?: string; minimumLanguageConfidence?: number; minimumConfidence?: number } = {}) {
  const issues: QualityIssueInput[] = [];
  const results: Array<Record<string, string | number | boolean>> = [];
  const transcriptMap = new Map(transcripts.map((transcript) => [transcript.sceneIndex, transcript]));
  const segments = project.narrationSegments ?? [];
  const minimumConfidence = options.minimumConfidence ?? Number(process.env.ASR_SCENE_CONFIDENCE_MIN ?? 0.65);
  const minimumCoverage = Number(process.env.ASR_SCENE_TOKEN_COVERAGE_MIN ?? 0.78);
  const minimumPrecision = Number(process.env.ASR_SCENE_TOKEN_PRECISION_MIN ?? 0.75);
  const minimumEntityRecall = Number(process.env.ASR_ENTITY_RECALL_MIN ?? 0.8);
  const boundaryLeakMinimum = Number(process.env.ASR_BOUNDARY_LEAK_MIN ?? 0.55);
  const endingRecallMinimum = Number(process.env.ASR_ENDING_RECALL_MIN ?? 0.62);

  for (const segment of segments) {
    const transcript = transcriptMap.get(segment.sceneIndex);
    if (!transcript) {
      issues.push({ severity: "warning", code: "verification_inconclusive", message: `第 ${segment.sceneIndex + 1} 屏没有 ASR 结果。`, sceneIndex: segment.sceneIndex, issueClass: "environment", repairAction: "retry-stage", retryable: true, evidence: { reason: "missing_transcript" } });
      continue;
    }
    const expectedText = canonicalSpeechText(prepareF5SynthesisText(segment.ttsText ?? segment.text));
    const actualText = canonicalSpeechText(transcript.text);
    const confidence = transcript.confidence ?? undefined;
    const expectedLanguage = options.expectedLanguage?.toLowerCase();
    const detectedLanguage = transcript.detectedLanguage?.toLowerCase();
    const languageConfidence = transcript.languageConfidence;
    const sequence = sequenceMetrics(expectedText, actualText);
    const entities = expectedEntities(project, segment);
    const matchedEntities = entities.filter((entity) => actualText.includes(entity));
    const entityRecall = matchedEntities.length / Math.max(1, entities.length);
    const expectedNumbers = extractNumberUnits(segment.ttsText ?? segment.text);
    const actualNumbers = extractNumberUnits(transcript.text);
    const numberAccuracy = expectedNumbers.filter((value) => actualNumbers.includes(value)).length / Math.max(1, expectedNumbers.length);
    const endingRecall = boundaryRecall(expectedText, actualText, "end");
    results.push({ sceneIndex: segment.sceneIndex, transcript: transcript.text, asrConfidence: confidence ?? -1, detectedLanguage: detectedLanguage ?? "unknown", languageConfidence: languageConfidence ?? -1, tokenCoverage: Number(sequence.coverage.toFixed(3)), tokenPrecision: Number(sequence.precision.toFixed(3)), entityRecall: Number(entityRecall.toFixed(3)), numberAccuracy: Number(numberAccuracy.toFixed(3)), endingRecall: Number(endingRecall.toFixed(3)) });

    if (expectedLanguage && (!detectedLanguage || languageConfidence === undefined)) {
      issues.push({ severity: "error", code: "asr_verification_failed", message: `第 ${segment.sceneIndex + 1} 屏缺少独立语言检测结果，不能确认语音为中文。`, sceneIndex: segment.sceneIndex, issueClass: "environment", repairAction: "check-environment", retryable: false, evidence: { transcript: transcript.text, reason: "missing_language_detection", expectedLanguage } });
      continue;
    }
    if (expectedLanguage && (detectedLanguage !== expectedLanguage || languageConfidence! < (options.minimumLanguageConfidence ?? 0.5))) {
      issues.push({ severity: "error", code: "audio_language_mismatch", message: `第 ${segment.sceneIndex + 1} 屏语音语言检测未达到中文要求。`, sceneIndex: segment.sceneIndex, repairAction: "resynthesize-audio", retryable: true, evidence: { transcript: transcript.text, expectedLanguage, detectedLanguage: detectedLanguage ?? "unknown", languageConfidence: languageConfidence ?? 0, minimumLanguageConfidence: options.minimumLanguageConfidence ?? 0.5 } });
      continue;
    }

    if (confidence === undefined) {
      issues.push({ severity: "warning", code: "verification_inconclusive", message: `第 ${segment.sceneIndex + 1} 屏 ASR 未提供置信度，未触发内容重建。`, sceneIndex: segment.sceneIndex, issueClass: "soft", repairAction: "retry-stage", retryable: true, evidence: { transcript: transcript.text, reason: "missing_confidence" } });
      continue;
    }
    if (confidence < minimumConfidence) {
      issues.push({ severity: "warning", code: "verification_inconclusive", message: `第 ${segment.sceneIndex + 1} 屏 ASR 置信度 ${(confidence * 100).toFixed(1)}% 过低，未触发内容重建。`, sceneIndex: segment.sceneIndex, issueClass: "soft", repairAction: "retry-stage", retryable: true, evidence: { transcript: transcript.text, asrConfidence: confidence, minimumConfidence } });
      continue;
    }
    if (entities.length && entityRecall < minimumEntityRecall) {
      issues.push({ severity: "error", code: "audio_entity_mismatch", message: `第 ${segment.sceneIndex + 1} 屏产品名、人名或关键实体不完整。`, sceneIndex: segment.sceneIndex, repairAction: "retry-stage", retryable: true, issueClass: "environment", evidence: { expectedEntities: entities, matchedEntities, transcript: transcript.text, entityRecall: Number(entityRecall.toFixed(3)), asrConfidence: confidence ?? "unknown", verifierActions: ["retry-verifier", "switch-asr-provider", "inject-entity-hotwords"] } });
    }
    if (expectedNumbers.length && numberAccuracy < 1) {
      issues.push({ severity: "error", code: "audio_number_mismatch", message: `第 ${segment.sceneIndex + 1} 屏数字、单位或版本号与旁白不一致。`, sceneIndex: segment.sceneIndex, repairAction: "retry-stage", retryable: true, issueClass: "environment", evidence: { expectedNumbers, transcriptNumbers: actualNumbers, transcript: transcript.text, numberAccuracy: Number(numberAccuracy.toFixed(3)), asrConfidence: confidence ?? "unknown", verifierActions: ["retry-verifier", "switch-asr-provider", "inject-entity-hotwords"] } });
    }
    const semanticMismatch = sequence.coverage < minimumCoverage || sequence.precision < minimumPrecision;
    if (semanticMismatch) {
      issues.push({ severity: "error", code: "audio_semantic_mismatch", message: `第 ${segment.sceneIndex + 1} 屏 ASR 转写与旁白语义覆盖不足，需要重试或切换验证器。`, sceneIndex: segment.sceneIndex, repairAction: "retry-stage", retryable: true, issueClass: "environment", evidence: { transcript: transcript.text, tokenCoverage: Number(sequence.coverage.toFixed(3)), tokenPrecision: Number(sequence.precision.toFixed(3)), asrConfidence: confidence ?? "unknown", verifierActions: ["retry-verifier", "switch-asr-provider", "inject-entity-hotwords"] } });
    }
    const isFinalSegment = segment.sceneIndex === segments.at(-1)?.sceneIndex;
    if (isFinalSegment && !semanticMismatch && expectedText.length >= 12 && endingRecall < endingRecallMinimum) {
      issues.push({ severity: "error", code: "audio_semantic_mismatch", message: `Scene ${segment.sceneIndex + 1} narration ending could not be confirmed by ASR.`, sceneIndex: segment.sceneIndex, repairAction: "retry-stage", retryable: true, issueClass: "environment", evidence: { transcript: transcript.text, endingRecall: Number(endingRecall.toFixed(3)), endingRecallMinimum, expectedTail: expectedText.slice(-18), actualTail: actualText.slice(-18), asrConfidence: confidence ?? "unknown", verifierActions: ["retry-verifier", "switch-asr-provider"] } });
    }
    const currentStart = expectedText.slice(0, 18);
    const currentEnd = expectedText.slice(-18);
    const actualStart = actualText.slice(0, 18);
    const actualEnd = actualText.slice(-18);
    const previous = segments[segment.sceneIndex - 1];
    const next = segments[segment.sceneIndex + 1];
    const previousExpected = previous ? canonicalSpeechText(prepareF5SynthesisText(previous.ttsText ?? previous.text)) : "";
    const nextExpected = next ? canonicalSpeechText(prepareF5SynthesisText(next.ttsText ?? next.text)) : "";
    const previousLeak = previousExpected ? boundaryRecall(previousExpected, actualStart, "end") : 0;
    const nextLeak = nextExpected ? boundaryRecall(nextExpected, actualEnd, "start") : 0;
    if ((previousLeak >= boundaryLeakMinimum && previousLeak > bigramRecall(currentStart, actualStart) + 0.15) || (nextLeak >= boundaryLeakMinimum && nextLeak > bigramRecall(currentEnd, actualEnd) + 0.15)) {
      issues.push({ severity: "error", code: "audio_segment_cross_talk", message: `第 ${segment.sceneIndex + 1} 屏音频疑似包含相邻场景旁白。`, sceneIndex: segment.sceneIndex, repairAction: "retry-stage", retryable: true, issueClass: "environment", evidence: { transcript: transcript.text, previousLeak: Number(previousLeak.toFixed(3)), nextLeak: Number(nextLeak.toFixed(3)), asrConfidence: confidence ?? "unknown", verifierActions: ["retry-verifier", "switch-asr-provider", "inject-entity-hotwords"] } });
    }
  }
  const firstTranscript = transcriptMap.get(0)?.text ?? "";
  const expectedTitle = canonicalSpeechText(prepareF5SynthesisText(project.meta.title));
  const actualOpening = canonicalSpeechText(firstTranscript).slice(0, Math.max(expectedTitle.length + 8, 18));
  const titleAudioCoverage = firstTranscript ? bigramRecall(expectedTitle, canonicalSpeechText(firstTranscript)) : 0;
  const titleOpeningCoverage = firstTranscript ? bigramRecall(expectedTitle, actualOpening) : 0;
  const firstConfidence = transcriptMap.get(0)?.confidence;
  const expectedPrefix = canonicalSpeechText(prepareF5SynthesisText(segments[0]?.ttsText ?? segments[0]?.text ?? project.meta.title)).slice(0, 10);
  const expectedOpeningAnchor = expectedPrefix.slice(0, 6);
  const openingPrefixCoverage = firstTranscript ? bigramRecall(expectedOpeningAnchor, actualOpening.slice(0, expectedOpeningAnchor.length + 3)) : 0;
  if (firstTranscript && typeof firstConfidence === "number" && firstConfidence >= 0.68 && openingPrefixCoverage < 0.5) {
    issues.push({ severity: "error", code: "audio_opening_mismatch", message: "首屏旁白开头与合成文本不一致，先重试验证器确认是否存在首词漏读或变音。", sceneIndex: 0, repairAction: "retry-stage", retryable: true, issueClass: "environment", evidence: { expectedPrefix, transcript: firstTranscript, openingPrefixCoverage: Number(openingPrefixCoverage.toFixed(3)), asrConfidence: firstConfidence, verifierActions: ["retry-verifier", "switch-asr-provider", "inject-entity-hotwords"] } });
  }
  return { issues, results, titleTranscript: firstTranscript, titleAudioCoverage, titleOpeningCoverage };
}
