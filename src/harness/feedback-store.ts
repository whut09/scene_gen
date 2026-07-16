import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
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

export interface FeedbackMutationContext {
  actor?: string;
  runId?: string;
  reason?: string;
}

interface InvalidFeedbackLine { lineNumber: number; raw: string; error: string }

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

export function feedbackQuarantinePath() { return `${feedbackFilePath()}.quarantine.jsonl`; }
export function feedbackAuditPath() { return `${feedbackFilePath()}.audit.jsonl`; }

async function readFeedbackDocument(filePath = feedbackFilePath()) {
  try {
    const raw = await readFile(filePath, "utf8");
    const entries: FeedbackEntry[] = [];
    const invalidLines: InvalidFeedbackLine[] = [];
    raw.split(/\r?\n/).forEach((line, index) => {
      if (!line) return;
      try { entries.push(normalizeFeedback(JSON.parse(line) as FeedbackInput)); }
      catch (error) { invalidLines.push({ lineNumber: index + 1, raw: line, error: error instanceof Error ? error.message : String(error) }); }
    });
    return { entries, invalidLines };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], invalidLines: [] };
    throw error;
  }
}

async function writeFeedbackAtomic(filePath: string, entries: FeedbackEntry[]) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""), "utf8");
  await rename(temporaryPath, filePath);
}

async function withFeedbackLock<T>(task: () => Promise<T>) {
  const filePath = feedbackFilePath(); const lockPath = `${filePath}.lock`;
  await mkdir(path.dirname(filePath), { recursive: true });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      try { return await task(); } finally { await handle.close(); await unlink(lockPath).catch(() => undefined); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = await stat(lockPath).then((value) => Date.now() - value.mtimeMs).catch(() => 0);
      if (age > 60_000) await unlink(lockPath).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, 10 + attempt * 5)));
    }
  }
  throw new Error(`Timed out waiting for feedback lock: ${lockPath}`);
}

async function quarantineInvalidLines(filePath: string, invalidLines: InvalidFeedbackLine[]) {
  if (!invalidLines.length) return;
  await appendFile(`${filePath}.quarantine.jsonl`, invalidLines.map((line) => JSON.stringify({ quarantinedAt: new Date().toISOString(), sourceFile: filePath, ...line })).join("\n") + "\n", "utf8");
}

function mutationContext(context: FeedbackMutationContext = {}) {
  return { actor: context.actor ?? process.env.USERNAME ?? process.env.USER ?? "unknown", runId: context.runId, reason: context.reason ?? "unspecified" };
}

async function mutateFeedback<T>(operation: string, context: FeedbackMutationContext, mutate: (entries: FeedbackEntry[]) => { entries: FeedbackEntry[]; result: T; fingerprints?: string[] }) {
  return withFeedbackLock(async () => {
    const filePath = feedbackFilePath(); const document = await readFeedbackDocument(filePath);
    await quarantineInvalidLines(filePath, document.invalidLines);
    const mutation = mutate(document.entries); await writeFeedbackAtomic(filePath, mutation.entries);
    await appendFile(`${filePath}.audit.jsonl`, JSON.stringify({ timestamp: new Date().toISOString(), operation, ...mutationContext(context), fingerprints: mutation.fingerprints ?? [], quarantinedLines: document.invalidLines.length }) + "\n", "utf8");
    return mutation.result;
  });
}

