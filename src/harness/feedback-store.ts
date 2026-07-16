import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { fromRoot } from "../pipeline/utils";

export type FeedbackSeverity = "low" | "medium" | "high" | "critical";

const feedbackEntrySchema = z.object({
  createdAt: z.string(),
  category: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]),
  issue: z.string().min(1),
  desired: z.string().optional(),
  url: z.string().optional(),
  videoPath: z.string().optional(),
  appliesTo: z.array(z.string().min(1)).default(["global"]),
  fingerprint: z.string().default(""),
  enabled: z.boolean().default(true),
  resolvedAt: z.string().optional(),
  trialCount: z.number().int().nonnegative().default(0),
  successCount: z.number().int().nonnegative().default(0),
  failureCount: z.number().int().nonnegative().default(0),
  lastAppliedAt: z.string().optional(),
  lastSucceededAt: z.string().optional(),
  effectScoreBefore: z.number().finite().optional(),
  effectScoreAfter: z.number().finite().optional(),
  expiresAt: z.string().optional(),
  conflictsWith: z.array(z.string().min(1)).default([]),
  contentDomains: z.array(z.string().min(1)).default([]),
  templateIds: z.array(z.string().min(1)).default([]),
  providerIds: z.array(z.string().min(1)).default([]),
  minimumConfidence: z.number().min(0).max(1).default(0),
});

export type FeedbackEntry = z.infer<typeof feedbackEntrySchema>;
type FeedbackDefaultedKey = "fingerprint" | "appliesTo" | "enabled" | "trialCount" | "successCount" | "failureCount"
  | "conflictsWith" | "contentDomains" | "templateIds" | "providerIds" | "minimumConfidence";
export type FeedbackInput = Omit<FeedbackEntry, FeedbackDefaultedKey> & Partial<Pick<FeedbackEntry, FeedbackDefaultedKey>>;

export interface FeedbackSelectionContext {
  url: string;
  stage?: string;
  category?: string;
  contentDomain?: string;
  templateId?: string;
  providerId?: string;
  confidence?: number;
  now?: Date;
  limit?: number;
}

export interface FeedbackOutcome {
  succeeded: boolean;
  scoreBefore?: number;
  scoreAfter?: number;
  appliedAt?: string;
}

const severityWeight = { critical: 4, high: 3, medium: 2, low: 1 } as const;
const feedbackHalfLifeDays = 90;

export function feedbackFilePath() {
  return process.env.VIDEO_FEEDBACK_FILE
    ? path.resolve(process.env.VIDEO_FEEDBACK_FILE)
    : fromRoot("data", "feedback", "feedback.jsonl");
}

export function feedbackFingerprint(entry: Pick<FeedbackInput, "category" | "issue" | "desired" | "appliesTo">) {
  return createHash("sha256").update(JSON.stringify({
    category: entry.category.trim().toLowerCase(),
    issue: entry.issue.trim(),
    desired: entry.desired?.trim() ?? "",
    appliesTo: [...(entry.appliesTo ?? ["global"])].sort(),
  })).digest("hex");
}

function unique(values: string[] | undefined) {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();
}

function normalizeFeedback(entry: FeedbackInput) {
  const appliesTo = entry.appliesTo?.length ? unique(entry.appliesTo) : entry.url ? [`url:${entry.url}`] : ["global"];
  const parsed = feedbackEntrySchema.parse({
    ...entry,
    appliesTo,
    conflictsWith: unique(entry.conflictsWith),
    contentDomains: unique(entry.contentDomains),
    templateIds: unique(entry.templateIds),
    providerIds: unique(entry.providerIds),
    fingerprint: entry.fingerprint || feedbackFingerprint({ ...entry, appliesTo }),
  });
  return feedbackEntrySchema.parse({
    ...parsed,
    trialCount: Math.max(parsed.trialCount, parsed.successCount + parsed.failureCount),
  });
}

