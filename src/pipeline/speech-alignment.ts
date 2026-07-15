import { canonicalSpeechText } from "../harness/speech-normalization";
import { transcribeNarrationScenes, type AsrSceneTranscript } from "../harness/scene-audio-verification";
import { syncCueCandidates } from "../production/visual-planner";
import type { NarrationSegment, SpeechPhraseTiming, SpeechWordTiming, VideoProject, VideoScene } from "./types";

interface CanonicalWordSpan {
  wordIndex: number;
  start: number;
  end: number;
}

function sequenceSimilarity(left: string, right: string) {
  if (!left || !right) return 0;
  const previous = new Array(right.length + 1).fill(0);
  for (const leftToken of left) {
    let diagonal = 0;
    for (let index = 1; index <= right.length; index += 1) {
      const saved = previous[index];
      previous[index] = leftToken === right[index - 1] ? diagonal + 1 : Math.max(previous[index], previous[index - 1]);
      diagonal = saved;
    }
  }
  return previous[right.length] / Math.max(left.length, right.length);
}

function canonicalTranscript(words: SpeechWordTiming[]) {
  let text = "";
  const spans: CanonicalWordSpan[] = [];
  for (const [wordIndex, word] of words.entries()) {
    const normalized = canonicalSpeechText(word.text);
    if (!normalized) continue;
    const start = text.length;
    text += normalized;
    spans.push({ wordIndex, start, end: text.length });
  }
  return { text, spans };
}

function wordRangeForCharacters(spans: CanonicalWordSpan[], start: number, end: number) {
  const covered = spans.filter((span) => span.end > start && span.start < end);
  if (!covered.length) return undefined;
  return { first: covered[0].wordIndex, last: covered.at(-1)!.wordIndex };
}

function phraseConfidence(words: SpeechWordTiming[], first: number, last: number, fallback: number) {
  const values = words.slice(first, last + 1).map((word) => word.confidence).filter((value): value is number => value !== undefined);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback;
}

function findPhrase(
  phrase: string,
  words: SpeechWordTiming[],
  transcriptConfidence: number,
): Omit<SpeechPhraseTiming, "audioStartMs" | "audioEndMs"> & { startMs: number; endMs: number } | undefined {
  const normalizedPhrase = canonicalSpeechText(phrase);
  if (normalizedPhrase.length < 2) return undefined;
  const canonical = canonicalTranscript(words);
  let start = canonical.text.indexOf(normalizedPhrase);
  let end = start < 0 ? -1 : start + normalizedPhrase.length;
  let match: "exact" | "fuzzy" = "exact";
  let similarity = 1;
  if (start < 0) {
    const fuzzyMinimum = Number(process.env.SPEECH_ALIGNMENT_FUZZY_MIN ?? 0.78);
    let best = { start: -1, end: -1, similarity: 0 };
    const minimumLength = Math.max(2, normalizedPhrase.length - 2);
    const maximumLength = Math.min(canonical.text.length, normalizedPhrase.length + 2);
    for (let windowLength = minimumLength; windowLength <= maximumLength; windowLength += 1) {
      for (let offset = 0; offset + windowLength <= canonical.text.length; offset += 1) {
        const score = sequenceSimilarity(normalizedPhrase, canonical.text.slice(offset, offset + windowLength));
        if (score > best.similarity) best = { start: offset, end: offset + windowLength, similarity: score };
      }
    }
    if (best.similarity < fuzzyMinimum) return undefined;
    ({ start, end, similarity } = best);
    match = "fuzzy";
  }
  const range = wordRangeForCharacters(canonical.spans, start, end);
  if (!range) return undefined;
  const confidence = Math.max(0, Math.min(1, phraseConfidence(words, range.first, range.last, transcriptConfidence) * similarity));
  if (confidence < Number(process.env.SPEECH_ALIGNMENT_CONFIDENCE_MIN ?? 0.6)) return undefined;
  return {
    phrase,
    startMs: words[range.first].startMs,
    endMs: words[range.last].endMs,
    confidence: Number(confidence.toFixed(3)),
    match,
  };
}

function transcriptWords(transcript: AsrSceneTranscript): SpeechWordTiming[] {
  return (transcript.words ?? []).map((word) => ({
    text: word.text,
    startMs: Math.round(word.startSeconds * 1000),
    endMs: Math.round(word.endSeconds * 1000),
    confidence: word.confidence ?? undefined,
  }));
}

export function alignNarrationSegment(
  segment: NarrationSegment,
  scene: VideoScene,
  transcript: AsrSceneTranscript,
  createdAt = new Date().toISOString(),
): NarrationSegment {
  const words = transcriptWords(transcript);
  const transcriptConfidence = transcript.confidence ?? 0.75;
  const narrationText = canonicalSpeechText(segment.text);
  const sceneStartMs = Math.round((segment.audioStartSeconds ?? 0) * 1000);
  const phrases = syncCueCandidates(scene)
    .filter((phrase) => narrationText.includes(canonicalSpeechText(phrase)))
    .map((phrase) => findPhrase(phrase, words, transcriptConfidence))
    .filter((phrase): phrase is NonNullable<typeof phrase> => Boolean(phrase))
    .map((phrase): SpeechPhraseTiming => ({
      phrase: phrase.phrase,
      audioStartMs: sceneStartMs + phrase.startMs,
      audioEndMs: sceneStartMs + phrase.endMs,
      confidence: phrase.confidence,
      match: phrase.match,
    }));
  return {
    ...segment,
    speechAlignment: {
      version: 1,
      status: phrases.length ? "forced" : "failed",
      provider: "whisper",
      transcript: transcript.text,
      confidence: transcript.confidence ?? undefined,
      words,
      phrases,
      createdAt,
    },
  };
}

export function applySpeechAlignment(project: VideoProject, transcripts: AsrSceneTranscript[], createdAt = new Date().toISOString()): VideoProject {
  const transcriptByScene = new Map(transcripts.map((transcript) => [transcript.sceneIndex, transcript]));
  return {
    ...project,
    narrationSegments: project.narrationSegments?.map((segment) => {
      const scene = project.scenes[segment.sceneIndex];
      const transcript = transcriptByScene.get(segment.sceneIndex);
      return scene && transcript ? alignNarrationSegment(segment, scene, transcript, createdAt) : segment;
    }),
  };
}

export async function alignProjectSpeech(project: VideoProject, signal?: AbortSignal): Promise<VideoProject> {
  if (process.env.SPEECH_ALIGNMENT_DISABLED === "1" || process.env.ASR_DISABLED === "1") return project;
  const transcripts = await transcribeNarrationScenes(project, signal);
  return transcripts ? applySpeechAlignment(project, transcripts) : project;
}
