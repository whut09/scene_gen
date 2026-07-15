import { readFileSync } from "node:fs";
import { z } from "zod";
import { fromRoot } from "../pipeline/utils";

const speechDictionarySchema = z.object({
  literalMap: z.record(z.string(), z.string()).default({}),
  regexRules: z.array(z.object({
    pattern: z.string().min(1),
    replacement: z.string(),
    flags: z.string().default("g"),
  })).default([]),
});

type SpeechDictionary = z.infer<typeof speechDictionarySchema>;

function loadDictionary(name: string): SpeechDictionary {
  const filePath = fromRoot("config", "asr", `${name}.json`);
  return speechDictionarySchema.parse(JSON.parse(readFileSync(filePath, "utf8")));
}

export function loadedSpeechPackages() {
  return ["base", ...(process.env.ASR_DOMAIN_PACKAGES ?? "scene-gen").split(",").map((item) => item.trim()).filter(Boolean)];
}

export function canonicalSpeechText(text: string) {
  let result = text.toLowerCase();
  for (const packageName of loadedSpeechPackages()) {
    const dictionary = loadDictionary(packageName);
    result = [...result].map((character) => dictionary.literalMap[character] ?? character).join("");
    for (const rule of dictionary.regexRules) result = result.replace(new RegExp(rule.pattern, rule.flags), rule.replacement);
  }
  return result.replace(/\s+|[^a-z0-9\u4e00-\u9fff]/g, "");
}
