import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { fromRoot } from "./utils";

const tone3SyllableSchema = z.string().regex(/^[a-z]+[1-5]$/i, "Expected tone-number pinyin such as chong2.");

export const ttsPronunciationEntrySchema = z.object({
  phrase: z.string().min(1),
  pinyin: z.array(tone3SyllableSchema).min(1),
  spokenFallback: z.string().min(1),
  enabled: z.boolean(),
}).strict();

export const ttsPronunciationLexiconSchema = z.object({
  version: z.number().int().positive(),
  locale: z.string().min(1),
  entries: z.array(ttsPronunciationEntrySchema),
}).strict().superRefine((lexicon, context) => {
  const phrases = new Set<string>();
  for (const [index, entry] of lexicon.entries.entries()) {
    if (phrases.has(entry.phrase)) {
      context.addIssue({ code: "custom", path: ["entries", index, "phrase"], message: `Duplicate pronunciation phrase: ${entry.phrase}` });
    }
    phrases.add(entry.phrase);
    if ([...entry.phrase].length !== entry.pinyin.length) {
      context.addIssue({ code: "custom", path: ["entries", index, "pinyin"], message: "Pinyin syllable count must match phrase character count." });
    }
  }
});

export type TtsPronunciationEntry = z.infer<typeof ttsPronunciationEntrySchema>;
export type TtsPronunciationLexicon = z.infer<typeof ttsPronunciationLexiconSchema>;

export interface LoadedTtsPronunciationLexicon {
  filePath: string;
  lexicon: TtsPronunciationLexicon;
  hash: string;
}

let cachedLexicon: (LoadedTtsPronunciationLexicon & { modifiedMs: number; size: number }) | undefined;

export function resolveTtsPronunciationLexiconPath() {
  return path.resolve(process.env.TTS_PRONUNCIATION_LEXICON ?? fromRoot("config", "tts", "zh-CN.json"));
}

export function parseTtsPronunciationLexicon(content: string, filePath = "tts-pronunciation-lexicon.json"): LoadedTtsPronunciationLexicon {
  const lexicon = ttsPronunciationLexiconSchema.parse(JSON.parse(content));
  const canonical = JSON.stringify(lexicon);
  return {
    filePath,
    lexicon,
    hash: createHash("sha256").update(canonical).digest("hex"),
  };
}

export function loadTtsPronunciationLexicon(filePath = resolveTtsPronunciationLexiconPath()) {
  const info = statSync(filePath);
  if (cachedLexicon?.filePath === filePath && cachedLexicon.modifiedMs === info.mtimeMs && cachedLexicon.size === info.size) {
    return cachedLexicon;
  }
  const loaded = parseTtsPronunciationLexicon(readFileSync(filePath, "utf8"), filePath);
  cachedLexicon = { ...loaded, modifiedMs: info.mtimeMs, size: info.size };
  return cachedLexicon;
}

export function findTtsPronunciations(text: string, loaded: LoadedTtsPronunciationLexicon = loadTtsPronunciationLexicon()) {
  return loaded.lexicon.entries
    .filter((entry) => entry.enabled && text.includes(entry.phrase))
    .sort((left, right) => right.phrase.length - left.phrase.length);
}

export function applyTtsSpokenFallbacks(
  text: string,
  options: { enabled?: boolean; loaded?: LoadedTtsPronunciationLexicon } = {},
) {
  if (!(options.enabled ?? process.env.TTS_USE_SPOKEN_FALLBACKS === "1")) return text;
  return findTtsPronunciations(text, options.loaded).reduce(
    (result, entry) => result.replaceAll(entry.phrase, entry.spokenFallback),
    text,
  );
}
