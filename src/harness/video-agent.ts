import { existsSync } from "node:fs";
import path from "node:path";
import type { QualityEvaluation, QualityIssue } from "./quality";
import type { StoryManifestItem } from "../pipeline/story-manifest";
import { readStoryManifest } from "../pipeline/story-manifest";
import type { VideoProject } from "../pipeline/types";
import { fromRoot, loadDotEnv, parseArgs, readJson, slugify, writeJsonAtomic } from "../pipeline/utils";
import { RunJournalStore } from "./run-journal";
import { runStage } from "./stage-runner";
import { parseStageName, stageIndex, type StageResult, type VideoStageName } from "./stage-types";
import { audioLoopHash, createLoopAudit, finalizeLoopAudit, hasRepeatedNoProgress, projectLoopHash, type LoopAudit } from "./loop-engineering";
import { normalizeStoredQualityEvaluation } from "./quality-protocol";
import { mergeDirtyPlans } from "./dirty-plan";
import { defaultOutputDir } from "../runtime/runtime-paths";
import {
  combineNotes,
  narrationBasename,
  readProject,
  runAudioGateStage,
  runDraftGateStage,
  runDraftStage,
  runIngestStage,
  runPublishStage,
  runRenderStage,
  runRevisionStage,
  runSynthesizeStage,
  runVideoGateStage,
  type GateStageOutput,
  type IngestStageOutput,
  type IterationReport,
} from "./video-stages";

interface AgentState {
  story?: StoryManifestItem;
  project?: VideoProject;
  manifestPath?: string;
  iterations: IterationReport[];
  video?: QualityEvaluation;
}

function resolveRunDir(value: string) {
  const direct = path.resolve(value);
  if (existsSync(path.join(direct, "run.json"))) return direct;
  return fromRoot("dist", "runs", value);
}

function nextAttempt(journal: RunJournalStore, name: VideoStageName) {
  const attempts = journal.snapshot().stages.filter((stage) => stage.name === name).map((stage) => stage.attempt);
  return Math.max(0, ...attempts) + 1;
}

