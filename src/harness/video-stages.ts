import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VideoProject } from "../pipeline/types";
import { generationResultSchema, type StoryManifestItem } from "../pipeline/story-manifest";
import { videoProjectSchema } from "../pipeline/schemas";
import { runExternalProcess } from "../pipeline/external-operation";
import { fromRoot, readJson, slugify, writeJsonAtomic } from "../pipeline/utils";
import { buildProductionReport } from "../production/production-report";
import { buildFeedbackGuidance, readFeedback, recordFeedbackOutcome, selectFeedback, type FeedbackEntry } from "./feedback-store";
import { evaluateAudio, evaluateDraft, evaluateVideo, type QualityEvaluation } from "./quality";
import { planRepair, withSuggestedActions, type RepairPlan } from "./retry-policy";
import type { LoopAudit } from "./loop-engineering";
import { emptyDirtyPlan, mergeDirtyPlans, type DirtyPlan } from "./dirty-plan";
import { recordStoryPlanOutcome } from "../pipeline/story-planner";
import type { HtmlVideoContentGraph } from "../html-video/content-graph";
import { readVisualAuditFile } from "../html-video/visual-audit";
import { recordTemplateOutcomes } from "../templates/template-learning";
import { recordProviderOutcome } from "../production/provider-stats";
import { findTtsPronunciations } from "../pipeline/tts-pronunciation";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

export interface IngestStageOutput {
  feedback: FeedbackEntry[];
  feedbackGuidance: string;
}

export interface GateStageOutput {
  evaluation: QualityEvaluation;
  repairPlan: RepairPlan;
}

export interface IterationReport {
  iteration: number;
  draft: QualityEvaluation;
  audio?: QualityEvaluation;
  draftProjectHash?: string;
  audioProjectHash?: string;
  audits?: LoopAudit[];
  dirtyPlan?: DirtyPlan;
}

export function combineNotes(parts: string[]) {
  return parts.map((part) => part.trim()).filter(Boolean).join("\n").slice(0, 5000);
}

export async function readProject(projectPath: string) {
  return videoProjectSchema.parse(await readJson<unknown>(projectPath)) as VideoProject;
}

export async function runIngestStage(url: string) {
  const feedback = await readFeedback(30);
  const relevantFeedback = selectFeedback(feedback, { url, stage: "draft" });
  return { feedback: relevantFeedback, feedbackGuidance: buildFeedbackGuidance(relevantFeedback) } satisfies IngestStageOutput;
}

async function runScript(
  script: string,
  args: string[],
  signal: AbortSignal,
  options: { timeoutMs: number; retries?: number; retryOnExit?: boolean },
) {
  await runExternalProcess(process.execPath, [tsxCli, fromRoot(script), ...args], {
    cwd: fromRoot(),
    signal,
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    retryOnExit: options.retryOnExit,
    inheritOutput: true,
  });
}

export async function runDraftStage(input: {
  url: string;
  targetSeconds: number;
  outputDir: string;
  screenshotLimit: number;
  runDir: string;
  generationResultPath: string;
  notes: string;
  ignoreCache: boolean;
  signal: AbortSignal;
}) {
  const args = [
    "--url", input.url,
    "--url-only",
    "--count", "1",
    "--screenshots", String(input.screenshotLimit),
    "--seconds", String(input.targetSeconds),
    "--out-dir", input.outputDir,
    "--skip-tts",
    "--run-dir", input.runDir,
    "--result-file", input.generationResultPath,
  ];
  if (input.ignoreCache) args.push("--ignore-cache");
  if (input.notes) args.push("--notes", input.notes.replace(/\r?\n/g, "；"));
  await runScript("src/pipeline/generate-stories.ts", args, input.signal, {
    timeoutMs: Number(process.env.HARNESS_DRAFT_TIMEOUT_MS ?? 300_000),
    retries: 1,
    retryOnExit: true,
  });
  return generationResultSchema.parse(JSON.parse(await readFile(input.generationResultPath, "utf8")));
}

