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
  successCount: z.number().int().nonnegative().default(0),
});

export type FeedbackEntry = z.infer<typeof feedbackEntrySchema>;
export type FeedbackInput = Omit<FeedbackEntry, "fingerprint" | "appliesTo" | "enabled" | "successCount"> & Partial<Pick<FeedbackEntry, "fingerprint" | "appliesTo" | "enabled" | "successCount">>;

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

function normalizeFeedback(entry: FeedbackInput) {
  const appliesTo = entry.appliesTo?.length ? entry.appliesTo : entry.url ? [`url:${entry.url}`] : ["global"];
  return feedbackEntrySchema.parse({ ...entry, appliesTo, fingerprint: entry.fingerprint || feedbackFingerprint({ ...entry, appliesTo }) });
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

export async function readFeedback(limit = 30) {
  const entries = await readAllFeedback();
  const deduplicated = new Map<string, FeedbackEntry>();
  for (const entry of entries) deduplicated.set(entry.fingerprint, entry);
  return [...deduplicated.values()].filter((entry) => entry.enabled && !entry.resolvedAt).slice(-limit);
}

export function selectFeedback(entries: FeedbackEntry[], context: { url: string; stage?: string; category?: string }) {
  return entries.filter((entry) => entry.appliesTo.some((scope) => scope === "global"
    || scope === `url:${context.url}`
    || (context.stage && scope === `stage:${context.stage}`)
    || (context.category && scope === `category:${context.category}`)));
}

export async function appendFeedback(entry: FeedbackInput) {
  const filePath = feedbackFilePath();
  const normalized = normalizeFeedback(entry);
  const compacted = new Map<string, FeedbackEntry>();
  for (const item of await readAllFeedback()) compacted.set(item.fingerprint, item);
  const existing = [...compacted.values()];
  if (existing.some((item) => item.fingerprint === normalized.fingerprint && item.enabled === normalized.enabled && item.resolvedAt === normalized.resolvedAt)) {
    return { filePath, entry: normalized, deduplicated: true };
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${existing.map((item) => JSON.stringify(item)).join("\n")}${existing.length ? "\n" : ""}${JSON.stringify(normalized)}\n`, "utf8");
  return { filePath, entry: normalized, deduplicated: false };
}

export async function recordFeedbackOutcome(fingerprints: string[], succeeded: boolean) {
  if (!succeeded || fingerprints.length === 0) return;
  const selected = new Set(fingerprints);
  const compacted = new Map<string, FeedbackEntry>();
  for (const entry of await readAllFeedback()) compacted.set(entry.fingerprint, entry);
  const entries = [...compacted.values()];
  const updated = entries.map((entry) => selected.has(entry.fingerprint) ? { ...entry, successCount: entry.successCount + 1 } : entry);
  const filePath = feedbackFilePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, updated.map((entry) => JSON.stringify(feedbackEntrySchema.parse(entry))).join("\n") + (updated.length ? "\n" : ""), "utf8");
}

export function buildFeedbackGuidance(entries: FeedbackEntry[]) {
  if (entries.length === 0) return "";
  const priority = { critical: 4, high: 3, medium: 2, low: 1 } as const;
  return entries
    .slice()
    .sort((left, right) => priority[right.severity] - priority[left.severity] || left.successCount - right.successCount)
    .slice(0, 12)
    .map((entry, index) => {
      const desired = entry.desired ? `；期望：${entry.desired}` : "";
      return `${index + 1}. [${entry.category}/${entry.severity}/${entry.fingerprint.slice(0, 8)}] ${entry.issue}${desired}`;
    })
    .join("\n");
}
