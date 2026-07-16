import { existsSync } from "node:fs";
import type { G2pwPrediction, G2pwPredictor } from "./g2pw-client";
import { domainPronunciationLexiconPath, enabledLexiconEntries, loadPronunciationLexicon, manualPronunciationLexiconPath, type PronunciationLexiconEntry } from "./lexicon";
import { PRONUNCIATION_FRONTEND_VERSION, pronunciationPlanHash, pronunciationSpanSchema, type PronunciationOverride, type PronunciationPlan, type PronunciationSpan } from "./schema";

export type { PronunciationOverride } from "./schema";

function overlaps(span: Pick<PronunciationSpan, "start" | "end">, selected: Array<Pick<PronunciationSpan, "start" | "end">>) {
  return selected.some((item) => span.start < item.end && item.start < span.end);
}

function entrySpans(text: string, entry: PronunciationLexiconEntry, source: "manual" | "domain") {
  const spans: PronunciationSpan[] = [];
  let from = 0;
  while (from < text.length) {
    const start = text.indexOf(entry.phrase, from);
    if (start < 0) break;
    spans.push({ phrase: entry.phrase, start, end: start + entry.phrase.length, expectedPinyin: entry.pinyin, source, confidence: 1, risk: entry.risk, spokenFallback: entry.spokenFallback, providerOverrides: entry.providerOverrides });
    from = start + entry.phrase.length;
  }
  return spans;
}

function selectLongest(candidates: PronunciationSpan[], selected: PronunciationSpan[]) {
  for (const span of candidates.sort((left, right) => (right.end - right.start) - (left.end - left.start) || left.start - right.start)) {
    if (!overlaps(span, selected)) selected.push(pronunciationSpanSchema.parse(span));
  }
}

function predictionsToSpans(predictions: G2pwPrediction[], minimumConfidence: number) {
  return predictions.filter((prediction) => prediction.confidence >= minimumConfidence).map((prediction) => pronunciationSpanSchema.parse({ phrase: prediction.phrase, start: prediction.start, end: prediction.end, expectedPinyin: prediction.pinyin, source: "g2pw", confidence: prediction.confidence, risk: prediction.confidence >= 0.9 ? "low" : "medium", providerOverrides: {} }));
}

export async function compilePronunciationPlan(input: {
  displayText: string;
  semanticText?: string;
  synthesisText?: string;
  overrides?: PronunciationOverride[];
  domain?: string;
  g2pw?: G2pwPredictor;
  g2pwMinimumConfidence?: number;
  pypinyinFallback?: (text: string, selected: PronunciationSpan[]) => Promise<PronunciationSpan[]> | PronunciationSpan[];
  signal?: AbortSignal;
}): Promise<{ plan: PronunciationPlan; issues: Array<{ code: "pronunciation_uncertain"; phrase: string; confidence: number }> }> {
  const semanticText = input.semanticText ?? input.displayText;
  const synthesisText = input.synthesisText ?? semanticText;
  const matchText = synthesisText;
  const selected: PronunciationSpan[] = [];
  selectLongest((input.overrides ?? []).map((override) => {
    const start = override.start ?? matchText.indexOf(override.phrase);
    return { ...override, start, end: override.end ?? start + override.phrase.length, source: "manual" as const, confidence: override.confidence ?? 1, providerOverrides: override.providerOverrides ?? {} };
  }).filter((span) => span.start >= 0), selected);

  const manual = loadPronunciationLexicon(manualPronunciationLexiconPath());
  selectLongest(enabledLexiconEntries(manual).flatMap((entry) => entrySpans(matchText, entry, "manual")), selected);
  const domainPath = domainPronunciationLexiconPath(input.domain ?? "software");
  if (existsSync(domainPath)) selectLongest(enabledLexiconEntries(loadPronunciationLexicon(domainPath)).flatMap((entry) => entrySpans(matchText, entry, "domain")), selected);

  const issues: Array<{ code: "pronunciation_uncertain"; phrase: string; confidence: number }> = [];
  if (input.g2pw) {
    const predictions = await input.g2pw.predict(matchText, { signal: input.signal });
    const minimum = input.g2pwMinimumConfidence ?? 0.75;
    for (const prediction of predictions.filter((item) => item.confidence < minimum && !overlaps(item, selected))) issues.push({ code: "pronunciation_uncertain", phrase: prediction.phrase, confidence: prediction.confidence });
    selectLongest(predictionsToSpans(predictions, minimum), selected);
  }
  if (input.pypinyinFallback) selectLongest(await input.pypinyinFallback(matchText, selected), selected);

  const withoutHash = { displayText: input.displayText, semanticText, synthesisText, spans: selected.sort((left, right) => left.start - right.start), frontendVersion: PRONUNCIATION_FRONTEND_VERSION };
  return { plan: { ...withoutHash, planHash: pronunciationPlanHash(withoutHash) }, issues };
}
