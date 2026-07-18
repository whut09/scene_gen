import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { RuntimeConfig } from "../../config/runtime-config";
import type { VideoProject } from "../../pipeline/types";
import { ensureDir, readJson, writeJsonAtomic } from "../../pipeline/utils";
import { speechNormalizationDictionaryHash } from "../speech-normalization";
import { storedNarrationSceneTranscripts, transcribeNarrationScenes, verifySceneTranscripts, type AsrSceneTranscript } from "../scene-audio-verification";
import { projectAudioPath } from "./audio-structural-gate";

export const AUDIO_SEMANTIC_GATE_VERSION = "audio-semantic-v3-verifier-routing";
export type AsrProviderId = "whisper" | "sensevoice" | "funasr" | "mock";

const cachedAsrSchema = z.object({ version: z.literal(1), key: z.string().length(64), transcripts: z.array(z.object({ sceneIndex: z.number().int().nonnegative(), text: z.string(), confidence: z.number().nullable().optional(), detectedLanguage: z.string().min(1), languageConfidence: z.number().min(0).max(1), words: z.array(z.object({ text: z.string(), startSeconds: z.number(), endSeconds: z.number(), confidence: z.number().nullable().optional() })).optional() })) }).strict();

async function fileHash(filePath: string) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

export function normalizationDictionaryHash() {
  return speechNormalizationDictionaryHash();
}

export function asrCacheKey(identity: { audioContentHash: string; asrProvider: AsrProviderId; asrModel: string; language: string; normalizationDictionaryHash: string; gateVersion: string }) {
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export async function transcribeScenesCached(input: {
  project: VideoProject;
  config: RuntimeConfig;
  provider?: AsrProviderId;
  transcribe?: (project: VideoProject, signal?: AbortSignal) => Promise<AsrSceneTranscript[] | null>;
  signal?: AbortSignal;
}) {
  const stored = storedNarrationSceneTranscripts(input.project);
  if (stored) return { transcripts: stored, cacheHit: true, provider: "whisper" as AsrProviderId };
  const audioPath = projectAudioPath(input.project);
  if (!audioPath) return { transcripts: null, cacheHit: false, provider: (input.provider ?? input.config.asr.provider) as AsrProviderId };
  const provider = input.provider ?? input.config.asr.provider;
  const identity = { audioContentHash: await fileHash(audioPath), asrProvider: provider, asrModel: input.config.asr.model, language: input.config.asr.language, normalizationDictionaryHash: normalizationDictionaryHash(), gateVersion: AUDIO_SEMANTIC_GATE_VERSION };
  const key = asrCacheKey(identity);
  const cachePath = path.join(input.config.cache.rootDir, "metadata", "asr", `${key}.json`);
  const cached = await readJson<unknown>(cachePath).then((value) => cachedAsrSchema.parse(value)).catch(() => undefined);
  if (cached) return { transcripts: cached.transcripts, cacheHit: true, provider };
  if (!input.transcribe && provider !== "whisper") throw new Error(`ASR provider '${provider}' requires a registered adapter.`);
  const transcripts = await (input.transcribe ?? transcribeNarrationScenes)(input.project, input.signal);
  if (transcripts) {
    await ensureDir(path.dirname(cachePath));
    await writeJsonAtomic(cachePath, { version: 1, key, transcripts });
  }
  return { transcripts, cacheHit: false, provider };
}

export async function runAudioSemanticGate(input: {
  project: VideoProject;
  config: RuntimeConfig;
  provider?: AsrProviderId;
  transcribe?: (project: VideoProject, signal?: AbortSignal) => Promise<AsrSceneTranscript[] | null>;
  signal?: AbortSignal;
}) {
  const transcription = await transcribeScenesCached(input);
  if (!transcription.transcripts?.length) {
    const blocking = input.config.profile === "production" || input.config.quality.profile === "strict";
    return {
      issues: [{ severity: blocking ? "error" as const : "warning" as const, code: "asr_verification_failed", message: "Semantic ASR produced no transcript; spoken-language quality was not verified.", issueClass: "environment" as const, repairAction: "check-environment" as const, retryable: false, evidence: { verifier: transcription.provider, reason: "empty_transcript", requiredProfile: input.config.profile } }],
      results: [], titleTranscript: "", titleAudioCoverage: 0, titleOpeningCoverage: 0,
      metrics: { semanticVerifiedCount: 0, semanticAsrCacheHit: transcription.cacheHit, semanticAsrProvider: transcription.provider, semanticGateVersion: AUDIO_SEMANTIC_GATE_VERSION },
    };
  }
  const expectedLanguage = /^(chinese|zh(?:-cn)?)$/i.test(input.config.asr.language) ? "zh" : input.config.asr.language;
  const configuredMinimumConfidence = Number(process.env.ASR_SCENE_CONFIDENCE_MIN ?? 0.65);
  const minimumConfidence = input.config.profile === "production" ? Math.max(0.8, configuredMinimumConfidence) : configuredMinimumConfidence;
  const verification = verifySceneTranscripts(input.project, transcription.transcripts, { expectedLanguage, minimumLanguageConfidence: input.config.asr.languageConfidenceMin, minimumConfidence });
  const issues = verification.issues
    .filter((issue) => issue.code !== "audio_pronunciation_mismatch")
    .map((issue) => input.config.quality.profile === "lenient" && issue.code === "audio_semantic_mismatch"
      ? {
          ...issue,
          severity: "warning" as const,
          code: "verification_inconclusive",
          message: `Scene ${(issue.sceneIndex ?? 0) + 1} semantic ASR disagreed with the narration, but no acoustic evidence proves a TTS defect.`,
          issueClass: "soft" as const,
          repairAction: "retry-stage" as const,
          evidence: { ...issue.evidence, originalCode: issue.code, verifier: transcription.provider, reason: "semantic_asr_disagreement" },
        }
      : issue);
  return { ...verification, issues, metrics: { semanticVerifiedCount: verification.results.length, semanticAsrCacheHit: transcription.cacheHit, semanticAsrProvider: transcription.provider, semanticGateVersion: AUDIO_SEMANTIC_GATE_VERSION } };
}