async function readAllFeedback() {
  try {
    const raw = await readFile(feedbackFilePath(), "utf8");
    return raw.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try {
        return [normalizeFeedback(JSON.parse(line) as FeedbackInput)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function feedbackRecency(entry: FeedbackEntry, now: Date) {
  const timestamp = Date.parse(entry.lastAppliedAt ?? entry.createdAt);
  if (!Number.isFinite(timestamp)) return 0;
  const ageDays = Math.max(0, now.getTime() - timestamp) / 86_400_000;
  return Math.pow(0.5, ageDays / feedbackHalfLifeDays);
}

export function feedbackBayesianSuccessRate(entry: Pick<FeedbackEntry, "trialCount" | "successCount" | "failureCount">) {
  const observedTrials = Math.max(entry.trialCount, entry.successCount + entry.failureCount);
  const unresolvedTrials = Math.max(0, observedTrials - entry.successCount - entry.failureCount);
  return (entry.successCount + 2 + unresolvedTrials * 0.5) / (observedTrials + 4);
}

export function feedbackSelectionScore(entry: FeedbackEntry, now = new Date()) {
  const effectDelta = entry.effectScoreBefore === undefined || entry.effectScoreAfter === undefined
    ? 0
    : Math.max(-1, Math.min(1, (entry.effectScoreAfter - entry.effectScoreBefore) / 100));
  return severityWeight[entry.severity]
    + feedbackBayesianSuccessRate(entry) * 3
    + feedbackRecency(entry, now) * 1.5
    + effectDelta * 2;
}

function matchesTarget(values: string[], selected: string | undefined) {
  return values.length === 0 || (selected !== undefined && values.includes(selected));
}

function conflicts(left: FeedbackEntry, right: FeedbackEntry) {
  return left.conflictsWith.includes(right.fingerprint) || right.conflictsWith.includes(left.fingerprint);
}

export async function readFeedback(limit = 30) {
  const entries = await readAllFeedback();
  const deduplicated = new Map<string, FeedbackEntry>();
  for (const entry of entries) deduplicated.set(entry.fingerprint, entry);
  const now = new Date();
  return [...deduplicated.values()]
    .filter((entry) => entry.enabled && !entry.resolvedAt && (!entry.expiresAt || Date.parse(entry.expiresAt) > now.getTime()))
    .sort((left, right) => feedbackSelectionScore(right, now) - feedbackSelectionScore(left, now) || left.fingerprint.localeCompare(right.fingerprint))
    .slice(0, limit);
}

export function selectFeedback(entries: FeedbackEntry[], context: FeedbackSelectionContext) {
  const now = context.now ?? new Date();
  const confidence = context.confidence ?? 1;
  const ranked = entries.filter((entry) => entry.enabled
    && !entry.resolvedAt
    && (!entry.expiresAt || Date.parse(entry.expiresAt) > now.getTime())
    && entry.minimumConfidence <= confidence
    && matchesTarget(entry.contentDomains, context.contentDomain)
    && matchesTarget(entry.templateIds, context.templateId)
    && matchesTarget(entry.providerIds, context.providerId)
    && entry.appliesTo.some((scope) => scope === "global"
      || scope === `url:${context.url}`
      || (context.stage && scope === `stage:${context.stage}`)
      || (context.category && scope === `category:${context.category}`)))
    .sort((left, right) => feedbackSelectionScore(right, now) - feedbackSelectionScore(left, now)
      || Date.parse(right.createdAt) - Date.parse(left.createdAt)
      || left.fingerprint.localeCompare(right.fingerprint));
  const selected: FeedbackEntry[] = [];
  for (const candidate of ranked) {
    if (!selected.some((entry) => conflicts(entry, candidate))) selected.push(candidate);
    if (selected.length >= (context.limit ?? 12)) break;
  }
  return selected;
}

export async function appendFeedback(entry: FeedbackInput) {
  const filePath = feedbackFilePath();
  const normalized = normalizeFeedback(entry);
  const compacted = new Map<string, FeedbackEntry>();
  for (const item of await readAllFeedback()) compacted.set(item.fingerprint, item);
  const current = compacted.get(normalized.fingerprint);
  const definedInput = Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as Partial<FeedbackInput>;
  const next = current ? normalizeFeedback({
    ...current,
    ...definedInput,
    createdAt: current.createdAt,
    fingerprint: current.fingerprint,
    trialCount: current.trialCount,
    successCount: current.successCount,
    failureCount: current.failureCount,
    lastAppliedAt: current.lastAppliedAt,
    lastSucceededAt: current.lastSucceededAt,
    effectScoreBefore: current.effectScoreBefore,
    effectScoreAfter: current.effectScoreAfter,
  }) : normalized;
  if (current && JSON.stringify(current) === JSON.stringify(next)) {
    return { filePath, entry: current, deduplicated: true };
  }
  compacted.set(next.fingerprint, next);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${[...compacted.values()].map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  return { filePath, entry: next, deduplicated: false };
}

export async function recordFeedbackOutcome(fingerprints: string[], result: boolean | FeedbackOutcome) {
  if (fingerprints.length === 0) return [];
  const outcome = typeof result === "boolean" ? { succeeded: result } : result;
  const selected = new Set(fingerprints);
  const compacted = new Map<string, FeedbackEntry>();
  for (const entry of await readAllFeedback()) compacted.set(entry.fingerprint, entry);
  const appliedAt = outcome.appliedAt ?? new Date().toISOString();
  const entries = [...compacted.values()].map((entry) => selected.has(entry.fingerprint) ? feedbackEntrySchema.parse({
    ...entry,
    trialCount: entry.trialCount + 1,
    successCount: entry.successCount + (outcome.succeeded ? 1 : 0),
    failureCount: entry.failureCount + (outcome.succeeded ? 0 : 1),
    lastAppliedAt: appliedAt,
    lastSucceededAt: outcome.succeeded ? appliedAt : entry.lastSucceededAt,
    effectScoreBefore: outcome.scoreBefore ?? entry.effectScoreBefore,
    effectScoreAfter: outcome.scoreAfter ?? entry.effectScoreAfter,
  }) : entry);
  const filePath = feedbackFilePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""), "utf8");
  return entries.filter((entry) => selected.has(entry.fingerprint));
}

export function buildFeedbackGuidance(entries: FeedbackEntry[]) {
  if (entries.length === 0) return "";
  return entries
    .slice(0, 12)
    .map((entry, index) => {
      const desired = entry.desired ? `；期望：${entry.desired}` : "";
      const effectiveness = feedbackBayesianSuccessRate(entry).toFixed(2);
      return `${index + 1}. [${entry.category}/${entry.severity}/${entry.fingerprint.slice(0, 8)}/effect=${effectiveness}] ${entry.issue}${desired}`;
    })
    .join("\n");
}