export async function runDraftGateStage(project: VideoProject, targetSeconds: number, feedbackGuidance: string, signal: AbortSignal): Promise<GateStageOutput> {
  const evaluation = await evaluateDraft(project, targetSeconds, feedbackGuidance, signal);
  evaluation.issues = withSuggestedActions(evaluation.issues, "draft");
  return { evaluation, repairPlan: planRepair("draft", evaluation.issues, evaluation.profile, project.scenes.length) };
}

export async function runRevisionStage(input: {
  projectPath: string;
  sceneIndexes: number[];
  issues: string;
  promptStrategy?: "default" | "evidence-constrained" | "counterexample-first";
  providerStrategy?: "keep" | "fallback";
  resultPath: string;
  signal: AbortSignal;
}) {
  if (input.sceneIndexes.length === 0) throw new Error("Revision requires at least one scene index.");
  await runScript("src/harness/revise-scenes.ts", [
    "--project", input.projectPath,
    "--scenes", input.sceneIndexes.join(","),
    "--issues", input.issues,
    "--prompt-strategy", input.promptStrategy ?? "default",
    "--provider-strategy", input.providerStrategy ?? "keep",
    "--result-file", input.resultPath,
  ], input.signal, {
    timeoutMs: Number(process.env.HARNESS_REVISION_TIMEOUT_MS ?? 180_000),
    retries: 1,
    retryOnExit: true,
  });
  const result = await readJson<{ usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } }>(input.resultPath);
  return { project: await readProject(input.projectPath), usage: result.usage ?? {} };
}

export async function runSynthesizeStage(input: {
  projectPath: string;
  basename: string;
  targetSeconds: number;
  forceSceneIndexes?: number[];
  cacheSalt?: string;
  reason?: string;
  forceAudioRebuild?: boolean;
  provider?: "openai" | "f5" | "local";
  signal: AbortSignal;
}) {
  const args = [
    "--project", input.projectPath,
    "--basename", input.basename,
    "--seconds", String(input.targetSeconds),
  ];
  if (input.forceAudioRebuild) args.push("--force-audio-rebuild");
  if (input.forceSceneIndexes?.length) args.push("--force-scenes", input.forceSceneIndexes.join(","));
  if (input.cacheSalt) args.push("--cache-salt", input.cacheSalt);
  if (input.reason) args.push("--reason", input.reason);
  if (input.provider) args.push("--provider", input.provider);
  await runScript("src/pipeline/synthesize-story.ts", args, input.signal, {
    timeoutMs: Number(process.env.HARNESS_SYNTHESIZE_TIMEOUT_MS ?? 900_000),
    retries: 1,
    retryOnExit: true,
  });
  return readProject(input.projectPath);
}

export async function runAudioGateStage(project: VideoProject, targetSeconds: number, signal: AbortSignal): Promise<GateStageOutput> {
  const evaluation = await evaluateAudio(project, targetSeconds, signal);
  evaluation.issues = withSuggestedActions(evaluation.issues, "audio");
  evaluation.metrics = { ...evaluation.metrics, ...(project.audio?.metrics ?? {}) };
  return { evaluation, repairPlan: planRepair("audio", evaluation.issues, evaluation.profile, project.scenes.length) };
}

