import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { QualityEvaluation } from "../quality";
import type { StoryManifestItem } from "../../pipeline/story-manifest";
import type { VideoProject } from "../../pipeline/types";
import { fromRoot, readJson, writeJsonAtomic } from "../../pipeline/utils";
import { RunJournalStore } from "../run-journal";
import { parseStageName, stageIndex, type VideoStageName } from "../stage-types";
import { finalizeLoopAudit, type LoopAudit } from "../loop-engineering";
import { normalizeStoredQualityEvaluation } from "../quality-protocol";
import type { LoopStrategyTrace } from "../loop-governance";
import type { IterationReport } from "../video-stages";

export interface AgentState {
  story?: StoryManifestItem;
  project?: VideoProject;
  manifestPath?: string;
  iterations: IterationReport[];
  video?: QualityEvaluation;
}

export function resolveRunDir(value: string) {
  const direct = path.resolve(value);
  if (existsSync(path.join(direct, "run.json"))) return direct;
  return fromRoot("dist", "runs", value);
}

export function nextAttempt(journal: RunJournalStore, name: VideoStageName) {
  const attempts = journal.snapshot().stages.filter((stage) => stage.name === name).map((stage) => stage.attempt);
  return Math.max(0, ...attempts) + 1;
}

export async function loadIterations(artifacts: Record<string, string>) {
  const reports = new Map<number, IterationReport>();
  for (const [key, filePath] of Object.entries(artifacts)) {
    const match = key.match(/^iteration(\d+)(Draft|Audio)$/);
    if (!match || !existsSync(filePath)) continue;
    const iteration = Number(match[1]);
    const evaluation = normalizeStoredQualityEvaluation(await readJson<unknown>(filePath));
    const current = reports.get(iteration) ?? { iteration, draft: evaluation };
    if (match[2] === "Draft") {
      current.draft = evaluation;
      current.draftProjectHash = typeof evaluation.metrics.projectHash === "string" ? evaluation.metrics.projectHash : undefined;
      current.draftUpdatedAtMs = await stat(filePath).then((value) => value.mtimeMs).catch(() => 0);
    } else {
      current.audio = evaluation;
      current.audioProjectHash = typeof evaluation.metrics.projectHash === "string" ? evaluation.metrics.projectHash : undefined;
      current.audioUpdatedAtMs = await stat(filePath).then((value) => value.mtimeMs).catch(() => 0);
    }
    reports.set(iteration, current);
  }
  for (const [key, filePath] of Object.entries(artifacts)) {
    const match = key.match(/^iteration(\d+)(Draft|Audio)Audit$/);
    if (!match || !existsSync(filePath)) continue;
    const current = reports.get(Number(match[1]));
    if (!current) continue;
    current.audits = [...(current.audits ?? []), await readJson<LoopAudit>(filePath)];
  }
  return [...reports.values()].filter((item) => item.draft?.stage === "draft").sort((left, right) => left.iteration - right.iteration);
}

export async function persistLoopAudit(journal: RunJournalStore, runDir: string, audit: LoopAudit) {
  const auditPath = path.join(runDir, "loop", `iteration-${audit.iteration}-${audit.stage}.json`);
  await writeJsonAtomic(auditPath, audit);
  await journal.setArtifacts({ [`iteration${audit.iteration}${audit.stage === "draft" ? "Draft" : "Audio"}Audit`]: auditPath });
}

export async function persistStrategyTrajectory(journal: RunJournalStore, runDir: string, trajectory: LoopStrategyTrace[]) {
  const filePath = path.join(runDir, "loop", "strategy-trajectory.json");
  await writeJsonAtomic(filePath, { version: 1, updatedAt: new Date().toISOString(), entries: trajectory });
  await journal.setArtifacts({ strategyTrajectory: filePath });
}

export async function finalizePendingAudit(journal: RunJournalStore, runDir: string, reports: IterationReport[], stage: "draft" | "audio", evaluation: QualityEvaluation) {
  const previous = [...reports].reverse().find((item) => item.audits?.some((audit) => audit.stage === stage && audit.progress === "pending"));
  const index = previous?.audits?.findIndex((audit) => audit.stage === stage && audit.progress === "pending") ?? -1;
  if (!previous?.audits || index < 0) return;
  const audit = finalizeLoopAudit(previous.audits[index], evaluation);
  previous.audits[index] = audit;
  await persistLoopAudit(journal, runDir, audit);
}

export function resumeStage(journal: RunJournalStore): VideoStageName {
  const stages = journal.snapshot().stages;
  const failed = [...stages].reverse().find((stage) => stage.status === "failed" || stage.status === "running");
  if (failed) {
    try { return parseStageName(failed.name); } catch { return "draft"; }
  }
  const completed = new Set(stages.filter((stage) => stage.status === "succeeded").map((stage) => stage.name));
  return (["ingest", "draft", "draft-gate", "synthesize", "audio-gate", "render", "video-gate", "publish"] as VideoStageName[])
    .find((stage) => !completed.has(stage)) ?? "publish";
}

export function shouldRun(stage: VideoStageName, startStage: VideoStageName, forceStage?: VideoStageName) {
  return stageIndex(stage) >= stageIndex(startStage) || stage === forceStage;
}