async function loadIterations(artifacts: Record<string, string>) {
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
    } else {
      current.audio = evaluation;
      current.audioProjectHash = typeof evaluation.metrics.projectHash === "string" ? evaluation.metrics.projectHash : undefined;
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

async function persistLoopAudit(journal: RunJournalStore, runDir: string, audit: LoopAudit) {
  const auditPath = path.join(runDir, "loop", `iteration-${audit.iteration}-${audit.stage}.json`);
  await writeJsonAtomic(auditPath, audit);
  await journal.setArtifacts({ [`iteration${audit.iteration}${audit.stage === "draft" ? "Draft" : "Audio"}Audit`]: auditPath });
}

async function finalizePendingAudit(journal: RunJournalStore, runDir: string, reports: IterationReport[], stage: "draft" | "audio", evaluation: QualityEvaluation) {
  const previous = [...reports].reverse().find((item) => item.audits?.some((audit) => audit.stage === stage && audit.progress === "pending"));
  const index = previous?.audits?.findIndex((audit) => audit.stage === stage && audit.progress === "pending") ?? -1;
  if (!previous?.audits || index < 0) return;
  const audit = finalizeLoopAudit(previous.audits[index], evaluation);
  previous.audits[index] = audit;
  await persistLoopAudit(journal, runDir, audit);
}

function resumeStage(journal: RunJournalStore): VideoStageName {
  const stages = journal.snapshot().stages;
  const failed = [...stages].reverse().find((stage) => stage.status === "failed" || stage.status === "running");
  if (failed) {
    try { return parseStageName(failed.name); } catch { return "draft"; }
  }
  const completed = new Set(stages.filter((stage) => stage.status === "succeeded").map((stage) => stage.name));
  return (["ingest", "draft", "draft-gate", "synthesize", "audio-gate", "render", "video-gate", "publish"] as VideoStageName[])
    .find((stage) => !completed.has(stage)) ?? "publish";
}

function shouldRun(stage: VideoStageName, startStage: VideoStageName, forceStage?: VideoStageName) {
  return stageIndex(stage) >= stageIndex(startStage) || stage === forceStage;
}

export async function runVideoAgent(argv: string[], signal?: AbortSignal) {
  loadDotEnv();
  const args = parseArgs(argv);
  const resumeValue = typeof args.resume === "string" ? args.resume : undefined;
  const explicitFromStage = typeof args["from-stage"] === "string" ? parseStageName(args["from-stage"]) : undefined;
  const forceStage = typeof args["force-stage"] === "string" ? parseStageName(args["force-stage"]) : undefined;
  let journal: RunJournalStore;
  let runDir: string;
  let runId: string;
  let url: string;
  let targetSeconds: number;
  let maxIterations: number;
  let outputDir: string;
  let screenshotLimit: number;
  let engine: "remotion" | "html-video";
  let qualityProfile: "balanced" | "strict" | "lenient";
  let startStage: VideoStageName;

  if (resumeValue) {
    runDir = resolveRunDir(resumeValue);
    journal = await RunJournalStore.open(runDir);
    const snapshot = journal.snapshot();
    runId = snapshot.runId;
    url = typeof args.url === "string" ? args.url : snapshot.url;
    targetSeconds = typeof args.seconds === "string" ? Number(args.seconds) : snapshot.config.targetSeconds;
    maxIterations = typeof args.iterations === "string" ? Math.max(1, Math.min(4, Number(args.iterations))) : snapshot.config.maxIterations;
    outputDir = typeof args["out-dir"] === "string" ? path.resolve(args["out-dir"]) : snapshot.config.outputDir;
    screenshotLimit = typeof args.screenshots === "string" ? Number(args.screenshots) : snapshot.config.screenshotLimit;
    engine = typeof args.engine === "string" ? args.engine as typeof engine : snapshot.config.engine;
    qualityProfile = typeof args["quality-profile"] === "string" ? args["quality-profile"] as typeof qualityProfile : snapshot.config.qualityProfile;
    startStage = explicitFromStage ?? forceStage ?? resumeStage(journal);
    await journal.resume();
  } else {
    if (typeof args.url !== "string") throw new Error('Usage: scene-gen run --url "https://example.com/news" or scene-gen resume <run-id>');
    url = args.url;
    targetSeconds = Number(args.seconds ?? 100);
    maxIterations = Math.max(1, Math.min(4, Number(args.iterations ?? process.env.HARNESS_MAX_ITERATIONS ?? 2)));
    outputDir = typeof args["out-dir"] === "string" ? path.resolve(args["out-dir"]) : path.resolve(process.env.VIDEO_OUTPUT_DIR ?? defaultOutputDir());
    screenshotLimit = Number(args.screenshots ?? process.env.SCREENSHOT_LIMIT ?? 0);
    engine = (typeof args.engine === "string" ? args.engine : process.env.VIDEO_RENDER_ENGINE ?? "html-video") as typeof engine;
    qualityProfile = (typeof args["quality-profile"] === "string" ? args["quality-profile"] : process.env.QUALITY_GATE_PROFILE ?? "balanced") as typeof qualityProfile;
    runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${slugify(url, "video")}`;
    runDir = fromRoot("dist", "runs", runId);
    journal = await RunJournalStore.create(runDir, {
      runId,
      url,
      config: { targetSeconds, maxIterations, engine, qualityProfile, runtimeProfile: process.env.SCENE_GEN_PROFILE ?? "custom", outputDir, screenshotLimit },
    });
    startStage = explicitFromStage ?? "ingest";
  }

  try {
    if (!new Set(["remotion", "html-video"]).has(engine)) throw new Error(`Unsupported render engine: ${engine}`);
    if (!new Set(["balanced", "strict", "lenient"]).has(qualityProfile)) throw new Error(`Unsupported quality profile: ${qualityProfile}`);
    process.env.QUALITY_GATE_PROFILE = qualityProfile;
    if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) throw new Error("--seconds must be a positive number.");
    if (!Number.isInteger(screenshotLimit) || screenshotLimit < 0) throw new Error("--screenshots must be a non-negative integer.");
    if (!resumeValue && stageIndex(startStage) > stageIndex("draft")) throw new Error("--from-stage after draft requires --resume <run-id>.");

    const reportDir = path.join(runDir, "quality");
    const generationResultPath = path.join(runDir, "generation-result.json");
    await journal.setArtifacts({ runDir, runJournal: journal.filePath, generationResult: generationResultPath, reportDir });
    const state: AgentState = { iterations: await loadIterations(journal.snapshot().artifacts) };
    const existingManifestPath = journal.snapshot().artifacts.manifestPath;
    if (existingManifestPath && existsSync(existingManifestPath)) {
      state.manifestPath = existingManifestPath;
      state.story = (await readStoryManifest(existingManifestPath))[0];
      if (state.story) state.project = await readProject(state.story.projectPath);
    }
    const videoEvaluationPath = journal.snapshot().artifacts.videoEvaluation;
    if (videoEvaluationPath && existsSync(videoEvaluationPath)) state.video = normalizeStoredQualityEvaluation(await readJson<unknown>(videoEvaluationPath));

    console.log(`\n[harness] run: ${runId}`);
    console.log(`[harness] journal: ${journal.filePath}`);
    console.log(`[harness] start stage: ${startStage}${forceStage ? `, force: ${forceStage}` : ""}`);

    let ingest: IngestStageOutput;
    if (shouldRun("ingest", startStage, forceStage)) {
      const stage = await runStage({
        journal, name: "ingest", attempt: nextAttempt(journal, "ingest"), inputs: { url }, timeoutMs: 30_000, signal,
        task: () => runIngestStage(url),
        describe: (value) => ({ metrics: { feedbackItems: value.feedback.length } }),
      });
      ingest = stage.value;
    } else ingest = await runIngestStage(url);

    const explicitNotes = typeof args.notes === "string" ? args.notes : "";
    let loopNotes = combineNotes([explicitNotes, ingest.feedbackGuidance ? `历史用户反馈，必须避免重复：\n${ingest.feedbackGuidance}` : ""]);
    let ignoreCache = Boolean(args["ignore-cache"]);
    let globalRewriteEscalated = Boolean(journal.snapshot().artifacts.noProgressEscalation);
    let draftPassed = state.iterations.at(-1)?.draft?.passed ?? false;
    let iteration = Math.max(1, (state.iterations.at(-1)?.iteration ?? 0) + (draftPassed ? 0 : 1));

    while ((!draftPassed || shouldRun("draft", startStage, forceStage) || shouldRun("draft-gate", startStage, forceStage)) && iteration <= maxIterations) {
      if (!state.story || shouldRun("draft", startStage, forceStage)) {
        const draftStage = await runStage({
          journal, name: "draft", attempt: nextAttempt(journal, "draft"),
          inputs: { url, targetSeconds, screenshotLimit, loopNotes, ignoreCache }, timeoutMs: Number(process.env.HARNESS_DRAFT_TIMEOUT_MS ?? 330_000), signal,
          task: (stageSignal) => runDraftStage({ url, targetSeconds, outputDir, screenshotLimit, runDir, generationResultPath, notes: loopNotes, ignoreCache, signal: stageSignal }),
          describe: (value) => ({ outputs: { generationResultPath, manifestPath: value.manifestPath, projectPath: value.stories[0].projectPath }, metrics: { cacheHit: value.cacheHit } }),
        });
        state.manifestPath = draftStage.value.manifestPath;
        state.story = draftStage.value.stories[0];
        state.project = await readProject(state.story.projectPath);
        await journal.setArtifacts({ manifestPath: state.manifestPath, projectPath: state.story.projectPath, outputPath: state.story.outputPath });
      }
      if (!state.story || !state.project) throw new Error("Draft stage did not produce a project.");
      const gate = await runStage({
        journal, name: "draft-gate", attempt: nextAttempt(journal, "draft-gate"),
        inputs: { project: state.project, targetSeconds, feedback: ingest.feedbackGuidance }, timeoutMs: Number(process.env.HARNESS_DRAFT_GATE_TIMEOUT_MS ?? 150_000), signal,
        task: (stageSignal) => runDraftGateStage(state.project as VideoProject, targetSeconds, ingest.feedbackGuidance, stageSignal),
        describe: (value) => ({ issues: value.evaluation.issues, metrics: { ...value.evaluation.metrics, passed: value.evaluation.passed }, suggestedAction: value.repairPlan.action, dirtyPlan: value.repairPlan.dirtyPlan }),
      });
      gate.value.evaluation.metrics.projectHash = projectLoopHash(state.project);
      const evaluationPath = path.join(runDir, "evaluations", `iteration-${iteration}-draft.json`);
      await writeJsonAtomic(evaluationPath, gate.value.evaluation);
      await journal.setArtifacts({ [`iteration${iteration}Draft`]: evaluationPath });
      const current = state.iterations.find((item) => item.iteration === iteration) ?? { iteration, draft: gate.value.evaluation };
      current.draft = gate.value.evaluation;
      current.draftProjectHash = String(gate.value.evaluation.metrics.projectHash);
      current.dirtyPlan = current.dirtyPlan
        ? mergeDirtyPlans(current.dirtyPlan, gate.value.repairPlan.dirtyPlan)
        : gate.value.repairPlan.dirtyPlan;
      if (!state.iterations.includes(current)) state.iterations.push(current);
      await finalizePendingAudit(journal, runDir, state.iterations.filter((item) => item.iteration < iteration), "draft", gate.value.evaluation);
      draftPassed = gate.value.evaluation.passed;
      if (draftPassed) break;
      const draftHistory = state.iterations.filter((item) => item.draftProjectHash).map((item) => ({ projectHash: item.draftProjectHash, evaluation: item.draft }));
      if (hasRepeatedNoProgress(draftHistory)) {
        if (!globalRewriteEscalated && iteration < maxIterations) {
          const escalationPath = path.join(runDir, "loop", `iteration-${iteration}-no-progress.json`);
          await writeJsonAtomic(escalationPath, { stage: "draft", iteration, action: "regenerate-draft", reason: "project hash, issue set and score were unchanged for two rounds" });
          await journal.setArtifacts({ noProgressEscalation: escalationPath });
          globalRewriteEscalated = true;
          state.story = undefined;
          state.project = undefined;
          ignoreCache = true;
          loopNotes = combineNotes([loopNotes, "连续两轮项目、问题集合和评分无变化，停止局部修订并执行全局重写。"]);
          iteration += 1;
          startStage = "draft";
          continue;
        }
        throw new Error("Draft loop stopped because two consecutive rounds made no progress.");
      }
      if (iteration >= maxIterations) break;
      if (gate.value.repairPlan.action === "revise-scenes" && gate.value.repairPlan.sceneIndexes.length) {
        const beforeRevision = structuredClone(state.project);
        const revisionResultPath = path.join(runDir, "loop", `iteration-${iteration}-draft-revision-result.json`);
        const revision = await runStage({
          journal, name: "revise", attempt: nextAttempt(journal, "revise"), inputs: gate.value.repairPlan, timeoutMs: 210_000, signal,
          task: (stageSignal) => runRevisionStage({ projectPath: state.story!.projectPath, sceneIndexes: gate.value.repairPlan.sceneIndexes, issues: combineNotes([...gate.value.evaluation.issues.map((issue) => issue.message), ...gate.value.evaluation.revisionNotes]), resultPath: revisionResultPath, signal: stageSignal }),
          describe: () => ({ outputs: { projectPath: state.story!.projectPath }, suggestedAction: "revise-scenes" }),
        });
        state.project = revision.value.project;
        const audit = createLoopAudit({ iteration, stage: "draft", before: beforeRevision, after: state.project, evaluation: gate.value.evaluation, durationMs: revision.result.durationMs, usage: revision.value.usage });
        current.audits = [...(current.audits ?? []), audit];
        await persistLoopAudit(journal, runDir, audit);
      } else if (gate.value.repairPlan.action === "regenerate-draft") {
        state.story = undefined;
        state.project = undefined;
        ignoreCache = true;
        loopNotes = combineNotes([loopNotes, ...gate.value.evaluation.issues.map((issue) => issue.message)]);
      } else throw new Error(`Draft gate requires ${gate.value.repairPlan.action}: ${gate.value.repairPlan.reason}`);
      iteration += 1;
      startStage = state.story ? "draft-gate" : "draft";
    }

    if (!draftPassed || !state.story || !state.project || !state.manifestPath) throw new Error("Draft quality gate failed after all iterations.");
    let audioPassed = state.iterations.at(-1)?.audio?.passed ?? false;
    iteration = Math.max(iteration, state.iterations.at(-1)?.iteration ?? 1);
    let forceAudioSceneIndexes: number[] | undefined;
    let forceAudioRebuild = false;
    let audioCacheSalt: string | undefined;
    let audioRepairReason: string | undefined;
    let audioRemuxRequired = false;
    let audioRetimeRequired = false;
    while ((!audioPassed || shouldRun("synthesize", startStage, forceStage) || shouldRun("audio-gate", startStage, forceStage)) && iteration <= maxIterations) {
      const forcedIndexes = forceAudioSceneIndexes;
      const forcedRebuild = forceAudioRebuild;
      const previousSceneDurations = state.project.scenes.map((scene) => scene.duration);
      const synth: { value: VideoProject; result: StageResult } = await runStage<VideoProject>({
        journal, name: "synthesize", attempt: nextAttempt(journal, "synthesize"), inputs: { project: state.project, targetSeconds, forceAudioRebuild: forcedRebuild, forceSceneIndexes: forcedIndexes, cacheSalt: audioCacheSalt, reason: audioRepairReason }, timeoutMs: Number(process.env.HARNESS_SYNTHESIZE_TIMEOUT_MS ?? 930_000), signal,
        task: (stageSignal) => runSynthesizeStage({ projectPath: state.story!.projectPath, basename: narrationBasename(runId, state.project!), targetSeconds, forceAudioRebuild: forcedRebuild, forceSceneIndexes: forcedIndexes, cacheSalt: audioCacheSalt, reason: audioRepairReason, signal: stageSignal }),
        describe: (value) => ({
          outputs: { projectPath: state.story!.projectPath, audio: value.audio?.src ?? "" },
          metrics: {
            duration: value.audio?.durationSeconds ?? 0,
            ...(value.audio?.metrics ?? {}),
            alignedCueCount: value.narrationSegments?.reduce((sum, segment) => sum + (segment.speechAlignment?.phrases.length ?? 0), 0) ?? 0,
            alignedSceneCount: value.narrationSegments?.filter((segment) => segment.speechAlignment?.status === "forced").length ?? 0,
            alignmentFailedSceneCount: value.narrationSegments?.filter((segment) => segment.speechAlignment?.status === "failed").length ?? 0,
          },
        }),
      });
      state.project = synth.value;
      if (forcedRebuild) {
        const generatedIndexes = String(state.project.audio?.metrics?.generatedAudioSceneIndexes ?? "").split(",").filter(Boolean).map(Number);
        if (generatedIndexes.length === 0) throw new Error("resynthesize-audio did not rebuild any narration segment.");
        audioRemuxRequired = true;
        audioRetimeRequired ||= state.project.scenes.some((scene, index) => Math.abs(scene.duration - previousSceneDurations[index]) > 0.001);
      }
      forceAudioSceneIndexes = undefined;
      forceAudioRebuild = false;
      audioCacheSalt = undefined;
      audioRepairReason = undefined;
      const gate: { value: GateStageOutput; result: StageResult } = await runStage<GateStageOutput>({
        journal, name: "audio-gate", attempt: nextAttempt(journal, "audio-gate"), inputs: { project: state.project, targetSeconds }, timeoutMs: Number(process.env.HARNESS_AUDIO_GATE_TIMEOUT_MS ?? 360_000), signal,
        task: (stageSignal) => runAudioGateStage(state.project as VideoProject, targetSeconds, stageSignal),
        describe: (value) => ({ issues: value.evaluation.issues, metrics: { ...value.evaluation.metrics, passed: value.evaluation.passed }, suggestedAction: value.repairPlan.action, dirtyPlan: value.repairPlan.dirtyPlan }),
      });
      gate.value.evaluation.metrics.projectHash = audioLoopHash(state.project, state.project.audio?.metrics?.audioGenerationKey);
      const evaluationPath = path.join(runDir, "evaluations", `iteration-${iteration}-audio.json`);
      await writeJsonAtomic(evaluationPath, gate.value.evaluation);
      await journal.setArtifacts({ [`iteration${iteration}Audio`]: evaluationPath });
      const current = state.iterations.find((item) => item.iteration === iteration) ?? { iteration, draft: state.iterations.at(-1)!.draft };
      current.audio = gate.value.evaluation;
      current.audioProjectHash = String(gate.value.evaluation.metrics.projectHash);
      current.dirtyPlan = current.dirtyPlan
        ? mergeDirtyPlans(current.dirtyPlan, gate.value.repairPlan.dirtyPlan)
        : gate.value.repairPlan.dirtyPlan;
      if (!state.iterations.includes(current)) state.iterations.push(current);
      await finalizePendingAudit(journal, runDir, state.iterations.filter((item) => item.iteration < iteration), "audio", gate.value.evaluation);
      audioPassed = gate.value.evaluation.passed;
      if (audioPassed) break;
      const audioHistory = state.iterations.filter((item) => item.audio && item.audioProjectHash).map((item) => ({ projectHash: item.audioProjectHash, evaluation: item.audio! }));
      if (hasRepeatedNoProgress(audioHistory)) throw new Error("Audio loop stopped because two consecutive rounds made no progress.");
      if (iteration >= maxIterations) break;
      if (gate.value.repairPlan.action === "revise-scenes" && gate.value.repairPlan.sceneIndexes.length) {
        const beforeRevision = structuredClone(state.project);
        const revisionResultPath = path.join(runDir, "loop", `iteration-${iteration}-audio-revision-result.json`);
        const revision = await runStage({
          journal, name: "revise", attempt: nextAttempt(journal, "revise"), inputs: gate.value.repairPlan, timeoutMs: 210_000, signal,
          task: (stageSignal) => runRevisionStage({ projectPath: state.story!.projectPath, sceneIndexes: gate.value.repairPlan.sceneIndexes, issues: combineNotes([...gate.value.evaluation.issues.map((issue: QualityIssue) => issue.message), ...gate.value.evaluation.revisionNotes]), resultPath: revisionResultPath, signal: stageSignal }),
          describe: () => ({ outputs: { projectPath: state.story!.projectPath }, suggestedAction: "revise-scenes" }),
        });
        state.project = revision.value.project;
        const audit = createLoopAudit({ iteration, stage: "audio", before: beforeRevision, after: state.project, evaluation: gate.value.evaluation, durationMs: revision.result.durationMs, usage: revision.value.usage });
        current.audits = [...(current.audits ?? []), audit];
        await persistLoopAudit(journal, runDir, audit);
      } else if (gate.value.repairPlan.action === "resynthesize-audio") {
        forceAudioRebuild = true;
        forceAudioSceneIndexes = gate.value.repairPlan.audioSceneIndexes.length
          ? gate.value.repairPlan.audioSceneIndexes
          : state.project.scenes.map((_, index) => index);
        audioRepairReason = gate.value.repairPlan.reason;
        audioCacheSalt = `audio:${gate.value.repairPlan.reason}:${forceAudioSceneIndexes.join(",") || "all"}`;
      } else {
        throw new Error(`Audio gate requires ${gate.value.repairPlan.action}: ${gate.value.repairPlan.reason}`);
      }
      iteration += 1;
      startStage = "synthesize";
    }

    if (!audioPassed) throw new Error("Audio quality gate failed after all iterations.");
    const videoIterations = Math.max(1, Math.min(3, Number(args["video-iterations"] ?? process.env.HARNESS_VIDEO_ITERATIONS ?? 2)));
    let forceRender = forceStage === "render";
    let forceSceneIndexes: number[] | undefined;
    const silentVideoPath = state.story.htmlVideoGraphPath ? path.join(path.dirname(state.story.htmlVideoGraphPath), "video-no-audio.mp4") : "";
    let remuxOnly = audioRemuxRequired && !audioRetimeRequired && engine === "html-video" && Boolean(silentVideoPath) && existsSync(silentVideoPath);
    let pendingMuxRequired = audioRemuxRequired;
    let remuxedVideo = false;
    let lastRenderMetrics: Record<string, string | number | boolean> = {};
    if (shouldRun("video-gate", startStage, forceStage) || !state.video) {
      for (let videoAttempt = 1; videoAttempt <= videoIterations; videoAttempt += 1) {
        const renderNeeded = remuxOnly || videoAttempt > 1 || shouldRun("render", startStage, forceStage) || !existsSync(state.story.outputPath);
        if (renderNeeded) {
          const renderAttempt = nextAttempt(journal, "render");
          const renderResultPath = path.join(runDir, "render", `attempt-${renderAttempt}.json`);
          const render = await runStage({
            journal, name: "render", attempt: renderAttempt, inputs: { manifestPath: state.manifestPath, engine, forceRender, forceSceneIndexes, remuxOnly, remuxRequired: pendingMuxRequired }, timeoutMs: Number(process.env.HARNESS_RENDER_TIMEOUT_MS ?? 1_830_000), signal,
            task: (stageSignal) => runRenderStage({ manifestPath: state.manifestPath!, engine, forceRender, forceSceneIndexes, remuxOnly, remuxRequired: pendingMuxRequired, resultPath: renderResultPath, signal: stageSignal }),
            describe: (value) => {
              const renderMetrics = value.metrics ?? {};
              const scalarMetrics = {
                forceRender,
                forcedSceneCount: forceSceneIndexes?.length ?? 0,
                remuxedVideo: value.remuxedVideo,
                remuxOnly: value.remuxOnly,
                browserStartupMs: Number(renderMetrics.browserStartupMs ?? 0),
                renderConcurrency: Number(renderMetrics.renderConcurrency ?? 0),
                cacheHitScenes: JSON.stringify(renderMetrics.cacheHitScenes ?? []),
                renderedScenes: JSON.stringify(renderMetrics.renderedScenes ?? []),
                perSceneRecordMs: JSON.stringify(renderMetrics.perSceneRecordMs ?? {}),
                perSceneEncodeMs: JSON.stringify(renderMetrics.perSceneEncodeMs ?? {}),
                concatMs: Number(renderMetrics.concatMs ?? 0),
                muxMs: Number(renderMetrics.muxMs ?? 0),
                totalRenderMs: Number(renderMetrics.totalRenderMs ?? 0),
              };
              lastRenderMetrics = scalarMetrics;
              return { outputs: { outputPath: state.story!.outputPath, renderResultPath }, metrics: scalarMetrics };
            },
          });
          remuxedVideo ||= render.value.remuxedVideo;
          remuxOnly = false;
          audioRemuxRequired = false;
          pendingMuxRequired = false;
        }
        const gate = await runStage({
          journal, name: "video-gate", attempt: nextAttempt(journal, "video-gate"), inputs: { outputPath: state.story.outputPath, project: state.project }, timeoutMs: Number(process.env.HARNESS_VIDEO_GATE_TIMEOUT_MS ?? 480_000), signal,
          task: (stageSignal) => runVideoGateStage({ story: state.story!, project: state.project!, reportDir, signal: stageSignal, repairAttempt: videoAttempt }),
          describe: (value) => ({ issues: value.evaluation.issues, metrics: { ...value.evaluation.metrics, passed: value.evaluation.passed }, suggestedAction: value.repairPlan.action, dirtyPlan: value.repairPlan.dirtyPlan }),
        });
        gate.value.evaluation.metrics.remuxedVideo = remuxedVideo;
        Object.assign(gate.value.evaluation.metrics, lastRenderMetrics);
        state.video = gate.value.evaluation;
        const evaluationPath = path.join(runDir, "evaluations", `video-attempt-${videoAttempt}.json`);
        await writeJsonAtomic(evaluationPath, state.video);
        await journal.setArtifacts({ videoEvaluation: evaluationPath });
        if (state.video.passed) break;
        if (!gate.value.repairPlan.retryable || videoAttempt === videoIterations) break;
        forceSceneIndexes = gate.value.repairPlan.videoSceneIndexes.length ? gate.value.repairPlan.videoSceneIndexes : undefined;
        forceRender = gate.value.repairPlan.forceVideoRebuild && !forceSceneIndexes?.length;
        pendingMuxRequired = gate.value.repairPlan.muxRequired;
        remuxOnly = pendingMuxRequired && engine === "html-video" && Boolean(silentVideoPath) && existsSync(silentVideoPath);
      }
    }

    if (!state.video) throw new Error("Video gate did not produce an evaluation.");
    const publish = await runStage({
      journal, name: "publish", attempt: nextAttempt(journal, "publish"), inputs: { iterations: state.iterations, video: state.video }, timeoutMs: 60_000, signal,
      task: () => runPublishStage({ runId, journalPath: journal.filePath, url, story: state.story!, project: state.project!, manifestPath: state.manifestPath!, targetSeconds, maxIterations, engine, feedback: ingest.feedback, iterations: state.iterations, video: state.video!, reportDir }),
      describe: (value) => ({ outputs: { reportPath: value.reportPath, markdownPath: value.markdownPath, productionReportPath: value.productionReportPath, templateOutcomeFile: value.templateLearning.filePath }, metrics: { passed: value.passed, templateOutcomesRecorded: value.templateLearning.recorded, providerOutcomesRecorded: value.providerHistory.recorded } }),
    });
    await journal.setArtifacts({ qualityReport: publish.value.reportPath, qualityReportMarkdown: publish.value.markdownPath, productionReport: publish.value.productionReportPath });
    if (publish.value.passed) await journal.succeed();
    else await journal.fail(new Error("Final video quality gate failed."));
    return { runId, runDir, outputPath: state.story.outputPath, passed: publish.value.passed };
  } catch (error) {
    await journal.fail(error);
    throw error;
  }
}
