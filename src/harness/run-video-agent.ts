import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VideoProject } from "../pipeline/types";
import { fromRoot, loadDotEnv, parseArgs, readJson, slugify, writeJsonAtomic } from "../pipeline/utils";
import { buildFeedbackGuidance, readFeedback } from "./feedback-store";
import { evaluateAudio, evaluateDraft, evaluateVideo, type QualityEvaluation } from "./quality";
import { buildProductionReport } from "../production/production-report";
import { generationResultSchema, type StoryManifestItem } from "../pipeline/story-manifest";
import { videoProjectSchema } from "../pipeline/schemas";
import { RunJournalStore } from "./run-journal";

interface IterationReport {
  iteration: number;
  draft: QualityEvaluation;
  audio?: QualityEvaluation;
}

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
let activeJournal: RunJournalStore | undefined;

function runScript(script: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, fromRoot(script), ...args], {
      cwd: fromRoot(),
      stdio: ["inherit", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      process.stderr.write(text);
      stderr = `${stderr}${text}`.slice(-8000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      code === 0 ? resolve() : reject(new Error(`${script} exited with code ${code}${stderr ? `\n${stderr}` : ""}`));
    });
  });
}

function combineNotes(parts: string[]) {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 5000);
}

function evaluationMarkdown(evaluation: QualityEvaluation) {
  const lines = [`### ${evaluation.stage}`, `- Passed: ${evaluation.passed}`, `- Metrics: ${JSON.stringify(evaluation.metrics)}`];
  if (evaluation.scores) lines.push(`- Scores: ${JSON.stringify(evaluation.scores)}`);
  for (const issue of evaluation.issues) lines.push(`- ${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}`);
  return lines.join("\n");
}

