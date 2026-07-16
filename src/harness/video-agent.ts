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
import { audioLoopHash, createLoopAudit, evaluationScore, finalizeLoopAudit, hasRepeatedNoProgress, projectLoopHash, type LoopAudit } from "./loop-engineering";
import { normalizeStoredQualityEvaluation } from "./quality-protocol";
import { mergeDirtyPlans } from "./dirty-plan";
import {
  calculateLoopBudgetUsage,
  evaluateLoopBudget,
  finalizePendingStrategies,
  issueEvidenceSignature,
  resolveLoopBudgetLimits,
  selectNextLoopStrategy,
  type LoopStrategyTrace,
} from "./loop-governance";
import { readHtmlVideoContentGraphFile } from "../html-video/content-graph";
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
import { buildRuntimeConfig, runWithRuntimeConfig, runtimeConfigHash, runtimeConfigSnapshot, runtimeConfigWithRunOverrides, type RuntimeConfig } from "../config/runtime-config";
import { finalizePendingAudit, loadIterations, nextAttempt, persistLoopAudit, persistStrategyTrajectory, resolveRunDir, resumeStage, shouldRun, type AgentState } from "./agent/loop-support";
import { initialDraftLoopState, shouldContinueDraftLoop } from "./agent/draft-loop";
import { generatedAudioSceneIndexes } from "./agent/audio-loop";
import { addTemplateExclusions, affectedVideoScenes } from "./agent/video-loop";
import { publishAgentRun } from "./agent/publish";


