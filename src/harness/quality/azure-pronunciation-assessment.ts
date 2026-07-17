import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { RuntimeConfig } from "../../config/runtime-config";
import { readJson, writeJsonAtomic } from "../../pipeline/utils";

const azureAssessmentSchema = z.object({
  NBest: z.array(z.object({
    Words: z.array(z.object({
      Word: z.string(), Offset: z.number().optional(), Duration: z.number().optional(),
      PronunciationAssessment: z.object({ AccuracyScore: z.number().optional() }).optional(),
      Phonemes: z.array(z.object({ Phoneme: z.string(), PronunciationAssessment: z.object({ AccuracyScore: z.number().optional(), NBestPhonemes: z.array(z.object({ Phoneme: z.string(), Score: z.number() })).optional() }).optional() })).optional(),
    })).default([]),
  })).default([]),
}).passthrough();

export interface PronunciationAssessmentInput {
  audioPath: string;
  referenceText: string;
  phrase: string;
  expectedPinyin: string[];
  signal?: AbortSignal;
}

export interface PronunciationAssessmentResult {
  status: "verified" | "inconclusive";
  actualPinyin?: string[];
  phonemeCandidates?: string[];
  startMs?: number;
  endMs?: number;
  confidence: number;
  verifier: string;
  reason?: string;
}

function endpoint(config: RuntimeConfig) {
  if (config.asr.pronunciation.endpoint) return config.asr.pronunciation.endpoint;
  if (!config.asr.pronunciation.region) return undefined;
  return `https://${config.asr.pronunciation.region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=zh-CN&format=detailed`;
}

const usageSchema = z.object({ version: z.literal(1), month: z.string(), usedSeconds: z.number().nonnegative(), updatedAt: z.string() }).strict();

function wavDurationSeconds(bytes: Buffer) {
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF") return 0;
  const byteRate = bytes.readUInt32LE(28);
  const dataSize = bytes.readUInt32LE(40);
  return byteRate > 0 ? dataSize / byteRate : 0;
}

async function reserveBudget(seconds: number, config: RuntimeConfig) {
  const budget = config.asr.pronunciation.monthlySecondsBudget;
  if (budget <= 0) return true;
  const filePath = path.join(config.cache.rootDir, "metadata", "azure-pronunciation-usage.json");
  const month = new Date().toISOString().slice(0, 7);
  const current = await readJson<unknown>(filePath).then((value) => usageSchema.parse(value)).catch(() => ({ version: 1 as const, month, usedSeconds: 0, updatedAt: new Date().toISOString() }));
  const usedSeconds = current.month === month ? current.usedSeconds : 0;
  if (usedSeconds + seconds > budget) return false;
  await writeJsonAtomic(filePath, { version: 1, month, usedSeconds: usedSeconds + seconds, updatedAt: new Date().toISOString() });
  return true;
}

export async function assessAzurePronunciation(input: PronunciationAssessmentInput, config: RuntimeConfig): Promise<PronunciationAssessmentResult> {
  const url = endpoint(config);
  const apiKey = config.asr.pronunciation.apiKey;
  if (!url || !apiKey) return { status: "inconclusive", confidence: 0, verifier: "azure-pronunciation-assessment", reason: "verifier_unavailable" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.asr.pronunciation.timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
  const assessment = Buffer.from(JSON.stringify({ referenceText: input.referenceText, gradingSystem: "HundredMark", granularity: "Phoneme", dimension: "Comprehensive", phonemeAlphabet: "SAPI", nBestPhonemeCount: 5 })).toString("base64");
  try {
    const audio = await readFile(input.audioPath);
    if (!(await reserveBudget(wavDurationSeconds(audio), config))) return { status: "inconclusive", confidence: 0, verifier: "azure-pronunciation-assessment", reason: "quota_exhausted" };
    const response = await fetch(url, {
      method: "POST",
      headers: { "Ocp-Apim-Subscription-Key": apiKey, "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000", "Pronunciation-Assessment": assessment, "X-ConnectionId": randomUUID().replaceAll("-", "") },
      body: audio,
      signal,
    });
    if (response.status === 429) return { status: "inconclusive", confidence: 0, verifier: "azure-pronunciation-assessment", reason: "quota_exhausted" };
    if (!response.ok) return { status: "inconclusive", confidence: 0, verifier: "azure-pronunciation-assessment", reason: `http_${response.status}` };
    const parsed = azureAssessmentSchema.parse(await response.json());
    const words = parsed.NBest[0]?.Words ?? [];
    const normalizedPhrase = input.phrase.replace(/\s+/g, "");
    let matchedWords: typeof words = [];
    for (let start = 0; start < words.length && !matchedWords.length; start += 1) {
      let combined = "";
      for (let end = start; end < words.length; end += 1) {
        combined += words[end].Word.replace(/\s+/g, "");
        if (combined === normalizedPhrase) { matchedWords = words.slice(start, end + 1); break; }
        if (!normalizedPhrase.startsWith(combined)) break;
      }
    }
    const phonemes = matchedWords.flatMap((word) => word.Phonemes ?? []);
    if (!phonemes.length) return { status: "inconclusive", confidence: 0, verifier: "azure-pronunciation-assessment", reason: "alignment_failed" };
    const candidates = phonemes.flatMap((phoneme) => phoneme.PronunciationAssessment?.NBestPhonemes?.map((candidate) => `${candidate.Phoneme}:${candidate.Score}`) ?? [phoneme.Phoneme]);
    const actualPinyin = phonemes.map((phoneme) => phoneme.Phoneme);
    const scores = phonemes.map((phoneme) => phoneme.PronunciationAssessment?.AccuracyScore).filter((score): score is number => typeof score === "number");
    const confidence = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length / 100 : 0;
    const first = matchedWords[0];
    const last = matchedWords.at(-1);
    return { status: "verified", actualPinyin, phonemeCandidates: candidates, startMs: first?.Offset === undefined ? undefined : first.Offset / 10_000, endMs: last?.Offset === undefined || last.Duration === undefined ? undefined : (last.Offset + last.Duration) / 10_000, confidence, verifier: "azure-pronunciation-assessment" };
  } catch (error) {
    return { status: "inconclusive", confidence: 0, verifier: "azure-pronunciation-assessment", reason: signal.aborted ? "timeout_or_cancelled" : `verifier_failed:${createHash("sha256").update((error as Error).message).digest("hex").slice(0, 8)}` };
  } finally {
    clearTimeout(timer);
  }
}
