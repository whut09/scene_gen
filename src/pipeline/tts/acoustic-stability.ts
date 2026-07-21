import { readFile, rename, rm } from "node:fs/promises";
import { run } from "./process";

export const MAX_VOICE_PITCH_SPREAD_SEMITONES = 3;

export interface AcousticVoiceProfile {
  index: number;
  medianF0Hz: number;
  voicedFrames: number;
}

interface PcmWav {
  sampleRate: number;
  channels: number;
  samples: Float32Array;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function parsePcm16Wav(buffer: Buffer): PcmWav {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") throw new Error("Unsupported WAV container.");
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
  let dataOffset = 0;
  let dataLength = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      audioFormat = buffer.readUInt16LE(body);
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bitsPerSample = buffer.readUInt16LE(body + 14);
    } else if (id === "data") {
      dataOffset = body;
      dataLength = Math.min(size, buffer.length - body);
      break;
    }
    offset = body + size + (size % 2);
  }
  if (audioFormat !== 1 || bitsPerSample !== 16 || sampleRate <= 0 || channels <= 0 || dataLength <= 0) throw new Error("Voice analysis requires PCM 16-bit WAV audio.");
  const frameCount = Math.floor(dataLength / (channels * 2));
  const samples = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let total = 0;
    for (let channel = 0; channel < channels; channel += 1) total += buffer.readInt16LE(dataOffset + (frame * channels + channel) * 2) / 32768;
    samples[frame] = total / channels;
  }
  return { sampleRate, channels, samples };
}

function downsample(samples: Float32Array, sampleRate: number, targetRate = 8_000) {
  const stride = Math.max(1, Math.round(sampleRate / targetRate));
  if (stride === 1) return { samples, sampleRate };
  const output = new Float32Array(Math.floor(samples.length / stride));
  for (let index = 0; index < output.length; index += 1) output[index] = samples[index * stride];
  return { samples: output, sampleRate: sampleRate / stride };
}

function estimateMedianF0(samples: Float32Array, sampleRate: number) {
  const frameLength = Math.max(240, Math.round(sampleRate * 0.04));
  const hop = Math.max(120, Math.round(sampleRate * 0.02));
  const minimumLag = Math.max(2, Math.floor(sampleRate / 400));
  const maximumLag = Math.min(frameLength - 2, Math.ceil(sampleRate / 70));
  const frequencies: number[] = [];
  const frameCount = Math.max(0, Math.floor((samples.length - frameLength) / hop) + 1);
  const step = Math.max(1, Math.ceil(frameCount / 100));
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += step) {
    const start = frameIndex * hop;
    let mean = 0;
    for (let index = 0; index < frameLength; index += 1) mean += samples[start + index];
    mean /= frameLength;
    let energy = 0;
    for (let index = 0; index < frameLength; index += 1) {
      const value = samples[start + index] - mean;
      energy += value * value;
    }
    if (Math.sqrt(energy / frameLength) < 0.008) continue;
    let bestLag = 0;
    let bestCorrelation = 0;
    for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
      let correlation = 0;
      let leftEnergy = 0;
      let rightEnergy = 0;
      for (let index = 0; index < frameLength - lag; index += 1) {
        const left = samples[start + index] - mean;
        const right = samples[start + index + lag] - mean;
        correlation += left * right;
        leftEnergy += left * left;
        rightEnergy += right * right;
      }
      const normalized = correlation / Math.sqrt(Math.max(1e-12, leftEnergy * rightEnergy));
      if (normalized > bestCorrelation) { bestCorrelation = normalized; bestLag = lag; }
    }
    if (bestLag && bestCorrelation >= 0.52) frequencies.push(sampleRate / bestLag);
  }
  return { medianF0Hz: median(frequencies), voicedFrames: frequencies.length };
}

async function loadVoiceProfile(filePath: string, index: number, startSeconds = 0, durationSeconds?: number): Promise<AcousticVoiceProfile> {
  const wav = parsePcm16Wav(await readFile(filePath));
  const start = Math.max(0, Math.floor(startSeconds * wav.sampleRate));
  const end = durationSeconds === undefined ? wav.samples.length : Math.min(wav.samples.length, start + Math.floor(durationSeconds * wav.sampleRate));
  const reduced = downsample(wav.samples.slice(start, end), wav.sampleRate);
  return { index, ...estimateMedianF0(reduced.samples, reduced.sampleRate) };
}

export async function analyzeVoiceProfilesFromFiles(filePaths: string[]) {
  return Promise.all(filePaths.map((filePath, index) => loadVoiceProfile(filePath, index)));
}

export async function analyzeVoiceProfilesFromTimeline(filePath: string, ranges: Array<{ startSeconds: number; durationSeconds: number }>) {
  return Promise.all(ranges.map((range, index) => loadVoiceProfile(filePath, index, range.startSeconds, range.durationSeconds)));
}

export function voicePitchSpreadSemitones(profiles: AcousticVoiceProfile[]) {
  const pitches = profiles.filter((profile) => profile.voicedFrames >= 3 && profile.medianF0Hz > 0).map((profile) => profile.medianF0Hz);
  if (pitches.length < 2) return 0;
  return 12 * Math.log2(Math.max(...pitches) / Math.min(...pitches));
}

export async function stabilizeNvidiaVoicePitch(filePaths: string[]) {
  const before = await analyzeVoiceProfilesFromFiles(filePaths);
  const valid = before.filter((profile) => profile.voicedFrames >= 3 && profile.medianF0Hz > 0);
  const target = median(valid.map((profile) => profile.medianF0Hz));
  const adjustedSceneIndexes: number[] = [];
  if (target > 0) {
    for (const profile of valid) {
      const semitoneDelta = 12 * Math.log2(target / profile.medianF0Hz);
      if (Math.abs(semitoneDelta) < 1.4) continue;
      const source = filePaths[profile.index];
      const temporary = source.replace(/\.wav$/i, ".voice-stable.wav");
      const filter = "rubberband=pitch=" + (target / profile.medianF0Hz).toFixed(6) + ",loudnorm=I=-19:TP=-2:LRA=7";
      await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", source, "-af", filter, "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", temporary]);
      await rm(source, { force: true });
      await rename(temporary, source);
      adjustedSceneIndexes.push(profile.index);
    }
  }
  const after = adjustedSceneIndexes.length ? await analyzeVoiceProfilesFromFiles(filePaths) : before;
  return { before, after, adjustedSceneIndexes, spreadSemitones: voicePitchSpreadSemitones(after) };
}
