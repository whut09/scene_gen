import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { RuntimeConfig } from "../../config/runtime-config";
import type { PronunciationSpan } from "../../pipeline/pronunciation/schema";
import type { VideoProject } from "../../pipeline/types";
import { readJson, writeJsonAtomic } from "../../pipeline/utils";
import { ensureDir } from "../../pipeline/utils";
import { runExternalProcess } from "../../pipeline/external-operation";
import type { QualityIssueInput } from "../quality-protocol";
import { assessAzurePronunciation, type PronunciationAssessmentResult } from "./azure-pronunciation-assessment";
import { projectAudioPath } from "./audio-structural-gate";
import { tone3ToAzureSapi } from "../../pipeline/tts/providers/azure-ssml";

export const AUDIO_PRONUNCIATION_GATE_VERSION = "audio-pronunciation-v1";

const cacheSchema = z.object({ version: z.literal(1), key: z.string().length(64), result: z.object({ status: z.enum(["verified", "inconclusive"]), actualPinyin: z.array(z.string()).optional(), phonemeCandidates: z.array(z.string()).optional(), startMs: z.number().optional(), endMs: z.number().optional(), confidence: z.number(), verifier: z.string(), reason: z.string().optional() }) }).strict();

function normalizedPhones(phones: string[]) {
  return phones.map((phone) => phone.toLowerCase().replace(/\s+/g, "").replace(/-/g, ""));
}

function phonesMatch(expected: string[], actual: string[]) {
  const left = normalizedPhones(expected.map(tone3ToAzureSapi)).join("");
  const right = normalizedPhones(actual).join("");
  return left === right || right.includes(left);
}

function inconclusiveIssue(sceneIndex: number, phrase: string, reason: string, verifier: string, profile: string): QualityIssueInput {
  return { severity: profile === "strict" ? "error" : "warning", code: "verification_inconclusive", message: `Pronunciation verification was inconclusive for '${phrase}': ${reason}.`, sceneIndex, issueClass: profile === "strict" ? "environment" : "soft", repairAction: profile === "strict" ? "check-environment" : "none", retryable: false, evidence: { phrase, reason, verifier } };
}

async function sceneAudioPath(input: { sourceAudioPath: string; audioHash: string; sceneIndex: number; startSeconds: number; durationSeconds: number; cacheRoot: string; signal?: AbortSignal }) {
  const clipKey = createHash("sha256").update(JSON.stringify({ audioHash: input.audioHash, sceneIndex: input.sceneIndex, startSeconds: input.startSeconds, durationSeconds: input.durationSeconds })).digest("hex");
  const clipPath = path.join(input.cacheRoot, "metadata", "pronunciation-audio", `${clipKey}.wav`);
  try {
    await readFile(clipPath);
    return clipPath;
  } catch {
    await ensureDir(path.dirname(clipPath));
    const temporaryPath = `${clipPath}.${process.pid}.tmp.wav`;
    await runExternalProcess("ffmpeg", ["-y", "-v", "error", "-ss", String(input.startSeconds), "-i", input.sourceAudioPath, "-t", String(input.durationSeconds), "-ar", "16000", "-ac", "1", temporaryPath], { signal: input.signal, timeoutMs: 120_000 });
    const { rename, rm } = await import("node:fs/promises");
    try { await rename(temporaryPath, clipPath); }
    catch (error) { await rm(temporaryPath, { force: true }).catch(() => undefined); if (!(await readFile(clipPath).catch(() => undefined))) throw error; }
    return clipPath;
  }
}

