import { XMLValidator } from "fast-xml-parser";
import { compilePronunciationPlan } from "../../pronunciation/compiler";
import type { PronunciationPlan, PronunciationSpan } from "../../pronunciation/schema";

export const AZURE_MANDARIN_PHONEME_VERSION = "azure-zh-cn-sapi-v1";

const initials = ["zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "j", "q", "x", "r", "z", "c", "s", "y", "w"];
const finals = new Set(["a", "o", "e", "i", "u", "v", "ai", "ei", "ui", "ao", "ou", "iu", "ie", "ve", "ue", "er", "an", "en", "in", "un", "vn", "ang", "eng", "ing", "ong", "ia", "ian", "iang", "iao", "iong", "ua", "uai", "uan", "uang", "uo"]);
const wholeSyllables = new Set(["zhi", "chi", "shi", "ri", "zi", "ci", "si", "yi", "wu", "yu", "ye", "yue", "yuan", "yin", "yun", "ying", "a", "o", "e", "ai", "ei", "ao", "ou", "an", "en", "ang"]);

export class AzureSsmlError extends Error {
  readonly errorType = "pronunciation_plan_invalid";

  constructor(message: string) {
    super(message);
    this.name = "AzureSsmlError";
  }
}

export interface AzureSsmlOptions {
  voice: string;
  rate?: string;
  pitch?: string;
  volume?: string;
  style?: string;
  role?: string;
}

export function escapeAzureXml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function providerPinyin(span: PronunciationSpan) {
  return span.providerOverrides.azure?.pinyin ?? span.expectedPinyin;
}

function validMandarinSyllable(base: string) {
  if (wholeSyllables.has(base)) return true;
  const initial = initials.find((candidate) => base.startsWith(candidate));
  return Boolean(initial && finals.has(base.slice(initial.length)));
}

export function tone3ToAzureSapi(syllable: string) {
  const match = /^([a-zv]+)([1-5])$/i.exec(syllable);
  if (!match) throw new AzureSsmlError(`Invalid tone-number pinyin '${syllable}'.`);
  const base = match[1].toLowerCase();
  if (!validMandarinSyllable(base)) throw new AzureSsmlError(`Unsupported zh-CN pinyin syllable '${syllable}'.`);
  return `${base} ${match[2]}`;
}

function validateSpans(plan: PronunciationPlan) {
  let previousEnd = 0;
  for (const span of [...plan.spans].sort((left, right) => left.start - right.start || left.end - right.end)) {
    if (span.start < previousEnd) throw new AzureSsmlError(`Pronunciation spans overlap at '${span.phrase}'.`);
    if (span.end > plan.synthesisText.length) throw new AzureSsmlError(`Pronunciation span '${span.phrase}' exceeds synthesis text.`);
    if (plan.synthesisText.slice(span.start, span.end) !== span.phrase) throw new AzureSsmlError(`Pronunciation span '${span.phrase}' does not match synthesis text.`);
    providerPinyin(span).forEach(tone3ToAzureSapi);
    previousEnd = span.end;
  }
}

function wrapAzureVoice(body: string, options: AzureSsmlOptions) {
  const prosody = `<prosody rate="${escapeAzureXml(options.rate ?? "+0%")}" pitch="${escapeAzureXml(options.pitch ?? "+0Hz")}" volume="${escapeAzureXml(options.volume ?? "+0%")}">${body}</prosody>`;
  const expressive = options.style || options.role
    ? `<mstts:express-as${options.style ? ` style="${escapeAzureXml(options.style)}"` : ""}${options.role ? ` role="${escapeAzureXml(options.role)}"` : ""}>${prosody}</mstts:express-as>`
    : prosody;
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-CN"><voice name="${escapeAzureXml(options.voice)}">${expressive}</voice></speak>`;
}

function assertConstructedSsml(ssml: string) {
  const validation = XMLValidator.validate(ssml);
  if (validation !== true) throw new AzureSsmlError(`Constructed Azure SSML is invalid: ${validation.err.msg}`);
}

export function buildAzurePronunciationSsml(plan: PronunciationPlan, options: AzureSsmlOptions) {
  validateSpans(plan);
  let cursor = 0;
  let body = "";
  for (const span of [...plan.spans].sort((left, right) => left.start - right.start)) {
    body += escapeAzureXml(plan.synthesisText.slice(cursor, span.start));
    const sapi = providerPinyin(span).map(tone3ToAzureSapi).join(" - ");
    body += `<phoneme alphabet="sapi" ph="${escapeAzureXml(sapi)}">${escapeAzureXml(span.phrase)}</phoneme>`;
    cursor = span.end;
  }
  body += escapeAzureXml(plan.synthesisText.slice(cursor));
  const ssml = wrapAzureVoice(body, options);
  assertConstructedSsml(ssml);
  return ssml;
}

export function buildAzurePlainSsml(synthesisText: string, options: AzureSsmlOptions) {
  const ssml = wrapAzureVoice(escapeAzureXml(synthesisText), options);
  assertConstructedSsml(ssml);
  return ssml;
}

export function azureSpokenFallbackText(plan: PronunciationPlan) {
  let text = plan.synthesisText;
  let changed = false;
  for (const span of [...plan.spans].sort((left, right) => right.start - left.start)) {
    const fallback = span.providerOverrides.azure?.spokenFallback ?? span.spokenFallback;
    if (!fallback) continue;
    text = `${text.slice(0, span.start)}${fallback}${text.slice(span.end)}`;
    changed = true;
  }
  return changed ? text : undefined;
}

let selfTestPromise: Promise<void> | undefined;

export function runAzureSsmlSelfTest() {
  selfTestPromise ??= (async () => {
    for (const text of ["重构", "重要", "重量", "重新构建"]) {
      const { plan } = await compilePronunciationPlan({ displayText: text });
      buildAzurePronunciationSsml(plan, { voice: "zh-CN-XiaoxiaoNeural" });
    }
  })();
  return selfTestPromise;
}
