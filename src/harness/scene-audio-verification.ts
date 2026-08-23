import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { runExternalProcess } from "../pipeline/external-operation";
import { acronymsRequiringSpelledLetters, spelledLatinAcronym } from "../pipeline/pronunciation/provider-adapters";
import { prepareF5SynthesisText } from "../pipeline/tts";
import { repositoryProjectName } from "../pipeline/repository-project";
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

function expectedSynthesisText(segment: NarrationSegment) {
  // providerSynthesisText can contain transport-only phoneme tokens (for example
  // CHONG2GOU4 for IndexTTS). ASR validates spoken semantics, so prefer the
  // human-readable synthesis text and only fall back to the provider payload.
  return segment.ttsText?.trim() || segment.providerSynthesisText?.trim() || segment.text;
}

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

function hasConnectedAcronymChunk(chunks: string[] | undefined, acronym: string, expectedText: string) {
  const reading = spelledLatinAcronym(acronym);
  const hasAdjacentSpeech = expectedText.replace(acronym, "").replace(/[，。！？；：、,.!?;:\s\d]+/gu, "").length > 0;
  return (chunks ?? []).some((chunk) => {
    if (!chunk.includes(reading)) return false;
    if (!hasAdjacentSpeech) return true;
    return chunk.replace(reading, "").replace(/[，。！？；：、,.!?;:\s\d-]+/gu, "").length > 0;
  });
}

