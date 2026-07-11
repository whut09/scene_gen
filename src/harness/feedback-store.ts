import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fromRoot } from "../pipeline/utils";

export type FeedbackSeverity = "low" | "medium" | "high" | "critical";

export interface FeedbackEntry {
  createdAt: string;
  category: string;
  severity: FeedbackSeverity;
  issue: string;
  desired?: string;
  url?: string;
  videoPath?: string;
}

export function feedbackFilePath() {
  return process.env.VIDEO_FEEDBACK_FILE
    ? path.resolve(process.env.VIDEO_FEEDBACK_FILE)
    : fromRoot("data", "feedback", "feedback.jsonl");
}

export async function readFeedback(limit = 30) {
  try {
    const raw = await readFile(feedbackFilePath(), "utf8");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FeedbackEntry)
      .slice(-limit);
  } catch {
    return [];
  }
}

export async function appendFeedback(entry: FeedbackEntry) {
  const filePath = feedbackFilePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
  return filePath;
}

export function buildFeedbackGuidance(entries: FeedbackEntry[]) {
  if (entries.length === 0) return "";
  const priority = { critical: 4, high: 3, medium: 2, low: 1 } as const;
  return entries
    .slice()
    .sort((a, b) => priority[b.severity] - priority[a.severity])
    .slice(0, 12)
    .map((entry, index) => {
      const desired = entry.desired ? `；期望：${entry.desired}` : "";
      return `${index + 1}. [${entry.category}/${entry.severity}] ${entry.issue}${desired}`;
    })
    .join("\n");
}