async function executeStage<T>(
  journal: RunJournalStore,
  name: string,
  attempt: number,
  task: () => Promise<T>,
  describe?: (result: T) => { outputs?: Record<string, string>; metrics?: Record<string, string | number | boolean> },
) {
  await journal.startStage(name, attempt);
  try {
    const result = await task();
    await journal.finishStage(name, attempt, "succeeded", describe?.(result));
    return result;
  } catch (error) {
    await journal.finishStage(name, attempt, "failed", {
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
    throw error;
  }
}

async function readProject(projectPath: string) {
  return videoProjectSchema.parse(await readJson<unknown>(projectPath)) as VideoProject;
}

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  if (typeof args.url !== "string") {
    throw new Error('Usage: npm run video -- --url "https://example.com/news"');
  }

  const url = args.url;
  const targetSeconds = Number(args.seconds ?? 100);
  const maxIterations = Math.max(1, Math.min(4, Number(args.iterations ?? 2)));
  const outputDir =
    typeof args["out-dir"] === "string"
      ? path.resolve(args["out-dir"])
      : path.resolve(process.env.VIDEO_OUTPUT_DIR ?? "F:\\发布视频");
  const screenshotLimit = Number(args.screenshots ?? 0);
  const engine = typeof args.engine === "string" ? args.engine : process.env.VIDEO_RENDER_ENGINE ?? "html-video";
  if (!new Set(["remotion", "html-video"]).has(engine)) {
    throw new Error(`Unsupported render engine: ${engine}`);
  }
  if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) throw new Error("--seconds must be a positive number.");
  if (!Number.isInteger(screenshotLimit) || screenshotLimit < 0) throw new Error("--screenshots must be a non-negative integer.");

  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${slugify(url, "video")}`;
  const runDir = fromRoot("dist", "runs", runId);
  const reportDir = path.join(runDir, "quality");
  const generationResultPath = path.join(runDir, "generation-result.json");
  const journal = await RunJournalStore.create(runDir, {
    runId,
    url,
    config: {
      targetSeconds,
      maxIterations,
      engine: engine as "remotion" | "html-video",
      outputDir,
      screenshotLimit,
    },
  });
  activeJournal = journal;
  await journal.setArtifacts({ runDir, runJournal: journal.filePath, generationResult: generationResultPath, reportDir });

  const explicitNotes = typeof args.notes === "string" ? args.notes : "";
  const feedback = await readFeedback(30);
  const relevantFeedback = feedback.filter((entry) => !entry.url || entry.url === url);
  const feedbackGuidance = buildFeedbackGuidance(relevantFeedback);
  let manifestPath = path.join(runDir, "manifest.json");
  const iterations: IterationReport[] = [];
  let loopNotes = combineNotes([
    explicitNotes,
    feedbackGuidance ? `历史用户反馈，必须避免重复：\n${feedbackGuidance}` : "",
  ]);
  let selectedManifest: StoryManifestItem | undefined;
  let selectedProject: VideoProject | undefined;
  let ignoreCache = Boolean(args["ignore-cache"]);

console.log(`\n[harness] run: ${runId}`);
console.log(`[harness] journal: ${journal.filePath}`);
console.log(`[harness] URL: ${url}`);
console.log(`[harness] target: ${targetSeconds}s, max iterations: ${maxIterations}, engine: ${engine}`);
console.log(`[harness] feedback applied: ${relevantFeedback.length}`);

for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
  console.log(`\n[harness] iteration ${iteration}/${maxIterations}: ${selectedManifest ? "evaluate local revision" : "generate draft"}`);
  if (!selectedManifest) {
    const generateArgs = [
      "--url", url,
      "--url-only",
      "--count", "1",
      "--screenshots", String(screenshotLimit),
      "--seconds", String(targetSeconds),
      "--out-dir", outputDir,
      "--skip-tts",
      "--run-dir", runDir,
      "--result-file", generationResultPath,
    ];
    if (ignoreCache) generateArgs.push("--ignore-cache");
    if (loopNotes) generateArgs.push("--notes", loopNotes.replace(/\r?\n/g, "；"));
    const generation = await executeStage(
      journal,
      "generate",
      iteration,
      async () => {
        await runScript("src/pipeline/generate-stories.ts", generateArgs);
        return generationResultSchema.parse(JSON.parse(await readFile(generationResultPath, "utf8")));
      },
      (result) => ({
        outputs: {
          generationResultPath,
          manifestPath: result.manifestPath,
          projectPath: result.stories[0].projectPath,
        },
        metrics: { cacheHit: result.cacheHit, storyCount: result.stories.length },
      }),
    );
    manifestPath = generation.manifestPath;
    selectedManifest = generation.stories[0];
    if (!selectedManifest) throw new Error("No story project was generated.");
    await journal.setArtifacts({
      manifestPath,
      projectPath: selectedManifest.projectPath,
      outputPath: selectedManifest.outputPath,
    });
  }
  const story = selectedManifest;
  if (!story) throw new Error("No story project was generated.");
  let project = await readProject(story.projectPath);
  const draft = await executeStage(
    journal,
    "draft-gate",
    iteration,
    () => evaluateDraft(project, targetSeconds, feedbackGuidance),
    (result) => ({ metrics: { ...result.metrics, passed: result.passed, issueCount: result.issues.length } }),
  );
  const draftEvaluationPath = path.join(runDir, "evaluations", `iteration-${iteration}-draft.json`);
  await writeJsonAtomic(draftEvaluationPath, draft);
  await journal.setArtifacts({ [`iteration${iteration}Draft`]: draftEvaluationPath });
  const iterationReport: IterationReport = { iteration, draft };
  iterations.push(iterationReport);
  console.log(`[harness] draft passed: ${draft.passed}`);
  console.log(`[harness] draft metrics: ${JSON.stringify(draft.metrics)}`);
  for (const issue of draft.issues) console.log(`[harness] draft ${issue.severity}: ${issue.code} - ${issue.message}`);

  if (!draft.passed) {
    if (iteration === maxIterations) {
      selectedManifest = story;
      selectedProject = project;
      break;
    }
    const affectedScenes = [...new Set(draft.issues.map((issue) => issue.sceneIndex).filter((index): index is number => typeof index === "number"))];
    if (affectedScenes.length > 0) {
      console.log(`[harness] local draft revision: scenes ${affectedScenes.map((index) => index + 1).join(", ")}`);
      await executeStage(journal, "revise-draft", iteration, () => runScript("src/harness/revise-scenes.ts", [
        "--project", story.projectPath,
        "--scenes", affectedScenes.join(","),
        "--issues", combineNotes([...draft.issues.map((issue) => issue.message), ...draft.revisionNotes]),
      ]));
    } else {
      selectedManifest = undefined;
      ignoreCache = true;
      loopNotes = combineNotes([
        explicitNotes,
        feedbackGuidance ? `历史用户反馈：\n${feedbackGuidance}` : "",
        `上一轮质量问题：\n${draft.issues.map((issue) => `- ${issue.message}`).join("\n")}`,
      ]);
    }
    continue;
  }

  console.log(`[harness] iteration ${iteration}: synthesize narration`);
  const basename = `narration-agent-${slugify(runId, "run").slice(0, 40)}-${slugify(project.sources[0]?.id ?? project.meta.title, "story")}`;
  await executeStage(journal, "synthesize-audio", iteration, () => runScript("src/pipeline/synthesize-story.ts", [
    "--project", story.projectPath,
    "--basename", basename,
    "--seconds", String(targetSeconds),
  ]));
  project = await readProject(story.projectPath);
  const audio = await executeStage(
    journal,
    "audio-gate",
    iteration,
    () => evaluateAudio(project, targetSeconds),
    (result) => ({ metrics: { ...result.metrics, passed: result.passed, issueCount: result.issues.length } }),
  );
  const audioEvaluationPath = path.join(runDir, "evaluations", `iteration-${iteration}-audio.json`);
  await writeJsonAtomic(audioEvaluationPath, audio);
  await journal.setArtifacts({ [`iteration${iteration}Audio`]: audioEvaluationPath });
  iterationReport.audio = audio;
  console.log(`[harness] audio passed: ${audio.passed}`);
  console.log(`[harness] audio metrics: ${JSON.stringify(audio.metrics)}`);
  for (const issue of audio.issues) console.log(`[harness] audio ${issue.severity}: ${issue.code} - ${issue.message}`);

  if (!audio.passed && iteration < maxIterations) {
    const affectedScenes = [...new Set(audio.issues.map((issue) => issue.sceneIndex ?? (issue.code.startsWith("audio_title_") ? 0 : undefined)).filter((index): index is number => typeof index === "number"))];
    if (affectedScenes.length > 0) {
      console.log(`[harness] local audio revision: scenes ${affectedScenes.map((index) => index + 1).join(", ")}`);
      await executeStage(journal, "revise-audio", iteration, () => runScript("src/harness/revise-scenes.ts", [
        "--project", story.projectPath,
        "--scenes", affectedScenes.join(","),
        "--issues", combineNotes([...audio.issues.map((issue) => issue.message), ...audio.revisionNotes]),
      ]));
    } else {
      throw new Error("Audio quality failed without an isolated scene; rendering stopped.");
    }
    continue;
  }

  selectedManifest = story;
  selectedProject = project;
  break;
}

if (!selectedManifest || !selectedProject) throw new Error("Harness did not produce a usable story project.");
const finalDraft = iterations[iterations.length - 1]?.draft;
if (!finalDraft?.passed) {
  throw new Error("Quality gate failed after all iterations. Rendering stopped; inspect the run journal and evaluation artifacts.");
}
const finalAudio = iterations[iterations.length - 1]?.audio;
if (!finalAudio?.passed) {
  throw new Error("Audio quality gate failed after all iterations. Rendering stopped; inspect the run journal and evaluation artifacts.");
}

console.log(`\n[harness] render: ${selectedManifest.outputPath}`);
await executeStage(journal, "render", 1, () => runScript("src/pipeline/render-stories.ts", [
  "--manifest", manifestPath,
  "--overwrite",
  "--engine", engine,
]), () => ({ outputs: { outputPath: selectedManifest.outputPath } }));

const video = await executeStage(
  journal,
  "video-gate",
  1,
  () => evaluateVideo(selectedManifest.outputPath, reportDir, selectedProject.audio?.durationSeconds, selectedProject.scenes.map((scene) => scene.duration)),
  (result) => ({ metrics: { ...result.metrics, passed: result.passed, issueCount: result.issues.length } }),
);
const passed = Boolean(finalDraft?.passed && finalAudio.passed && video.passed);
const production = buildProductionReport(selectedProject, engine);
await mkdir(reportDir, { recursive: true });
await writeFile(path.join(reportDir, "production-report.json"), `${JSON.stringify(production, null, 2)}\n`, "utf8");
const report = {
  createdAt: new Date().toISOString(),
  runId,
  runJournalPath: journal.filePath,
  url,
  outputPath: selectedManifest.outputPath,
  projectPath: selectedManifest.projectPath,
  manifestPath,
  targetSeconds,
  maxIterations,
  engine,
  feedbackApplied: relevantFeedback,
  iterations,
  video,
  production,
  passed,
};
await writeJsonAtomic(path.join(reportDir, "report.json"), report);
const markdown = [
  "# Video Quality Report",
  "",
  `- Run: ${runId}`,
  `- URL: ${url}`,
  `- Output: ${selectedManifest.outputPath}`,
  `- Target: ${targetSeconds}s`,
  `- Engine: ${engine}`,
  `- Passed: ${passed}`,
  `- Feedback applied: ${relevantFeedback.length}`,
  "",
  ...iterations.flatMap((item) => [
    `## Iteration ${item.iteration}`,
    evaluationMarkdown(item.draft),
    item.audio ? evaluationMarkdown(item.audio) : "",
    "",
  ]),
  "## Production Decisions",
  `- Visual source mix: ${JSON.stringify(production.summary.sourceMix)}`,
  `- Enabled providers: ${production.summary.enabledProviders.join(", ")}`,
  `- Alignment: ${production.summary.wordAlignment}`,
  "",
  "## Final Video",
  evaluationMarkdown(video),
  "",
].join("\n");
await writeFile(path.join(reportDir, "report.md"), markdown, "utf8");
await journal.setArtifacts({
  qualityReport: path.join(reportDir, "report.json"),
  qualityReportMarkdown: path.join(reportDir, "report.md"),
  productionReport: path.join(reportDir, "production-report.json"),
});

console.log(`\n[harness] video: ${selectedManifest.outputPath}`);
console.log(`[harness] report: ${path.join(reportDir, "report.md")}`);
console.log(`[harness] passed: ${passed}`);
if (passed) await journal.succeed();
else {
  await journal.fail(new Error("Final video quality gate failed."));
  process.exitCode = 2;
}
}

main().catch(async (error) => {
  await activeJournal?.fail(error).catch(() => undefined);
  console.error(`\n[harness] failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
