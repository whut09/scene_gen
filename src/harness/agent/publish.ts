import type { QualityEvaluation } from "../quality";
import type { StoryManifestItem } from "../../pipeline/story-manifest";
import type { VideoProject } from "../../pipeline/types";
import { RunJournalStore } from "../run-journal";
import { runStage } from "../stage-runner";
import { runPublishStage, type IngestStageOutput, type IterationReport } from "../video-stages";
import { nextAttempt } from "./loop-support";

export async function publishAgentRun(input: {
  journal: RunJournalStore; runId: string; url: string; story: StoryManifestItem; project: VideoProject;
  manifestPath: string; targetSeconds: number; maxIterations: number; engine: "remotion" | "html-video";
  ingest: IngestStageOutput; iterations: IterationReport[]; video: QualityEvaluation; reportDir: string; signal?: AbortSignal;
}) {
  const publish = await runStage({
    journal: input.journal, name: "publish", attempt: nextAttempt(input.journal, "publish"), inputs: { iterations: input.iterations, video: input.video }, timeoutMs: 60_000, signal: input.signal,
    task: () => runPublishStage({ runId: input.runId, journalPath: input.journal.filePath, url: input.url, story: input.story, project: input.project, manifestPath: input.manifestPath, targetSeconds: input.targetSeconds, maxIterations: input.maxIterations, engine: input.engine, feedback: input.ingest.feedback, iterations: input.iterations, video: input.video, reportDir: input.reportDir }),
    describe: (value) => ({ outputs: { reportPath: value.reportPath, markdownPath: value.markdownPath, productionReportPath: value.productionReportPath, templateOutcomeFile: value.templateLearning.filePath }, metrics: { passed: value.passed, templateOutcomesRecorded: value.templateLearning.recorded, providerOutcomesRecorded: value.providerHistory.recorded } }),
  });
  await input.journal.setArtifacts({ qualityReport: publish.value.reportPath, qualityReportMarkdown: publish.value.markdownPath, productionReport: publish.value.productionReportPath });
  if (publish.value.passed) await input.journal.succeed();
  else await input.journal.fail(new Error("Final video quality gate failed."));
  return publish.value;
}
