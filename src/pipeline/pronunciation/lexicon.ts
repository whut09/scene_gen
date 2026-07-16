import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { fromRoot } from "../utils";
import { pronunciationProviderOverrideSchema } from "./schema";

const tonePinyinSchema = z.string().regex(/^[a-zv]+[1-5]$/i);

export const pronunciationLexiconEntrySchema = z.object({
  phrase: z.string().min(1),
  pinyin: z.array(tonePinyinSchema).min(1),
  spokenFallback: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  risk: z.enum(["low", "medium", "high"]).default("medium"),
  providerOverrides: z.record(z.string(), pronunciationProviderOverrideSchema).default({}),
}).strict();

export const pronunciationLexiconSchema = z.object({
  version: z.number().int().positive(),
  locale: z.string().min(1),
  domain: z.string().min(1).optional(),
  entries: z.array(pronunciationLexiconEntrySchema),
}).strict().superRefine((lexicon, context) => {
  const phrases = new Set<string>();
  for (const [index, entry] of lexicon.entries.entries()) {
    if (phrases.has(entry.phrase)) context.addIssue({ code: "custom", path: ["entries", index, "phrase"], message: `Duplicate pronunciation phrase: ${entry.phrase}` });
    phrases.add(entry.phrase);
  }
});

export type PronunciationLexiconEntry = z.infer<typeof pronunciationLexiconEntrySchema>;
export interface LoadedPronunciationLexicon { filePath: string; lexicon: z.infer<typeof pronunciationLexiconSchema>; hash: string }

const cache = new Map<string, LoadedPronunciationLexicon & { modifiedMs: number; size: number }>();

export function manualPronunciationLexiconPath() {
  return path.resolve(process.env.TTS_PRONUNCIATION_LEXICON ?? fromRoot("config", "tts", "zh-CN.json"));
}

export function domainPronunciationLexiconPath(domain = "software") {
  return fromRoot("config", "tts", "domains", `${domain}.zh-CN.json`);
}

export function parsePronunciationLexicon(content: string, filePath = "pronunciation-lexicon.json"): LoadedPronunciationLexicon {
  const lexicon = pronunciationLexiconSchema.parse(JSON.parse(content));
  return { filePath, lexicon, hash: createHash("sha256").update(JSON.stringify(lexicon)).digest("hex") };
}

export function loadPronunciationLexicon(filePath: string) {
  const info = statSync(filePath);
  const cached = cache.get(filePath);
  if (cached && cached.modifiedMs === info.mtimeMs && cached.size === info.size) return cached;
  const loaded = { ...parsePronunciationLexicon(readFileSync(filePath, "utf8"), filePath), modifiedMs: info.mtimeMs, size: info.size };
  cache.set(filePath, loaded);
  return loaded;
}

export function enabledLexiconEntries(loaded: LoadedPronunciationLexicon) {
  return loaded.lexicon.entries.filter((entry) => entry.enabled).sort((left, right) => right.phrase.length - left.phrase.length || left.phrase.localeCompare(right.phrase));
}