export async function runRenderStage(input: {
  manifestPath: string;
  engine: string;
  forceSceneIndexes?: number[];
  forceRender?: boolean;
  remuxOnly?: boolean;
  remuxRequired?: boolean;
  resultPath?: string;
  signal: AbortSignal;
}) {
  const args = ["--manifest", input.manifestPath, "--overwrite", "--engine", input.engine];
  if (input.forceRender) args.push("--force-render");
  else if (input.forceSceneIndexes?.length) args.push("--force-scenes", input.forceSceneIndexes.join(","));
  if (input.remuxOnly) args.push("--remux-only");
  if (input.resultPath) args.push("--result", input.resultPath);
  await runScript("src/pipeline/render-stories.ts", args, input.signal, {
    timeoutMs: Number(process.env.HARNESS_RENDER_TIMEOUT_MS ?? 1_800_000),
    retries: 1,
    retryOnExit: true,
  });
  const result = input.resultPath
    ? await readJson<{ stories?: Array<{ visualAuditPath?: string; metrics?: Record<string, unknown> }> }>(input.resultPath)
    : undefined;
  return {
    remuxedVideo: Boolean(input.remuxRequired && input.engine === "html-video"),
    remuxOnly: Boolean(input.remuxOnly),
    metrics: result?.stories?.[0]?.metrics,
    visualAuditPath: result?.stories?.[0]?.visualAuditPath,
    resultPath: input.resultPath,
  };
}

export async function runVideoGateStage(input: {
  story: StoryManifestItem;
  project: VideoProject;
  reportDir: string;
  signal: AbortSignal;
  repairAttempt?: number;
}): Promise<GateStageOutput> {
  const evaluation = await evaluateVideo(
    input.story.outputPath,
    input.reportDir,
    input.project.audio?.durationSeconds,
    input.project.scenes.map((scene) => scene.duration),
    input.signal,
    {
      project: input.project,
      htmlVideoGraphPath: input.story.htmlVideoGraphPath,
      visualAuditPath: input.story.htmlVideoGraphPath ? path.join(path.dirname(input.story.htmlVideoGraphPath), "visual-audit.json") : undefined,
    },
  );
  evaluation.issues = withSuggestedActions(evaluation.issues, "video");
  return { evaluation, repairPlan: planRepair("video", evaluation.issues, evaluation.profile, input.project.scenes.length, input.repairAttempt ?? 1) };
}

function evaluationMarkdown(evaluation: QualityEvaluation) {
  const scoreLabel = evaluation.scoreStatus === "unavailable" ? "未评估"
    : evaluation.scoreStatus === "not-required" ? "无需评估"
      : evaluation.scoreStatus === "partially-measured" ? "部分评估" : "已评估";
  const lines = [`### ${evaluation.stage}`, `- Outcome: ${evaluation.outcome}`, `- Profile: ${evaluation.profile.name}`, `- Passed: ${evaluation.passed}`, `- Metrics: ${JSON.stringify(evaluation.metrics)}`];
  if (evaluation.scores) lines.push(`- Scores: ${JSON.stringify(evaluation.scores)}`);
  for (const issue of evaluation.issues) lines.push(`- ${issue.severity.toUpperCase()} ${issue.code} [${issue.issueClass}] -> ${issue.repairAction} (retryable=${issue.retryable}): ${JSON.stringify(issue.evidence)}`);
  lines.splice(4, 0, "- Score status: " + scoreLabel + " (" + evaluation.scoreStatus + ")");
  if (!evaluation.scores) lines.push("- Scores: " + scoreLabel);
  return lines.join("\n");
}