async function runVideoAgentInternal(argv: string[], signal: AbortSignal | undefined, runtimeConfig: RuntimeConfig) {
  const args = parseArgs(argv);
  const resumeValue = typeof args.resume === "string" ? args.resume : undefined;
  const overrideConfig = Boolean(args["override-config"]);
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
    const forbiddenOverrides = ["seconds", "iterations", "video-iterations", "screenshots", "engine", "out-dir", "quality-profile"]
      .filter((key) => Object.hasOwn(args, key));
    if (!overrideConfig && forbiddenOverrides.length > 0) throw new Error("Resume uses the original runtime config. Add --override-config to change: " + forbiddenOverrides.join(", "));
    runDir = resolveRunDir(resumeValue);
    journal = await RunJournalStore.open(runDir);
    const snapshot = journal.snapshot();
    if (snapshot.config.runtimeConfigHash && !overrideConfig && snapshot.config.runtimeConfigHash !== runtimeConfigHash(runtimeConfig)) {
      throw new Error("Runtime config hash differs from the original run. Resume without overrides must restore run.config.runtimeConfig.");
    }
    if (overrideConfig || !snapshot.config.runtimeConfigHash) await journal.setRuntimeConfig(runtimeConfigSnapshot(runtimeConfig), runtimeConfigHash(runtimeConfig));
    runId = snapshot.runId;
    url = typeof args.url === "string" ? args.url : snapshot.url;
    targetSeconds = typeof args.seconds === "string" ? Number(args.seconds) : snapshot.config.targetSeconds;
    maxIterations = typeof args.iterations === "string" ? Math.max(1, Math.min(8, Number(args.iterations))) : snapshot.config.maxIterations;
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
    maxIterations = Math.max(1, Math.min(8, Number(args.iterations ?? runtimeConfig.retry.maxIterations)));
    outputDir = typeof args["out-dir"] === "string" ? path.resolve(args["out-dir"]) : runtimeConfig.rendering.outputDir;
    screenshotLimit = Number(args.screenshots ?? runtimeConfig.rendering.screenshotLimit);
    engine = (typeof args.engine === "string" ? args.engine : runtimeConfig.rendering.engine) as typeof engine;
    qualityProfile = (typeof args["quality-profile"] === "string" ? args["quality-profile"] : runtimeConfig.quality.profile) as typeof qualityProfile;
    runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${slugify(url, "video")}`;
    runDir = fromRoot("dist", "runs", runId);
    journal = await RunJournalStore.create(runDir, {
      runId,
      url,
      config: { targetSeconds, maxIterations, engine, qualityProfile, runtimeProfile: runtimeConfig.profile, outputDir, screenshotLimit, runtimeConfig: runtimeConfigSnapshot(runtimeConfig), runtimeConfigHash: runtimeConfigHash(runtimeConfig) },
    });
    startStage = explicitFromStage ?? "ingest";
  }

  try {
    if (!new Set(["remotion", "html-video"]).has(engine)) throw new Error(`Unsupported render engine: ${engine}`);
    if (!new Set(["balanced", "strict", "lenient"]).has(qualityProfile)) throw new Error(`Unsupported quality profile: ${qualityProfile}`);
    if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) throw new Error("--seconds must be a positive number.");
    if (!Number.isInteger(screenshotLimit) || screenshotLimit < 0) throw new Error("--screenshots must be a non-negative integer.");
    if (!resumeValue && stageIndex(startStage) > stageIndex("draft")) throw new Error("--from-stage after draft requires --resume <run-id>.");

    const reportDir = path.join(runDir, "quality");
    const generationResultPath = path.join(runDir, "generation-result.json");
    await journal.setArtifacts({ runDir, runJournal: journal.filePath, generationResult: generationResultPath, reportDir });
    const state: AgentState = { iterations: await loadIterations(journal.snapshot().artifacts) };
    const strategyArtifact = journal.snapshot().artifacts.strategyTrajectory;
    let strategyTrajectory = strategyArtifact && existsSync(strategyArtifact)
      ? (await readJson<{ entries?: LoopStrategyTrace[] }>(strategyArtifact).catch(() => ({ entries: [] }))).entries ?? []
      : [];
    const budgetLimits = resolveLoopBudgetLimits(args);
    const enforceBudget = async (issues: QualityIssue[]) => {
      const audits = state.iterations.flatMap((item) => item.audits ?? []);
      const status = evaluateLoopBudget(budgetLimits, calculateLoopBudgetUsage(journal.snapshot(), audits), issues);
      const budgetPath = path.join(runDir, "loop", "budget-status.json");
      await writeJsonAtomic(budgetPath, { updatedAt: new Date().toISOString(), ...status });
      await journal.setArtifacts({ loopBudget: budgetPath });
      if (!status.allowed) throw new Error(`Loop budget requires human confirmation: ${status.exceeded.join(", ")}`);
      return status;
    };
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
    let draftStrategy: LoopStrategyTrace | undefined;
    let { draftPassed, iteration } = initialDraftLoopState(state.iterations);

    while (shouldContinueDraftLoop({ draftPassed, draftStageRequested: shouldRun("draft", startStage, forceStage), draftGateRequested: shouldRun("draft-gate", startStage, forceStage), iteration, maxIterations })) {
      if (!state.story || shouldRun("draft", startStage, forceStage)) {
        const draftStage = await runStage({
          journal, name: "draft", attempt: nextAttempt(journal, "draft"),
          inputs: { url, targetSeconds, screenshotLimit, loopNotes, ignoreCache }, timeoutMs: runtimeConfig.retry.stageTimeoutMs.draft, signal,
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
        inputs: { project: state.project, targetSeconds, feedback: ingest.feedbackGuidance }, timeoutMs: runtimeConfig.retry.stageTimeoutMs.draftGate, signal,
        task: (stageSignal) => runDraftGateStage(state.project as VideoProject, targetSeconds, ingest.feedbackGuidance, stageSignal),
        describe: (value) => ({ issues: value.evaluation.issues, metrics: { ...value.evaluation.metrics, passed: value.evaluation.passed }, suggestedAction: value.repairPlan.action, dirtyPlan: value.repairPlan.dirtyPlan, repairCandidates: value.repairPlan.candidates, repairDecision: value.repairPlan.decision }),
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
      strategyTrajectory = finalizePendingStrategies(strategyTrajectory, "draft", gate.value.evaluation);
      await persistStrategyTrajectory(journal, runDir, strategyTrajectory);
      draftPassed = gate.value.evaluation.passed;
      if (draftPassed) break;
      const draftHistory = state.iterations.filter((item) => item.draftProjectHash).map((item) => ({ projectHash: item.draftProjectHash, evaluation: item.draft }));
      let strategyHandlesNoProgress = false;
      if (hasRepeatedNoProgress(draftHistory)) {
        draftStrategy = selectNextLoopStrategy({
          stage: "draft", iteration, issues: gate.value.evaluation.issues, repairAction: gate.value.repairPlan.action,
          affectedScenes: gate.value.repairPlan.sceneIndexes, trajectory: strategyTrajectory,
          fallbackProviderId: runtimeConfig.llm.revisionFallbackModel,
          scoreBefore: evaluationScore(gate.value.evaluation),
        });
        strategyTrajectory.push(draftStrategy);
        await persistStrategyTrajectory(journal, runDir, strategyTrajectory);
        strategyHandlesNoProgress = !["global-replan", "human-review"].includes(draftStrategy.strategyId);
        if (draftStrategy.strategyId === "human-review") globalRewriteEscalated = true;
      }
      if (hasRepeatedNoProgress(draftHistory) && !strategyHandlesNoProgress) {
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
      await enforceBudget(gate.value.evaluation.issues);
      if (gate.value.repairPlan.action === "revise-scenes" && gate.value.repairPlan.sceneIndexes.length) {
        const beforeRevision = structuredClone(state.project);
        const revisionResultPath = path.join(runDir, "loop", `iteration-${iteration}-draft-revision-result.json`);
        const revisionSceneIndexes = draftStrategy?.strategyId === "widen-dirty-scope"
          ? state.project.scenes.map((_, index) => index)
          : gate.value.repairPlan.sceneIndexes;
        const revision = await runStage({
          journal, name: "revise", attempt: nextAttempt(journal, "revise"), inputs: { repairPlan: gate.value.repairPlan, strategy: draftStrategy }, timeoutMs: 210_000, signal,
          task: (stageSignal) => runRevisionStage({ projectPath: state.story!.projectPath, sceneIndexes: revisionSceneIndexes, issues: combineNotes([...gate.value.evaluation.issues.map((issue) => `${issue.message}\nevidence=${JSON.stringify(issue.evidence)}`), ...gate.value.evaluation.revisionNotes]), promptStrategy: draftStrategy?.promptStrategy, providerStrategy: draftStrategy?.providerStrategy, resultPath: revisionResultPath, signal: stageSignal }),
          describe: () => ({ outputs: { projectPath: state.story!.projectPath }, suggestedAction: "revise-scenes" }),
        });
        state.project = revision.value.project;
        const audit = createLoopAudit({ iteration, stage: "draft", before: beforeRevision, after: state.project, evaluation: gate.value.evaluation, durationMs: revision.result.durationMs, usage: revision.value.usage });
        current.audits = [...(current.audits ?? []), audit];
        await persistLoopAudit(journal, runDir, audit);
        draftStrategy = undefined;
      } else if (gate.value.repairPlan.action === "regenerate-draft") {
        state.story = undefined;
        state.project = undefined;
        ignoreCache = true;
        loopNotes = combineNotes([
          loopNotes,
          `strategy=${draftStrategy?.strategyId ?? "default"}; prompt=${draftStrategy?.promptStrategy ?? "default"}`,
          ...gate.value.evaluation.issues.map((issue) => `${issue.message}\nevidence=${JSON.stringify(issue.evidence)}`),
        ]);
        draftStrategy = undefined;
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
    let audioProviderOverride: "openai" | "f5" | "local" | undefined;
    let audioStrategy: LoopStrategyTrace | undefined;
    let audioRemuxRequired = false;
    let audioRetimeRequired = false;
    while ((!audioPassed || shouldRun("synthesize", startStage, forceStage) || shouldRun("audio-gate", startStage, forceStage)) && iteration <= maxIterations) {
      await enforceBudget(state.iterations.at(-1)?.audio?.issues ?? []);
      const forcedIndexes = forceAudioSceneIndexes;
      const forcedRebuild = forceAudioRebuild;
      const previousSceneDurations = state.project.scenes.map((scene) => scene.duration);
      const synth: { value: VideoProject; result: StageResult } = await runStage<VideoProject>({
        journal, name: "synthesize", attempt: nextAttempt(journal, "synthesize"), inputs: { project: state.project, targetSeconds, forceAudioRebuild: forcedRebuild, forceSceneIndexes: forcedIndexes, cacheSalt: audioCacheSalt, reason: audioRepairReason, provider: audioProviderOverride, strategy: audioStrategy }, timeoutMs: runtimeConfig.retry.stageTimeoutMs.synthesize, signal,
        task: (stageSignal) => runSynthesizeStage({ projectPath: state.story!.projectPath, basename: narrationBasename(runId, state.project!), targetSeconds, forceAudioRebuild: forcedRebuild, forceSceneIndexes: forcedIndexes, cacheSalt: audioCacheSalt, reason: audioRepairReason, provider: audioProviderOverride, signal: stageSignal }),
        describe: (value) => ({
          outputs: { projectPath: state.story!.projectPath, audio: value.audio?.src ?? "" },
          metrics: {
            duration: value.audio?.durationSeconds ?? 0,
            forcedAudioRebuild: forcedRebuild,
            ...(value.audio?.metrics ?? {}),
            alignedCueCount: value.narrationSegments?.reduce((sum, segment) => sum + (segment.speechAlignment?.phrases.length ?? 0), 0) ?? 0,
            alignedSceneCount: value.narrationSegments?.filter((segment) => segment.speechAlignment?.status === "forced").length ?? 0,
            alignmentFailedSceneCount: value.narrationSegments?.filter((segment) => segment.speechAlignment?.status === "failed").length ?? 0,
          },
        }),
      });
      state.project = synth.value;
      if (forcedRebuild) {
        const generatedIndexes = generatedAudioSceneIndexes(state.project.audio?.metrics?.generatedAudioSceneIndexes);
        if (generatedIndexes.length === 0) throw new Error("resynthesize-audio did not rebuild any narration segment.");
        audioRemuxRequired = true;
        audioRetimeRequired ||= state.project.scenes.some((scene, index) => Math.abs(scene.duration - previousSceneDurations[index]) > 0.001);
      }
      forceAudioSceneIndexes = undefined;
      forceAudioRebuild = false;
      audioCacheSalt = undefined;
      audioRepairReason = undefined;
      audioProviderOverride = undefined;
      const gate: { value: GateStageOutput; result: StageResult } = await runStage<GateStageOutput>({
        journal, name: "audio-gate", attempt: nextAttempt(journal, "audio-gate"), inputs: { project: state.project, targetSeconds }, timeoutMs: runtimeConfig.retry.stageTimeoutMs.audioGate, signal,
        task: (stageSignal) => runAudioGateStage(state.project as VideoProject, targetSeconds, stageSignal),
        describe: (value) => ({ issues: value.evaluation.issues, metrics: { ...value.evaluation.metrics, passed: value.evaluation.passed }, suggestedAction: value.repairPlan.action, dirtyPlan: value.repairPlan.dirtyPlan, repairCandidates: value.repairPlan.candidates, repairDecision: value.repairPlan.decision }),
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
      strategyTrajectory = finalizePendingStrategies(strategyTrajectory, "audio", gate.value.evaluation);
      await persistStrategyTrajectory(journal, runDir, strategyTrajectory);
      audioPassed = gate.value.evaluation.passed;
      if (audioPassed) break;
      const audioHistory = state.iterations.filter((item) => item.audio && item.audioProjectHash).map((item) => ({ projectHash: item.audioProjectHash, evaluation: item.audio! }));
      if (hasRepeatedNoProgress(audioHistory)) {
        const fallback = runtimeConfig.tts.providerFallback;
        audioStrategy = selectNextLoopStrategy({
          stage: "audio", iteration, issues: gate.value.evaluation.issues, repairAction: gate.value.repairPlan.action,
          affectedScenes: gate.value.repairPlan.audioSceneIndexes, trajectory: strategyTrajectory,
          fallbackProviderId: fallback === "openai" || fallback === "f5" || fallback === "local" ? fallback : undefined,
          scoreBefore: evaluationScore(gate.value.evaluation),
        });
        strategyTrajectory.push(audioStrategy);
        await persistStrategyTrajectory(journal, runDir, strategyTrajectory);
        if (audioStrategy.strategyId === "human-review") throw new Error("Audio loop requires human confirmation after exhausting repair strategies.");
        if (audioStrategy.strategyId === "alternate-provider" && (audioStrategy.providerId === "openai" || audioStrategy.providerId === "f5" || audioStrategy.providerId === "local")) audioProviderOverride = audioStrategy.providerId;
      }
      if (iteration >= maxIterations) break;
      if (gate.value.repairPlan.action === "revise-scenes" && gate.value.repairPlan.sceneIndexes.length) {
        const beforeRevision = structuredClone(state.project);
        const revisionResultPath = path.join(runDir, "loop", `iteration-${iteration}-audio-revision-result.json`);
        const revision = await runStage({
          journal, name: "revise", attempt: nextAttempt(journal, "revise"), inputs: gate.value.repairPlan, timeoutMs: 210_000, signal,
          task: (stageSignal) => runRevisionStage({ projectPath: state.story!.projectPath, sceneIndexes: audioStrategy?.strategyId === "widen-dirty-scope" ? state.project!.scenes.map((_, index) => index) : gate.value.repairPlan.sceneIndexes, issues: combineNotes([...gate.value.evaluation.issues.map((issue: QualityIssue) => `${issue.message}\nevidence=${JSON.stringify(issue.evidence)}`), ...gate.value.evaluation.revisionNotes]), promptStrategy: audioStrategy?.promptStrategy, providerStrategy: audioStrategy?.providerStrategy, resultPath: revisionResultPath, signal: stageSignal }),
          describe: () => ({ outputs: { projectPath: state.story!.projectPath }, suggestedAction: "revise-scenes" }),
        });
        state.project = revision.value.project;
        const audit = createLoopAudit({ iteration, stage: "audio", before: beforeRevision, after: state.project, evaluation: gate.value.evaluation, durationMs: revision.result.durationMs, usage: revision.value.usage });
        current.audits = [...(current.audits ?? []), audit];
        await persistLoopAudit(journal, runDir, audit);
      } else if (gate.value.repairPlan.action === "resynthesize-audio") {
        forceAudioRebuild = true;
        forceAudioSceneIndexes = audioStrategy?.strategyId === "widen-dirty-scope"
          ? state.project.scenes.map((_, index) => index)
          : gate.value.repairPlan.audioSceneIndexes.length
          ? gate.value.repairPlan.audioSceneIndexes
          : state.project.scenes.map((_, index) => index);
        audioRepairReason = `${gate.value.repairPlan.reason}; strategy=${audioStrategy?.strategyId ?? "default"}`;
        audioCacheSalt = `audio:${audioRepairReason}:${forceAudioSceneIndexes.join(",") || "all"}`;
      } else {
        throw new Error(`Audio gate requires ${gate.value.repairPlan.action}: ${gate.value.repairPlan.reason}`);
      }
      iteration += 1;
      startStage = "synthesize";
    }

    if (!audioPassed) throw new Error("Audio quality gate failed after all iterations.");
    const videoIterations = Math.max(1, Math.min(3, Number(args["video-iterations"] ?? runtimeConfig.retry.videoIterations)));
    const templateExclusions = structuredClone(runtimeConfig.rendering.htmlTemplateExclusions) as Record<string, string[]>;
    let forceRender = forceStage === "render";
    let forceSceneIndexes: number[] | undefined;
    const silentVideoPath = state.story.htmlVideoGraphPath ? path.join(path.dirname(state.story.htmlVideoGraphPath), "video-no-audio.mp4") : "";
    let remuxOnly = audioRemuxRequired && !audioRetimeRequired && engine === "html-video" && Boolean(silentVideoPath) && existsSync(silentVideoPath);
    let pendingMuxRequired = audioRemuxRequired;
    let remuxedVideo = false;
    let lastRenderMetrics: Record<string, string | number | boolean> = {};
    const videoEvidenceHistory: string[] = [];
    if (shouldRun("video-gate", startStage, forceStage) || !state.video) {
      for (let videoAttempt = 1; videoAttempt <= videoIterations; videoAttempt += 1) {
        const renderNeeded = remuxOnly || videoAttempt > 1 || shouldRun("render", startStage, forceStage) || !existsSync(state.story.outputPath);
        if (renderNeeded) {
          await enforceBudget(state.video?.issues ?? []);
          const renderAttempt = nextAttempt(journal, "render");
          const renderResultPath = path.join(runDir, "render", `attempt-${renderAttempt}.json`);
          const render = await runStage({
            journal, name: "render", attempt: renderAttempt, inputs: { manifestPath: state.manifestPath, engine, forceRender, forceSceneIndexes, remuxOnly, remuxRequired: pendingMuxRequired }, timeoutMs: runtimeConfig.retry.stageTimeoutMs.render, signal,
            task: (stageSignal) => runRenderStage({ manifestPath: state.manifestPath!, engine, forceRender, forceSceneIndexes, remuxOnly, remuxRequired: pendingMuxRequired, resultPath: renderResultPath, templateExclusions, signal: stageSignal }),
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
          journal, name: "video-gate", attempt: nextAttempt(journal, "video-gate"), inputs: { outputPath: state.story.outputPath, project: state.project }, timeoutMs: runtimeConfig.retry.stageTimeoutMs.videoGate, signal,
          task: (stageSignal) => runVideoGateStage({ story: state.story!, project: state.project!, reportDir, signal: stageSignal, repairAttempt: videoAttempt }),
          describe: (value) => ({ issues: value.evaluation.issues, metrics: { ...value.evaluation.metrics, passed: value.evaluation.passed }, suggestedAction: value.repairPlan.action, dirtyPlan: value.repairPlan.dirtyPlan, repairCandidates: value.repairPlan.candidates, repairDecision: value.repairPlan.decision }),
        });
        gate.value.evaluation.metrics.remuxedVideo = remuxedVideo;
        Object.assign(gate.value.evaluation.metrics, lastRenderMetrics);
        state.video = gate.value.evaluation;
        const evaluationPath = path.join(runDir, "evaluations", `video-attempt-${videoAttempt}.json`);
        await writeJsonAtomic(evaluationPath, state.video);
        await journal.setArtifacts({ videoEvaluation: evaluationPath });
        strategyTrajectory = finalizePendingStrategies(strategyTrajectory, "video", gate.value.evaluation);
        await persistStrategyTrajectory(journal, runDir, strategyTrajectory);
        videoEvidenceHistory.push(issueEvidenceSignature(gate.value.evaluation.issues));
        if (state.video.passed) break;
        const repeatedVideoNoProgress = videoEvidenceHistory.length >= 2 && videoEvidenceHistory.at(-1) === videoEvidenceHistory.at(-2);
        if (repeatedVideoNoProgress) {
          const affectedScenes = affectedVideoScenes(gate.value.repairPlan.videoSceneIndexes, gate.value.evaluation.issues);
          const graph = state.story.htmlVideoGraphPath && existsSync(state.story.htmlVideoGraphPath)
            ? await readHtmlVideoContentGraphFile(state.story.htmlVideoGraphPath).then((result) => result.value).catch(() => undefined)
            : undefined;
          const templateSelections = graph?.nodes.filter((node) => !affectedScenes.length || affectedScenes.includes(node.sceneIndex)).map((node) => ({ sceneIndex: node.sceneIndex, templateId: node.templateId, variantId: node.variantId })) ?? [];
          const strategy = selectNextLoopStrategy({ stage: "video", iteration: videoAttempt, issues: gate.value.evaluation.issues, repairAction: gate.value.repairPlan.action, affectedScenes, trajectory: strategyTrajectory, templateSelections, scoreBefore: evaluationScore(gate.value.evaluation) });
          strategyTrajectory.push(strategy);
          await persistStrategyTrajectory(journal, runDir, strategyTrajectory);
          if (strategy.strategyId === "human-review") break;
          if (strategy.strategyId === "alternate-template-variant") {
            addTemplateExclusions(templateExclusions, templateSelections);
            forceSceneIndexes = affectedScenes.length ? affectedScenes : state.project.scenes.map((_, index) => index);
            forceRender = false;
            pendingMuxRequired = true;
            remuxOnly = false;
          } else if (strategy.strategyId === "widen-dirty-scope") {
            forceSceneIndexes = state.project.scenes.map((_, index) => index);
            forceRender = false;
            pendingMuxRequired = true;
            remuxOnly = false;
          }
        }
        if (!gate.value.repairPlan.retryable || videoAttempt === videoIterations) break;
        if (!repeatedVideoNoProgress) {
          forceSceneIndexes = gate.value.repairPlan.videoSceneIndexes.length ? gate.value.repairPlan.videoSceneIndexes : undefined;
          forceRender = gate.value.repairPlan.forceVideoRebuild && !forceSceneIndexes?.length;
          pendingMuxRequired = gate.value.repairPlan.muxRequired;
          remuxOnly = pendingMuxRequired && engine === "html-video" && Boolean(silentVideoPath) && existsSync(silentVideoPath);
          if (gate.value.repairPlan.action === "reconcat-video") remuxOnly = false;
        }
      }
    }

    if (!state.video) throw new Error("Video gate did not produce an evaluation.");
    const publish = await publishAgentRun({ journal, runId, url, story: state.story, project: state.project, manifestPath: state.manifestPath, targetSeconds, maxIterations, engine, ingest, iterations: state.iterations, video: state.video, reportDir, signal });
    return { runId, runDir, outputPath: state.story.outputPath, passed: publish.passed };
  } catch (error) {
    await journal.fail(error);
    throw error;
  }
}

export async function runVideoAgent(argv: string[], signal?: AbortSignal, providedConfig?: RuntimeConfig) {
  loadDotEnv();
  const args = parseArgs(argv);
  const baseConfig = providedConfig ?? buildRuntimeConfig();
  const mayOverride = !args.resume || Boolean(args["override-config"]);
  const effectiveConfig = mayOverride ? runtimeConfigWithRunOverrides(baseConfig, {
    engine: typeof args.engine === "string" ? args.engine as "remotion" | "html-video" : undefined,
    outputDir: typeof args["out-dir"] === "string" ? args["out-dir"] : undefined,
    screenshotLimit: typeof args.screenshots === "string" ? Number(args.screenshots) : undefined,
    qualityProfile: typeof args["quality-profile"] === "string" ? args["quality-profile"] as "balanced" | "strict" | "lenient" : undefined,
    maxIterations: typeof args.iterations === "string" ? Math.max(1, Math.min(8, Number(args.iterations))) : undefined,
    videoIterations: typeof args["video-iterations"] === "string" ? Math.max(1, Math.min(3, Number(args["video-iterations"]))) : undefined,
  }) : baseConfig;
  return runWithRuntimeConfig(effectiveConfig, () => runVideoAgentInternal(argv, signal, effectiveConfig));
}
