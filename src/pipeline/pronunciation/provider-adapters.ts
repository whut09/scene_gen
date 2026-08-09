import type { PronunciationPlan, PronunciationSpan } from "./schema";

export type PronunciationProvider = "azure" | "f5" | "indextts" | "cosyvoice" | "edge" | "openai" | "local";

const SPELLED_ACRONYMS = new Set(["AI", "AGI", "API", "GPU", "GB", "LLM", "ASR", "TTS", "RAG", "SDK", "CLI", "CI", "CD", "OCR"]);
const standaloneAcronymPattern = /(?<![A-Za-z])([A-Z]{2,5}|ai|agi|api|gpu|gb|llm|asr|tts|rag|sdk|cli|ci|cd|ocr)(?![A-Za-z])/g;

export function spelledLatinAcronym(acronym: string) {
  return [...acronym.toUpperCase()].join("-");
}

export function acronymsRequiringSpelledLetters(text: string) {
  return [...new Set([...text.matchAll(standaloneAcronymPattern)].map((match) => match[1].toUpperCase()).filter((value) => SPELLED_ACRONYMS.has(value)))];
}

export function replaceAcronymsWithSpelledLetters(text: string) {
  return text.replace(standaloneAcronymPattern, (match) => {
    const upper = match.toUpperCase();
    return SPELLED_ACRONYMS.has(upper) ? spelledLatinAcronym(upper) : match;
  });
}

export function escapeXml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function pinyinFor(span: PronunciationSpan, provider: PronunciationProvider) {
  return span.providerOverrides[provider]?.pinyin ?? span.expectedPinyin;
}

function replaceSpans(plan: PronunciationPlan, render: (span: PronunciationSpan) => string) {
  let cursor = 0;
  let result = "";
  for (const span of [...plan.spans].sort((left, right) => left.start - right.start)) {
    result += escapeXml(plan.synthesisText.slice(cursor, span.start));
    result += render(span);
    cursor = span.end;
  }
  return result + escapeXml(plan.synthesisText.slice(cursor));
}

export function f5PronunciationInput(plan: PronunciationPlan) {
  return { synthesisText: plan.synthesisText, phraseDictionary: Object.fromEntries(plan.spans.map((span) => [span.phrase, pinyinFor(span, "f5")])), pronunciationPlanHash: plan.planHash };
}

export function indexTtsPronunciationInput(plan: PronunciationPlan) {
  const controlledSpans = plan.spans.filter((span) => span.risk !== "low");
  const mixedPinyin = controlledSpans.map((span) => ({ phrase: span.phrase, start: span.start, end: span.end, pinyin: pinyinFor(span, "indextts") }));
  const protectedPinyin = new Map<string, string>();
  const textWithProtectedPinyin = [...controlledSpans]
    .sort((left, right) => right.start - left.start)
    .reduce((value, span, index) => {
      const pinyin = pinyinFor(span, "indextts").flatMap((value) => value.split(/\s+/)).filter(Boolean).map((syllable) => syllable.toUpperCase()).join("");
      const marker = `\uE000${index}\uE001`;
      protectedPinyin.set(marker, pinyin);
      return `${value.slice(0, span.start)}${marker}${value.slice(span.end)}`;
    }, plan.synthesisText);
  let text = replaceAcronymsWithSpelledLetters(textWithProtectedPinyin);
  for (const [marker, pinyin] of protectedPinyin) text = text.replaceAll(marker, pinyin);
  return { text, mixedPinyin, pronunciationPlanHash: plan.planHash };
}

export function cosyVoicePronunciationInput(plan: PronunciationPlan) {
  return { text: plan.synthesisText, pronunciationInpainting: plan.spans.map((span) => ({ phrase: span.phrase, pinyin: pinyinFor(span, "cosyvoice") })), pronunciationPlanHash: plan.planHash };
}

export function edgePronunciationText(plan: PronunciationPlan) {
  return plan.spans.reduceRight((text, span) => {
    const override = span.providerOverrides.edge;
    const fallback = override?.spokenFallback ?? span.spokenFallback;
    if (!fallback && (span.risk === "high" || override?.reject)) throw new Error(`Edge TTS cannot safely pronounce high-risk phrase: ${span.phrase}`);
    return fallback ? `${text.slice(0, span.start)}${fallback}${text.slice(span.end)}` : text;
  }, plan.synthesisText);
}

export function localPronunciationText(plan: PronunciationPlan) {
  return plan.spans.reduceRight((text, span) => {
    const fallback = span.providerOverrides.local?.spokenFallback;
    return fallback ? `${text.slice(0, span.start)}${fallback}${text.slice(span.end)}` : text;
  }, plan.synthesisText);
}