async function readAllFeedback() {
  return withFeedbackLock(async () => {
    const filePath = feedbackFilePath(); const document = await readFeedbackDocument(filePath);
    if (document.invalidLines.length) { await quarantineInvalidLines(filePath, document.invalidLines); await writeFeedbackAtomic(filePath, document.entries); }
    return document.entries;
  });
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

export async function appendFeedback(entry: FeedbackInput, context: FeedbackMutationContext = {}) {
  const filePath = feedbackFilePath(); const normalized = normalizeFeedback(entry);
  return mutateFeedback("append", context, (stored) => {
    const compacted = new Map<string, FeedbackEntry>(); for (const item of stored) compacted.set(item.fingerprint, item);
    const current = compacted.get(normalized.fingerprint);
    const definedInput = Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as Partial<FeedbackInput>;
    const next = current ? normalizeFeedback({ ...current, ...definedInput, createdAt: current.createdAt, fingerprint: current.fingerprint, trialCount: current.trialCount, successCount: current.successCount, failureCount: current.failureCount, lastAppliedAt: current.lastAppliedAt, lastSucceededAt: current.lastSucceededAt, effectScoreBefore: current.effectScoreBefore, effectScoreAfter: current.effectScoreAfter }) : normalized;
    const deduplicated = Boolean(current && JSON.stringify(current) === JSON.stringify(next)); compacted.set(next.fingerprint, next);
    return { entries: [...compacted.values()], result: { filePath, entry: deduplicated ? current! : next, deduplicated }, fingerprints: [next.fingerprint] };
  });
}

export async function recordFeedbackOutcome(fingerprints: string[], result: boolean | FeedbackOutcome, context: FeedbackMutationContext = {}) {
  if (fingerprints.length === 0) return []; const outcome = typeof result === "boolean" ? { succeeded: result } : result; const selected = new Set(fingerprints); const appliedAt = outcome.appliedAt ?? new Date().toISOString();
  return mutateFeedback("record-outcome", context, (stored) => {
    const compacted = new Map<string, FeedbackEntry>(); for (const entry of stored) compacted.set(entry.fingerprint, entry);
    const entries = [...compacted.values()].map((entry) => selected.has(entry.fingerprint) ? feedbackEntrySchema.parse({ ...entry, trialCount: entry.trialCount + 1, successCount: entry.successCount + (outcome.succeeded ? 1 : 0), failureCount: entry.failureCount + (outcome.succeeded ? 0 : 1), lastAppliedAt: appliedAt, lastSucceededAt: outcome.succeeded ? appliedAt : entry.lastSucceededAt, effectScoreBefore: outcome.scoreBefore ?? entry.effectScoreBefore, effectScoreAfter: outcome.scoreAfter ?? entry.effectScoreAfter }) : entry);
    return { entries, result: entries.filter((entry) => selected.has(entry.fingerprint)), fingerprints: [...selected] };
  });
}

export async function inspectFeedbackStore() {
  return withFeedbackLock(async () => { const filePath = feedbackFilePath(); const document = await readFeedbackDocument(filePath); const quarantineCount = await readFile(`${filePath}.quarantine.jsonl`, "utf8").then((raw) => raw.split(/\r?\n/).filter(Boolean).length).catch(() => 0); return { filePath, total: document.entries.length, enabled: document.entries.filter((entry) => entry.enabled).length, resolved: document.entries.filter((entry) => Boolean(entry.resolvedAt)).length, invalidLines: document.invalidLines.length, quarantineCount, quarantinePath: `${filePath}.quarantine.jsonl`, auditPath: `${filePath}.audit.jsonl` }; });
}

export async function setFeedbackEnabled(fingerprint: string, enabled: boolean, context: FeedbackMutationContext = {}) {
  return mutateFeedback(enabled ? "enable" : "disable", context, (entries) => { let matched: FeedbackEntry | undefined; const next = entries.map((entry) => entry.fingerprint === fingerprint ? (matched = feedbackEntrySchema.parse({ ...entry, enabled }), matched) : entry); if (!matched) throw new Error(`Feedback fingerprint not found: ${fingerprint}`); return { entries: next, result: matched, fingerprints: [fingerprint] }; });
}

export async function resolveFeedback(fingerprint: string, context: FeedbackMutationContext = {}) {
  return mutateFeedback("resolve", context, (entries) => { let matched: FeedbackEntry | undefined; const next = entries.map((entry) => entry.fingerprint === fingerprint ? (matched = feedbackEntrySchema.parse({ ...entry, resolvedAt: new Date().toISOString(), enabled: false }), matched) : entry); if (!matched) throw new Error(`Feedback fingerprint not found: ${fingerprint}`); return { entries: next, result: matched, fingerprints: [fingerprint] }; });
}

export async function compactFeedback(context: FeedbackMutationContext = {}) {
  return mutateFeedback("compact", context, (entries) => { const compacted = new Map(entries.map((entry) => [entry.fingerprint, entry])); return { entries: [...compacted.values()], result: { before: entries.length, after: compacted.size } }; });
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