export async function runPublishStage(input: {
  runId: string;
  journalPath: string;
  url: string;
  story: StoryManifestItem;
  project: VideoProject;
  manifestPath: string;
  targetSeconds: number;
  maxIterations: number;
  engine: string;
  feedback: FeedbackEntry[];
  iterations: IterationReport[];
  video: QualityEvaluation;
  reportDir: string;
}) {
  const finalDraft = input.iterations.at(-1)?.draft;
  const finalAudio = input.iterations.at(-1)?.audio;
  const passed = Boolean(finalDraft?.passed && finalAudio?.passed && input.video.passed);
  const production = buildProductionReport(input.project, input.engine);
  const dirtyPlan = mergeDirtyPlans(
    ...input.iterations.map((iteration) => iteration.dirtyPlan ?? emptyDirtyPlan()),
    ...input.iterations.flatMap((iteration) => (iteration.audits ?? []).map((audit) => audit.dirtyPlan)),
    planRepair("video", input.video.issues, input.video.profile, input.project.scenes.length).dirtyPlan,
  );
  const journal = await readJson<{ artifacts?: Record<string, string>; stages?: Array<{ name?: string; attempt?: number; repairCandidates?: unknown; repairDecision?: unknown }> }>(input.journalPath)
    .catch(() => ({ stages: [], artifacts: {} as Record<string, string> }));
  const repairDecisions = (journal.stages ?? [])
    .filter((stage) => stage.repairDecision)
    .map((stage) => ({ stage: stage.name, attempt: stage.attempt, decision: stage.repairDecision, candidates: stage.repairCandidates ?? [] }));
  const strategyTrajectory = journal.artifacts?.strategyTrajectory
    ? await readJson<{ entries?: unknown[] }>(journal.artifacts.strategyTrajectory).then((value) => value.entries ?? []).catch(() => [])
    : [];
  const loopBudget = journal.artifacts?.loopBudget ? await readJson<unknown>(journal.artifacts.loopBudget).catch(() => undefined) : undefined;
  await mkdir(input.reportDir, { recursive: true });
  const productionReportPath = path.join(input.reportDir, "production-report.json");
  const reportPath = path.join(input.reportDir, "report.json");
  const markdownPath = path.join(input.reportDir, "report.md");
  const graph = input.story.htmlVideoGraphPath
    ? await readJson<HtmlVideoContentGraph>(input.story.htmlVideoGraphPath).catch(() => undefined)
    : undefined;
  const visualAudit = input.story.htmlVideoGraphPath
    ? await readVisualAuditFile(path.join(path.dirname(input.story.htmlVideoGraphPath), "visual-audit.json")).catch(() => undefined)
    : undefined;
  const templateLearning = graph
    ? await recordTemplateOutcomes({
      runId: input.runId,
      project: input.project,
      nodes: graph.nodes.map((node) => ({ sceneIndex: node.sceneIndex, templateId: node.templateId, variantId: node.variantId, intent: node.intent })),
      visualAudit,
      videoIssues: input.video.issues,
      renderMetrics: input.video.metrics,
      feedback: input.feedback,
    }).catch(() => ({ recorded: 0, filePath: "" }))
    : { recorded: 0, filePath: "" };
  const audioProviderId = input.project.audio?.provider === "openai" ? "openai-tts"
    : input.project.audio?.provider === "f5" ? "f5"
      : input.project.audio?.provider === "local" ? "local-tts" : undefined;
  const providerOperations = [
    audioProviderId && finalAudio ? recordProviderOutcome({
      runId: input.runId, providerId: audioProviderId, capability: "tts", operation: "narration-quality",
      success: finalAudio.passed, latencyMs: Number(input.project.audio?.metrics?.synthesisMs ?? 0) + Number(input.project.audio?.metrics?.workerStartupMs ?? 0),
      timeout: finalAudio.issues.some((issue) => issue.code === "asr_verification_failed" && /timeout/i.test(issue.message)),
      retryCount: Math.max(0, Number(input.project.audio?.metrics?.workerStartCount ?? 1) - 1), cost: 0,
      unitKind: "chars", unitCount: [...input.project.narration].length,
      qualityScore: Math.max(0, Math.min(1, 1 - finalAudio.issues.filter((issue) => issue.severity === "error").length * 0.2 - finalAudio.issues.filter((issue) => issue.severity === "warning").length * 0.05)),
      pronunciationAccurate: findTtsPronunciations(input.project.narration).length
        ? !finalAudio.issues.some((issue) => issue.code === "audio_pronunciation_mismatch")
        : undefined,
      language: "zh-CN", domain: input.project.sources[0]?.domain ?? input.project.sources[0]?.tags?.[0] ?? "general",
      device: audioProviderId === "f5" ? process.env.F5_TTS_DEVICE ?? "auto" : undefined,
    }) : undefined,
    recordProviderOutcome({
      runId: input.runId, providerId: input.engine, capability: "programmatic", operation: "video-render",
      success: input.video.passed, latencyMs: Number(input.video.metrics.totalRenderMs ?? 0), timeout: input.video.issues.some((issue) => /timeout/i.test(issue.code + issue.message)),
      retryCount: Math.max(0, input.iterations.length - 1), cost: 0, unitKind: "seconds", unitCount: input.project.meta.durationSeconds,
      qualityScore: Math.max(0, Math.min(1, 1 - input.video.issues.filter((issue) => issue.severity === "error").length * 0.2 - input.video.issues.filter((issue) => issue.severity === "warning").length * 0.05)),
      language: "zh-CN", domain: input.project.sources[0]?.domain ?? input.project.sources[0]?.tags?.[0] ?? "general",
    }),
    input.project.narrationSegments?.some((segment) => segment.speechAlignment) ? recordProviderOutcome({
      runId: input.runId, providerId: "whisper", capability: "alignment", operation: "speech-alignment",
      success: input.project.narrationSegments.some((segment) => segment.speechAlignment?.status === "forced"), latencyMs: 0, timeout: false, retryCount: 0, cost: 0,
      unitKind: "seconds", unitCount: input.project.audio?.durationSeconds ?? input.project.meta.durationSeconds,
      qualityScore: input.project.narrationSegments.reduce((sum, segment) => sum + (segment.speechAlignment?.confidence ?? 0), 0) / Math.max(1, input.project.narrationSegments.length),
      language: "zh-CN", domain: input.project.sources[0]?.domain ?? input.project.sources[0]?.tags?.[0] ?? "general",
    }) : undefined,
  ].filter((operation) => operation !== undefined);
  const providerOutcomeResults = await Promise.all(providerOperations).catch(() => []);
  const providerHistory = { recorded: providerOutcomeResults.length };
  const initialDraft = input.iterations[0]?.draft;
  const initialDraftScore = typeof initialDraft?.metrics.scoreAverage === "number" ? initialDraft.metrics.scoreAverage : undefined;
  const finalDraftScore = typeof finalDraft?.metrics.scoreAverage === "number" ? finalDraft.metrics.scoreAverage : undefined;
  const feedbackOutcomes = await recordFeedbackOutcome(input.feedback.map((entry) => entry.fingerprint), {
    succeeded: passed,
    scoreBefore: initialDraftScore,
    scoreAfter: finalDraftScore,
  }).catch(() => []);
  await writeFile(productionReportPath, `${JSON.stringify(production, null, 2)}\n`, "utf8");
  await writeJsonAtomic(reportPath, {
    createdAt: new Date().toISOString(),
    runId: input.runId,
    runJournalPath: input.journalPath,
    url: input.url,
    outputPath: input.story.outputPath,
    projectPath: input.story.projectPath,
    manifestPath: input.manifestPath,
    targetSeconds: input.targetSeconds,
    maxIterations: input.maxIterations,
    engine: input.engine,
    feedbackApplied: input.feedback,
    feedbackOutcomes,
    iterations: input.iterations,
    video: input.video,
    dirtyPlan,
    repairDecisions,
    strategyTrajectory,
    loopBudget,
    production,
    templateLearning,
    providerHistory,
    passed,
  });
  const markdown = [
    "# Video Quality Report",
    "",
    `- Run: ${input.runId}`,
    `- URL: ${input.url}`,
    `- Output: ${input.story.outputPath}`,
    `- Target: ${input.targetSeconds}s`,
    `- Engine: ${input.engine}`,
    `- Passed: ${passed}`,
    `- Feedback applied: ${input.feedback.length}`,
    `- Feedback outcomes recorded: ${feedbackOutcomes.length}`,
    `- Dirty plan: ${JSON.stringify(dirtyPlan)}`,
    `- Repair decisions: ${repairDecisions.length}`,
    `- Strategy trajectory entries: ${strategyTrajectory.length}`,
    `- Loop budget: ${JSON.stringify(loopBudget ?? {})}`,
    "",
    ...input.iterations.flatMap((item) => [
      `## Iteration ${item.iteration}`,
      evaluationMarkdown(item.draft),
      item.audio ? evaluationMarkdown(item.audio) : "",
      ...(item.audits ?? []).map((audit) => `- Loop audit ${audit.stage}: ${audit.progress}; patch=${audit.patch.length}; resolved=${audit.resolvedIssues.join(",") || "none"}; new=${audit.newIssues.join(",") || "none"}; tokens=${audit.cost.totalTokens}; durationMs=${audit.cost.durationMs}`),
      "",
    ]),
    ...repairDecisions.map((item) => `- Repair decision ${item.stage}#${item.attempt}: ${JSON.stringify(item.decision)}`),
    "## Production Decisions",
    `- Visual source mix: ${JSON.stringify(production.summary.sourceMix)}`,
    `- Enabled providers: ${production.summary.enabledProviders.join(", ")}`,
    `- Degraded providers: ${production.summary.degradedProviders.join(", ") || "none"}`,
    `- Unhealthy providers: ${production.summary.unhealthyProviders.join(", ") || "none"}`,
    ...production.providerSelections.map((selection) => `- Provider selection ${selection.capability}: selected=${selection.selectedProviderId ?? "none"}; candidates=${selection.candidates.map((candidate) => `${candidate.providerId}[score=${candidate.score}; eliminated=${candidate.eliminated}; ${candidate.reasons.join("|")}]`).join("; ")}`),
    `- Alignment: ${production.summary.wordAlignment}`,
    `- Aligned cues: ${production.summary.alignedCueCount}/${production.summary.alignedCueCount + production.summary.estimatedCueCount}`,
    `- Alignment coverage: ${(production.summary.alignmentCoverage * 100).toFixed(1)}%`,
    `- Alignment confidence: ${production.summary.averageAlignmentConfidence.toFixed(3)}`,
    `- Template exploration: ${production.summary.exploredTemplateCount}/${production.decisions.length}`,
    `- Template learned adjustment: ${production.summary.averageTemplateLearnedAdjustment.toFixed(3)}`,
    `- Template history samples: ${production.summary.templateHistorySamples}`,
    `- Template outcomes recorded: ${templateLearning.recorded}`,
    `- Provider outcomes recorded: ${providerHistory.recorded}`,
    ...production.decisions.map((decision) => `- Scene ${decision.sceneIndex + 1} template: ${decision.templateSelection.templateId}:${decision.templateSelection.variantId}; rule=${decision.templateSelection.ruleScore}; learned=${decision.templateSelection.learnedAdjustment}; final=${decision.templateSelection.score}; history=${decision.templateSelection.history.scope}:${decision.templateSelection.history.samples}; explored=${decision.templateSelection.explored}`),
    ...(production.storyPlanning ? [
      `- Story plan: ${production.storyPlanning.selectedCandidateId}; candidates=${production.storyPlanning.requestedCandidates}; score=${production.storyPlanning.rankings.find((ranking) => ranking.candidate.id === production.storyPlanning?.selectedCandidateId)?.scores.total ?? 0}`,
      `- Rejected story plans: ${production.storyPlanning.rankings.filter((ranking) => ranking.rejectedReasons.length > 0).map((ranking) => `${ranking.candidate.id}[${ranking.rejectedReasons.join(",")}]`).join("; ") || "none"}`,
    ] : []),
    "",
    "## Final Video",
    evaluationMarkdown(input.video),
    "",
  ].join("\n");
  await writeFile(markdownPath, markdown, "utf8");
  await recordStoryPlanOutcome(input.project, passed, Number(finalDraft?.metrics.scoreAverage ?? 0) - 78).catch(() => undefined);
  return { passed, reportPath, markdownPath, productionReportPath, templateLearning, providerHistory };
}

export function narrationBasename(runId: string, project: VideoProject) {
  return `narration-agent-${slugify(runId, "run").slice(0, 40)}-${slugify(project.sources[0]?.id ?? project.meta.title, "story")}`;
}