function expectedEntities(project: VideoProject, segment: NarrationSegment) {
  const claimIds = new Set(segment.claimIds ?? []);
  const expectedText = canonicalSpeechText(prepareF5SynthesisText(expectedSynthesisText(segment)));
  const claimEntities = project.factLedger?.claims
    .filter((claim) => claimIds.has(claim.id))
    .flatMap((claim) => [claim.subject, /[a-zA-Z]|\d/.test(claim.value) ? claim.value : ""])
    .map(canonicalSpeechText)
    .filter((value) => value.length >= 2 && expectedText.includes(value)) ?? [];
  const textualEntities = expectedSynthesisText(segment).match(/[A-Za-z]+(?:\s+[A-Za-z0-9._+-]+)+|v\d+(?:\.\d+)+|[A-Za-z][A-Za-z0-9._+-]{1,}/g) ?? [];
  return [...new Set([...claimEntities, ...textualEntities.map((value) => canonicalSpeechText(prepareF5SynthesisText(value)))].filter((value) => value.length >= 2))];
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

function characterRecall(expected: string, actual: string) {
  if (!expected) return 1;
  return [...expected].filter((char) => actual.includes(char)).length / expected.length;
}

function expectedAcronyms(text: string) {
  return acronymsRequiringSpelledLetters(text);
}

function normalizeAcronymHomophones(text: string) {
  return text
    .replace(/A\s*[,.，、 ]?\s*G\s*[,.，、 ]?\s*[爱艾愛]/gi, "AGI")
    .replace(/A\s*[,.，、 ]?\s*P\s*[,.，、 ]?\s*[爱艾愛]/gi, "API")
    .replace(/A\s*[,.，、 ]?\s*[爱艾愛]/gi, "AI");
}

function normalizeSemanticAsrVariants(text: string) {
  return normalizeAcronymHomophones(text)
    .replace(/refodev/giu, "freefordevelopers")
    .replace(/(?:ornice|欧尼|王尼|欧妮|奥尼)/giu, "ornith")
    .replace(/開圓/gu, "开源")
    .replace(/開源/gu, "开源")
    .replace(/熱點/gu, "热点")
    .replace(/趨勢/gu, "趋势")
    .replace(/項目/gu, "项目")
    .replace(/推薦/gu, "推荐")
    .replace(/两百/gu, "二百")
    .replace(/超级群/gu, "超集群")
    .replace(/极群/gu, "集群")
    .replace(/新文日期/gu, "新闻日期")
    .replace(/(?:结果符合|結果符合)/gu, "结果复核");
}

function transcriptSpellsAcronymAsLetters(text: string, acronym: string) {
  const asciiTranscript = normalizeAcronymHomophones(text).toUpperCase().replace(/[^A-Z]/g, "");
  if (asciiTranscript.includes(acronym)) return true;
  return false;
}

function hasTimedTransliteratedTitle(
  transcript: AsrSceneTranscript,
  expectedLeadingAscii: string | undefined,
  expectedPrefix: string,
  actualOpening: string,
) {
  if (!expectedLeadingAscii) return false;
  const firstWord = transcript.words?.[0];
  if (!firstWord || firstWord.startSeconds > 0.25) return false;
  const alias = canonicalSpeechText(firstWord.text);
  if (alias.length < 2 || alias.length > 7 || /[a-z0-9]/i.test(alias)) return false;
  const expectedBoundary = expectedPrefix.slice(expectedLeadingAscii.length);
  return characterRecall(expectedBoundary, actualOpening.slice(alias.length, alias.length + expectedBoundary.length + 3)) >= 0.6;
}

function unexpectedRepeatedPhrase(expectedText: string, actualText: string) {
  const maximumBlockWidth = Math.min(80, Math.floor(actualText.length / 2));
  for (let width = maximumBlockWidth; width >= 8; width -= 1) {
    for (let index = 0; index + width * 2 <= actualText.length; index += 1) {
      const phrase = actualText.slice(index, index + width);
      if (actualText.slice(index + width, index + width * 2) !== phrase) continue;
      if (!expectedText.includes(phrase.repeat(2))) return { phrase, repeats: 2, index };
    }
  }
  for (let width = 1; width <= 6; width += 1) {
    for (let index = 0; index + width * 2 <= actualText.length; index += 1) {
      const phrase = actualText.slice(index, index + width);
      if (!phrase || /^[\p{P}\p{S}\s_]+$/u.test(phrase)) continue;
      if (/^\d+$/u.test(phrase)) continue;
      if (/^[零一二三四五六七八九十百千万亿两点]+$/u.test(phrase)) continue;
      let repeats = 1;
      while (actualText.slice(index + repeats * width, index + (repeats + 1) * width) === phrase) repeats += 1;
      const minimumRepeats = /[a-z]/i.test(phrase) && phrase.length >= 2 ? 2 : 3;
      if (repeats >= minimumRepeats && !expectedText.includes(phrase.repeat(repeats))) return { phrase, repeats, index };
    }
  }
  return undefined;
}

function unexpectedBoundaryTail(expectedText: string, actualText: string) {
  for (const length of [18, 14, 10, 6]) {
    if (expectedText.length < length) continue;
    const expectedTail = expectedText.slice(-length);
    const tailIndex = actualText.lastIndexOf(expectedTail);
    if (tailIndex < 0) continue;
    const extraTail = actualText.slice(tailIndex + expectedTail.length);
    if (extraTail.length > 0 && extraTail.length <= 8) return { expectedTail, extraTail, tailIndex };
  }
  return undefined;
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
  const semanticMinimumConfidence = Number(process.env.ASR_SEMANTIC_CONFIDENCE_MIN ?? Math.max(minimumConfidence, 0.84));
  const boundaryLeakMinimum = Number(process.env.ASR_BOUNDARY_LEAK_MIN ?? 0.55);
  const endingRecallMinimum = Number(process.env.ASR_ENDING_RECALL_MIN ?? 0.62);

  for (const segment of segments) {
    const transcript = transcriptMap.get(segment.sceneIndex);
    if (!transcript) {
      issues.push({ severity: "warning", code: "verification_inconclusive", message: `第 ${segment.sceneIndex + 1} 屏没有 ASR 结果。`, sceneIndex: segment.sceneIndex, issueClass: "environment", repairAction: "retry-stage", retryable: true, evidence: { reason: "missing_transcript" } });
      continue;
    }
    const expectedText = canonicalSpeechText(prepareF5SynthesisText(expectedSynthesisText(segment)));
    const normalizedTranscript = normalizeSemanticAsrVariants(transcript.text);
    const actualText = canonicalSpeechText(normalizedTranscript);
    const confidence = transcript.confidence ?? undefined;
    const expectedChatGpt = /ChatGPT/i.test(`${segment.text} ${segment.ttsText ?? ""}`);
    const chatGptPronunciationRecognized = /(?:Chat\s*G\s*P\s*T|拆特|恰特)/i.test(transcript.text);
    if (expectedChatGpt && typeof confidence === "number" && confidence >= minimumConfidence && !chatGptPronunciationRecognized) {
      issues.push({ severity: "error", code: "audio_entity_mismatch", message: `第 ${segment.sceneIndex + 1} 屏 ChatGPT 未被识别为受保护的专名读法。`, sceneIndex: segment.sceneIndex, repairAction: "resynthesize-audio", retryable: true, issueClass: "hard", evidence: { phrase: "ChatGPT", transcript: transcript.text, asrConfidence: confidence, expectedReading: "恰特 G-P-T", verifier: "semantic-asr-protected-name" } });
    }
    const acronyms = expectedAcronyms(expectedSynthesisText(segment));
    const unprotectedAcronym = segment.ttsProvider === "indextts"
      ? acronyms.find((acronym) => !hasConnectedAcronymChunk(segment.providerSynthesisChunks, acronym, expectedSynthesisText(segment)))
      : undefined;
    if (unprotectedAcronym) {
      issues.push({ severity: "error", code: "audio_acronym_plan_unprotected", message: `第 ${segment.sceneIndex + 1} 屏缩写 ${unprotectedAcronym} 没有使用词典保护的连续字母读法。`, sceneIndex: segment.sceneIndex, repairAction: "resynthesize-audio", retryable: true, issueClass: "hard", evidence: { acronym: unprotectedAcronym, provider: segment.ttsProvider ?? "unknown", providerSynthesisChunks: segment.providerSynthesisChunks ?? [], requiredReading: spelledLatinAcronym(unprotectedAcronym) } });
    }
    const expectedAnchor = expectedText.slice(0, Math.min(8, expectedText.length));
    const openingWindow = actualText.slice(0, expectedAnchor.length + 8);
    const anchorOffset = expectedAnchor.length >= 3 ? openingWindow.indexOf(expectedAnchor) : 0;
    const openingCoverage = boundaryRecall(expectedText, openingWindow, "start");
    if (typeof confidence === "number" && confidence >= Math.min(minimumConfidence, 0.68) && anchorOffset > 0) {
      issues.push({ severity: "error", code: "audio_scene_opening_artifact", message: `第 ${segment.sceneIndex + 1} 屏音频开头包含额外发音、漏读或变音。`, sceneIndex: segment.sceneIndex, repairAction: "resynthesize-audio", retryable: true, issueClass: "hard", evidence: { expectedPrefix: expectedAnchor, actualPrefix: openingWindow, anchorOffset, openingCoverage: Number(openingCoverage.toFixed(3)), asrConfidence: confidence } });
    }
    const repeatedPhrase = unexpectedRepeatedPhrase(expectedText, actualText);
    if (typeof confidence === "number" && confidence >= minimumConfidence && repeatedPhrase) {
      issues.push({ severity: "error", code: "audio_repeated_phrase", message: `第 ${segment.sceneIndex + 1} 屏检测到旁白异常连续重复。`, sceneIndex: segment.sceneIndex, repairAction: "resynthesize-audio", retryable: true, issueClass: "hard", evidence: { transcript: transcript.text, repeatedPhrase: repeatedPhrase.phrase, repeatCount: repeatedPhrase.repeats, characterOffset: repeatedPhrase.index, asrConfidence: confidence } });
    }
    const missingAcronym = acronyms.find((acronym) => !transcriptSpellsAcronymAsLetters(transcript.text, acronym));
    if (missingAcronym && typeof confidence === "number" && confidence >= semanticMinimumConfidence) {
      issues.push({ severity: "error", code: "audio_entity_mismatch", message: `第 ${segment.sceneIndex + 1} 屏没有连续完整读出缩写 ${missingAcronym}。`, sceneIndex: segment.sceneIndex, repairAction: "resynthesize-audio", retryable: true, issueClass: "hard", evidence: { expectedAcronym: missingAcronym, transcript: transcript.text, asrConfidence: confidence, requiredReading: spelledLatinAcronym(missingAcronym) } });
    }
    const expectedLanguage = options.expectedLanguage?.toLowerCase();
    const detectedLanguage = transcript.detectedLanguage?.toLowerCase();
    const languageConfidence = transcript.languageConfidence;
    const sequence = sequenceMetrics(expectedText, actualText);
    const entities = expectedEntities(project, segment);
    const matchedEntities = entities.filter((entity) => actualText.includes(entity));
    const entityRecall = matchedEntities.length / Math.max(1, entities.length);
    const expectedNumbers = extractNumberUnits(expectedSynthesisText(segment));
    const actualNumbers = extractNumberUnits(normalizedTranscript);
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
      issues.push({ severity: "warning", code: "verification_inconclusive", message: `第 ${segment.sceneIndex + 1} 屏 ASR 未提供置信度，未触发内容重建。`, sceneIndex: segment.sceneIndex, issueClass: "environment", repairAction: "retry-stage", retryable: true, evidence: { transcript: transcript.text, reason: "missing_confidence" } });
      continue;
    }
    if (confidence < minimumConfidence) {
      issues.push({ severity: "warning", code: "verification_inconclusive", message: `第 ${segment.sceneIndex + 1} 屏 ASR 置信度 ${(confidence * 100).toFixed(1)}% 过低，未触发内容重建。`, sceneIndex: segment.sceneIndex, issueClass: "environment", repairAction: "retry-stage", retryable: true, evidence: { transcript: transcript.text, asrConfidence: confidence, minimumConfidence } });
      continue;
    }
    if (confidence < semanticMinimumConfidence) {
      issues.push({ severity: "warning", code: "verification_inconclusive", message: `第 ${segment.sceneIndex + 1} 屏 ASR 置信度不足以判定语义或实体错误。`, sceneIndex: segment.sceneIndex, issueClass: "environment", repairAction: "retry-stage", retryable: true, evidence: { transcript: transcript.text, asrConfidence: confidence, semanticMinimumConfidence, reason: "semantic_confidence_below_threshold" } });
      continue;
    }
    const boundaryTail = unexpectedBoundaryTail(expectedText, actualText);
    if (boundaryTail) {
      issues.push({ severity: "error", code: "audio_scene_boundary_artifact", message: `第 ${segment.sceneIndex + 1} 屏音频结尾包含未预期的残音或额外发音。`, sceneIndex: segment.sceneIndex, repairAction: "resynthesize-audio", retryable: true, issueClass: "hard", evidence: { expectedTail: boundaryTail.expectedTail, actualTail: actualText.slice(-18), extraTail: boundaryTail.extraTail, characterOffset: boundaryTail.tailIndex + boundaryTail.expectedTail.length, asrConfidence: confidence } });
    }
    if (entities.length && entityRecall < minimumEntityRecall) {
      issues.push({ severity: "error", code: "audio_entity_mismatch", message: `第 ${segment.sceneIndex + 1} 屏产品名、人名或关键实体不完整。`, sceneIndex: segment.sceneIndex, repairAction: "retry-stage", retryable: true, issueClass: "environment", evidence: { expectedEntities: entities, matchedEntities, transcript: transcript.text, entityRecall: Number(entityRecall.toFixed(3)), asrConfidence: confidence ?? "unknown", verifierActions: ["retry-verifier", "switch-asr-provider", "inject-entity-hotwords"] } });
    }
    if (expectedNumbers.length && numberAccuracy < 1) {
      issues.push({ severity: "error", code: "audio_number_mismatch", message: `第 ${segment.sceneIndex + 1} 屏数字、单位或版本号与旁白不一致。`, sceneIndex: segment.sceneIndex, repairAction: "retry-stage", retryable: true, issueClass: "environment", evidence: { expectedNumbers, transcriptNumbers: actualNumbers, transcript: transcript.text, numberAccuracy: Number(numberAccuracy.toFixed(3)), asrConfidence: confidence ?? "unknown", verifierActions: ["retry-verifier", "switch-asr-provider", "inject-entity-hotwords"] } });
    }
    const semanticMismatch = sequence.coverage < minimumCoverage || sequence.precision < minimumPrecision;
    const semanticEvidenceInconclusive = semanticMismatch && typeof confidence === "number" && confidence < semanticMinimumConfidence + 0.05;
    if (semanticMismatch) {
      issues.push({ severity: semanticEvidenceInconclusive ? "warning" : "error", code: semanticEvidenceInconclusive ? "verification_inconclusive" : "audio_semantic_mismatch", message: semanticEvidenceInconclusive ? `第 ${segment.sceneIndex + 1} 屏 ASR 语义证据接近置信度边界，暂不判定 TTS 错误。` : `第 ${segment.sceneIndex + 1} 屏 ASR 转写与旁白语义覆盖不足，需要重试或切换验证器。`, sceneIndex: segment.sceneIndex, repairAction: "retry-stage", retryable: true, issueClass: "environment", evidence: { transcript: transcript.text, tokenCoverage: Number(sequence.coverage.toFixed(3)), tokenPrecision: Number(sequence.precision.toFixed(3)), asrConfidence: confidence ?? "unknown", reason: semanticEvidenceInconclusive ? "semantic_confidence_near_threshold" : "semantic_asr_disagreement", verifierActions: ["retry-verifier", "switch-asr-provider", "inject-entity-hotwords"] } });
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
    const previousExpected = previous ? canonicalSpeechText(prepareF5SynthesisText(expectedSynthesisText(previous))) : "";
    const nextExpected = next ? canonicalSpeechText(prepareF5SynthesisText(expectedSynthesisText(next))) : "";
    const previousLeak = previousExpected ? boundaryRecall(previousExpected, actualStart, "end") : 0;
    const nextLeak = nextExpected ? boundaryRecall(nextExpected, actualEnd, "start") : 0;
    if ((previousLeak >= boundaryLeakMinimum && previousLeak > bigramRecall(currentStart, actualStart) + 0.15) || (nextLeak >= boundaryLeakMinimum && nextLeak > bigramRecall(currentEnd, actualEnd) + 0.15)) {
      issues.push({ severity: "error", code: "audio_segment_cross_talk", message: `第 ${segment.sceneIndex + 1} 屏音频疑似包含相邻场景旁白。`, sceneIndex: segment.sceneIndex, repairAction: "retry-stage", retryable: true, issueClass: "environment", evidence: { transcript: transcript.text, previousLeak: Number(previousLeak.toFixed(3)), nextLeak: Number(nextLeak.toFixed(3)), asrConfidence: confidence ?? "unknown", verifierActions: ["retry-verifier", "switch-asr-provider", "inject-entity-hotwords"] } });
    }
  }
  const firstTranscript = transcriptMap.get(0)?.text ?? "";
  const expectedTitle = canonicalSpeechText(prepareF5SynthesisText(project.meta.title));
  const normalizedFirstTranscript = normalizeSemanticAsrVariants(firstTranscript);
  const actualOpening = canonicalSpeechText(normalizedFirstTranscript).slice(0, Math.max(expectedTitle.length + 8, 18));
  const titleAudioCoverage = firstTranscript ? bigramRecall(expectedTitle, canonicalSpeechText(normalizedFirstTranscript)) : 0;
  // Repository openings intentionally contain a recommendation prefix before
  // the project name. Validate the title against the complete first scene
  // transcript instead of a fixed 18-character window that can end before the
  // project name.
  const titleOpeningCoverage = firstTranscript
    ? repositoryProjectName(project)
      ? titleAudioCoverage
      : bigramRecall(expectedTitle, actualOpening)
    : 0;
  const firstConfidence = transcriptMap.get(0)?.confidence;
  const expectedPrefix = canonicalSpeechText(prepareF5SynthesisText(segments[0] ? expectedSynthesisText(segments[0]) : project.meta.title)).slice(0, 10);
  const embeddedAsciiIndex = expectedPrefix.search(/[a-z]/);
  const expectedOpeningAnchor = embeddedAsciiIndex > 0 ? expectedPrefix.slice(0, embeddedAsciiIndex) : expectedPrefix.slice(0, 6);
  const openingPrefixCoverage = firstTranscript ? bigramRecall(expectedOpeningAnchor, actualOpening.slice(0, expectedOpeningAnchor.length + 3)) : 0;
  const expectedLeadingAscii = expectedPrefix.match(/^[a-z][a-z0-9]{1,15}/)?.[0];
  const leadingAsciiMissing = Boolean(expectedLeadingAscii && !actualOpening.startsWith(expectedLeadingAscii));
  const firstSceneTranscript = transcriptMap.get(0);
  const transliteratedTitle = firstSceneTranscript
    ? hasTimedTransliteratedTitle(firstSceneTranscript, expectedLeadingAscii, expectedPrefix, actualOpening)
    : false;
  if (firstTranscript && typeof firstConfidence === "number" && firstConfidence >= semanticMinimumConfidence && ((openingPrefixCoverage < 0.5 && !transliteratedTitle) || (leadingAsciiMissing && !transliteratedTitle))) {
    issues.push({ severity: "error", code: "audio_opening_mismatch", message: "首屏旁白开头与合成文本不一致，先重试验证器确认是否存在首词漏读或变音。", sceneIndex: 0, repairAction: "retry-stage", retryable: true, issueClass: "environment", evidence: { expectedPrefix, expectedLeadingAscii: expectedLeadingAscii ?? "", leadingAsciiMissing, transcript: firstTranscript, openingPrefixCoverage: Number(openingPrefixCoverage.toFixed(3)), asrConfidence: firstConfidence, verifierActions: ["retry-verifier", "switch-asr-provider", "inject-entity-hotwords"] } });
  }
  return { issues, results, titleTranscript: firstTranscript, titleAudioCoverage, titleOpeningCoverage };
}
