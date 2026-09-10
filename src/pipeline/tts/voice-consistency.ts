import { copyFile, rm } from "node:fs/promises";
import type { PronunciationPlan } from "../pronunciation/schema";
import { analyzeVoiceProfilesFromFiles, medianVoicePitch, voicePitchDistanceSemitones, voicePitchSpreadSemitones } from "./acoustic-stability";
import { nvidiaTts } from "./providers/nvidia";

const RETRY_DISTANCE_SEMITONES = 1.05;
const MAX_RETRIES_PER_SCENE = 2;
const VOICE_CONSISTENCY_VERSION = "nvidia-scene-voice-retry-v1";

export interface NvidiaVoiceConsistencyInput {
  segmentPaths: string[];
  plans: PronunciationPlan[];
  cacheSalts: Array<string | undefined>;
  signal?: AbortSignal;
}

export async function stabilizeNvidiaSceneVoice(input: NvidiaVoiceConsistencyInput) {
  const initialProfiles = await analyzeVoiceProfilesFromFiles(input.segmentPaths);
  const targetPitchHz = medianVoicePitch(initialProfiles);
  const selectedCacheSalts = [...input.cacheSalts];
  const regeneratedSceneIndexes: number[] = [];
  let retryCount = 0;
  let rejectedCandidateCount = 0;

  if (targetPitchHz > 0) {
    const candidates = initialProfiles
      .filter((profile) => voicePitchDistanceSemitones(profile.medianF0Hz, targetPitchHz) > RETRY_DISTANCE_SEMITONES)
      .sort((left, right) => voicePitchDistanceSemitones(right.medianF0Hz, targetPitchHz) - voicePitchDistanceSemitones(left.medianF0Hz, targetPitchHz));
    for (const profile of candidates) {
      let bestDistance = voicePitchDistanceSemitones(profile.medianF0Hz, targetPitchHz);
      let selected = false;
      for (let attempt = 1; attempt <= MAX_RETRIES_PER_SCENE; attempt += 1) {
        retryCount += 1;
        const outputPath = input.segmentPaths[profile.index];
        const candidatePath = outputPath.replace(/\.wav$/i, `.voice-candidate-${attempt}.wav`);
        const candidateSalt = `${selectedCacheSalts[profile.index] ?? "default"}:${VOICE_CONSISTENCY_VERSION}:${attempt}`;
        try {
          await nvidiaTts({ plan: input.plans[profile.index], outputPath: candidatePath, cacheSalt: candidateSalt, signal: input.signal });
          const candidateProfile = (await analyzeVoiceProfilesFromFiles([candidatePath]))[0];
          const candidateDistance = voicePitchDistanceSemitones(candidateProfile.medianF0Hz, targetPitchHz);
          if (candidateDistance + 0.08 < bestDistance) {
            await copyFile(candidatePath, outputPath);
            bestDistance = candidateDistance;
            selectedCacheSalts[profile.index] = candidateSalt;
            selected = true;
          } else {
            rejectedCandidateCount += 1;
          }
        } finally {
          await rm(candidatePath, { force: true }).catch(() => undefined);
        }
        if (bestDistance <= RETRY_DISTANCE_SEMITONES) break;
      }
      if (selected) regeneratedSceneIndexes.push(profile.index);
    }
  }

  const profiles = await analyzeVoiceProfilesFromFiles(input.segmentPaths);
  return {
    profiles,
    spreadSemitones: voicePitchSpreadSemitones(profiles),
    targetPitchHz,
    selectedCacheSalts,
    regeneratedSceneIndexes,
    retryCount,
    rejectedCandidateCount,
  };
}
