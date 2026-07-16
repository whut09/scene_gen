import { existsSync } from "node:fs";
import path from "node:path";
import { readRunJournalFile } from "../harness/run-journal";
import { readStoryManifest } from "../pipeline/story-manifest";
import { fromRoot } from "../pipeline/utils";
import { readHtmlVideoContentGraphFile } from "../html-video/content-graph";
import { readProductionReportFile } from "../production/production-report";

export interface MigratedRunArtifact {
  kind: "run-journal" | "content-graph" | "production-report";
  filePath: string;
  migratedFrom?: number;
  migratedTo: number;
  backupPath?: string;
}

export function resolveMigrationRunDir(runIdOrDirectory: string) {
  const direct = path.resolve(runIdOrDirectory);
  return existsSync(path.join(direct, "run.json")) ? direct : fromRoot("dist", "runs", runIdOrDirectory);
}

export async function migrateRunArtifacts(runIdOrDirectory: string) {
  const runDir = resolveMigrationRunDir(runIdOrDirectory);
  const journalResult = await readRunJournalFile(path.join(runDir, "run.json"), true);
  const results: MigratedRunArtifact[] = [{ kind: "run-journal", filePath: path.join(runDir, "run.json"), migratedFrom: journalResult.migratedFrom, migratedTo: journalResult.migratedTo, backupPath: journalResult.backupPath }];
  const candidates = new Map<string, "content-graph" | "production-report">();
  for (const artifactPath of Object.values(journalResult.value.artifacts)) {
    if (path.basename(artifactPath) === "content-graph.json") candidates.set(path.resolve(artifactPath), "content-graph");
    if (path.basename(artifactPath) === "production-report.json") candidates.set(path.resolve(artifactPath), "production-report");
  }
  const manifestPath = journalResult.value.artifacts.manifestPath;
  if (manifestPath && existsSync(manifestPath)) {
    const manifest = await readStoryManifest(manifestPath).catch(() => []);
    for (const story of manifest) {
      if (story.htmlVideoGraphPath) candidates.set(path.resolve(story.htmlVideoGraphPath), "content-graph");
      if (story.productionReportPath) candidates.set(path.resolve(story.productionReportPath), "production-report");
    }
  }
  for (const [filePath, kind] of candidates) {
    if (!existsSync(filePath)) continue;
    const result = kind === "content-graph"
      ? await readHtmlVideoContentGraphFile(filePath, true)
      : await readProductionReportFile(filePath, true);
    results.push({ kind, filePath, migratedFrom: result.migratedFrom, migratedTo: result.migratedTo, backupPath: result.backupPath });
  }
  return { runId: journalResult.value.runId, runDir, migratedCount: results.filter((result) => result.migratedFrom !== undefined).length, artifacts: results };
}
