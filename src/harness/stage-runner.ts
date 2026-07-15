import { createHash } from "node:crypto";
import type { RunJournalStore } from "./run-journal";
import type { StageIssue, StageResult, SuggestedAction, VideoStageName } from "./stage-types";

interface StageDescription {
  outputs?: Record<string, string>;
  issues?: StageIssue[];
  metrics?: Record<string, string | number | boolean>;
  suggestedAction?: SuggestedAction;
}

interface RunStageOptions<T> {
  journal: RunJournalStore;
  name: VideoStageName;
  attempt: number;
  inputs: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  task: (signal: AbortSignal) => Promise<T>;
  describe?: (value: T) => StageDescription;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

export function inputHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export async function runStage<T>(options: RunStageOptions<T>) {
  const startedAt = new Date().toISOString();
  const hash = inputHash(options.inputs);
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason ?? new Error("Pipeline cancelled."));
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`${options.name} timed out after ${options.timeoutMs}ms.`)), options.timeoutMs);
  await options.journal.recordStageResult({
    name: options.name,
    status: "running",
    inputHash: hash,
    outputs: {},
    issues: [],
    metrics: {},
    durationMs: 0,
    attempt: options.attempt,
    suggestedAction: "none",
    startedAt,
  });
  try {
    const value = await options.task(controller.signal);
    const description = options.describe?.(value) ?? {};
    const result: StageResult = {
      name: options.name,
      status: "succeeded",
      inputHash: hash,
      outputs: description.outputs ?? {},
      issues: description.issues ?? [],
      metrics: description.metrics ?? {},
      durationMs: Math.max(0, Date.now() - Date.parse(startedAt)),
      attempt: options.attempt,
      suggestedAction: description.suggestedAction ?? "none",
      startedAt,
      completedAt: new Date().toISOString(),
    };
    await options.journal.recordStageResult(result);
    return { value, result };
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    const result: StageResult = {
      name: options.name,
      status: "failed",
      inputHash: hash,
      outputs: {},
      issues: [{ severity: "error", code: controller.signal.aborted ? "stage_timeout_or_cancelled" : "stage_execution_failed", message, suggestedAction: "retry-stage" }],
      metrics: {},
      durationMs: Math.max(0, Date.now() - Date.parse(startedAt)),
      attempt: options.attempt,
      suggestedAction: "retry-stage",
      startedAt,
      completedAt: new Date().toISOString(),
      error: message,
    };
    await options.journal.recordStageResult(result);
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
