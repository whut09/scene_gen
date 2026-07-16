import { createHash } from "node:crypto";
import { z } from "zod";

const tonePinyinSchema = z.string().regex(/^[a-zv]+[1-5]$/i, "Expected tone-number pinyin such as chong2.");

export const pronunciationProviderOverrideSchema = z.object({
  pinyin: z.array(tonePinyinSchema).min(1).optional(),
  spokenFallback: z.string().min(1).optional(),
  reject: z.boolean().optional(),
}).strict();

export const pronunciationSpanSchema = z.object({
  phrase: z.string().min(1),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  expectedPinyin: z.array(tonePinyinSchema).min(1),
  source: z.enum(["manual", "domain", "g2pw", "pypinyin"]),
  confidence: z.number().min(0).max(1),
  risk: z.enum(["low", "medium", "high"]),
  spokenFallback: z.string().min(1).optional(),
  providerOverrides: z.record(z.string(), pronunciationProviderOverrideSchema).default({}),
}).strict().superRefine((span, context) => {
  if (span.end <= span.start) context.addIssue({ code: "custom", path: ["end"], message: "Pronunciation span end must exceed start." });
});

export const pronunciationOverrideSchema = z.object({
  phrase: z.string().min(1),
  expectedPinyin: z.array(tonePinyinSchema).min(1),
  risk: z.enum(["low", "medium", "high"]),
  spokenFallback: z.string().min(1).optional(),
  providerOverrides: z.record(z.string(), pronunciationProviderOverrideSchema).default({}),
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().positive().optional(),
  confidence: z.number().min(0).max(1).optional(),
}).strict();

export const pronunciationPlanSchema = z.object({
  displayText: z.string(),
  semanticText: z.string(),
  synthesisText: z.string(),
  spans: z.array(pronunciationSpanSchema),
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  frontendVersion: z.string().min(1),
}).strict();

export type PronunciationSpan = z.infer<typeof pronunciationSpanSchema>;
export type PronunciationOverride = z.infer<typeof pronunciationOverrideSchema>;
export type PronunciationPlan = z.infer<typeof pronunciationPlanSchema>;

export const PRONUNCIATION_FRONTEND_VERSION = "scene-gen-pronunciation-plan-v1";

export function pronunciationPlanHash(input: Omit<PronunciationPlan, "planHash">) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