export async function runAudioPronunciationGate(input: {
  project: VideoProject;
  config: RuntimeConfig;
  verify?: (request: { sceneIndex: number; span: PronunciationSpan; audioPath: string; signal?: AbortSignal }) => Promise<PronunciationAssessmentResult>;
  signal?: AbortSignal;
}) {
  const issues: QualityIssueInput[] = [];
  const checkedSceneIndexes: number[] = [];
  const audioPath = projectAudioPath(input.project);
  const risky = (input.project.narrationSegments ?? []).flatMap((segment) => (segment.pronunciationPlan?.spans ?? []).filter((span) => span.risk !== "low").map((span) => ({ segment, span })));
  if (!risky.length) return { issues, metrics: { pronunciationCheckedScenes: "", pronunciationRiskSpanCount: 0, pronunciationVerifierCalls: 0 } };
  if (!audioPath) return { issues: risky.map(({ segment, span }) => inconclusiveIssue(segment.sceneIndex, span.phrase, "audio_missing", "none", input.config.quality.profile)), metrics: { pronunciationCheckedScenes: "", pronunciationRiskSpanCount: risky.length, pronunciationVerifierCalls: 0 } };
  const audioHash = createHash("sha256").update(await readFile(audioPath)).digest("hex");
  let verifierCalls = 0;
  for (const { segment, span } of risky) {
    if ((segment.durationSeconds ?? 0) * 1000 < input.config.asr.pronunciation.minimumAudioMs) {
      issues.push(inconclusiveIssue(segment.sceneIndex, span.phrase, "audio_too_short", input.config.asr.pronunciation.provider, input.config.quality.profile));
      continue;
    }
    if (input.config.asr.pronunciation.provider !== "azure" && !input.verify) {
      issues.push(inconclusiveIssue(segment.sceneIndex, span.phrase, "verifier_unavailable", input.config.asr.pronunciation.provider, input.config.quality.profile));
      continue;
    }
    const key = createHash("sha256").update(JSON.stringify({ audioHash, sceneIndex: segment.sceneIndex, sceneStart: segment.audioStartSeconds, sceneDuration: segment.durationSeconds, phrase: span.phrase, expectedPinyin: span.expectedPinyin, pronunciationPlanHash: segment.pronunciationPlan!.planHash, verifier: input.config.asr.pronunciation.provider, gateVersion: AUDIO_PRONUNCIATION_GATE_VERSION })).digest("hex");
    const cachePath = path.join(input.config.cache.rootDir, "metadata", "pronunciation", `${key}.json`);
    let result = await readJson<unknown>(cachePath).then((value) => cacheSchema.parse(value).result).catch(() => undefined);
    if (!result) {
      verifierCalls += 1;
      const clipPath = input.verify ? audioPath : await sceneAudioPath({ sourceAudioPath: audioPath, audioHash, sceneIndex: segment.sceneIndex, startSeconds: segment.audioStartSeconds ?? 0, durationSeconds: segment.durationSeconds ?? 0, cacheRoot: input.config.cache.rootDir, signal: input.signal });
      result = input.verify
        ? await input.verify({ sceneIndex: segment.sceneIndex, span, audioPath: clipPath, signal: input.signal })
        : await assessAzurePronunciation({ audioPath: clipPath, referenceText: segment.pronunciationPlan!.synthesisText, phrase: span.phrase, expectedPinyin: span.expectedPinyin, signal: input.signal }, input.config);
      await writeJsonAtomic(cachePath, { version: 1, key, result });
    }
    checkedSceneIndexes.push(segment.sceneIndex);
    if (result.status !== "verified" || !result.actualPinyin?.length || result.confidence < input.config.asr.pronunciation.confidenceMin || result.startMs === undefined || result.endMs === undefined) {
      issues.push(inconclusiveIssue(segment.sceneIndex, span.phrase, result.reason ?? "low_confidence_or_alignment_failed", result.verifier, input.config.quality.profile));
      continue;
    }
    if (!phonesMatch(span.expectedPinyin, result.actualPinyin)) {
      issues.push({ severity: "error", code: "audio_pronunciation_mismatch", message: `Pronunciation mismatch for '${span.phrase}'.`, sceneIndex: segment.sceneIndex, evidence: { phrase: span.phrase, expectedPinyin: span.expectedPinyin.join(" "), actualPinyin: result.actualPinyin.join(" "), phonemeCandidates: result.phonemeCandidates ?? [], startMs: result.startMs, endMs: result.endMs, confidence: result.confidence, verifier: result.verifier, pronunciationPlanHash: segment.pronunciationPlan!.planHash } });
    }
  }
  return { issues, metrics: { pronunciationCheckedScenes: [...new Set(checkedSceneIndexes)].sort((a, b) => a - b).join(","), pronunciationRiskSpanCount: risky.length, pronunciationVerifierCalls: verifierCalls, pronunciationGateVersion: AUDIO_PRONUNCIATION_GATE_VERSION } };
}
