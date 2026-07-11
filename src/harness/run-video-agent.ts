import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VideoProject } from "../pipeline/types";
import { fromRoot, loadDotEnv, parseArgs, readJson, slugify } from "../pipeline/utils";
import { buildFeedbackGuidance, readFeedback } from "./feedback-store";
import { evaluateAudio, evaluateDraft, evaluateVideo, type QualityEvaluation } from "./quality";

interface StoryManifestItem {
  index: number;
  title: string;
  source: string;
  score: number;
  projectPath: string;
  htmlVideoGraphPath?: string;
  outputPath: string;
}

interface IterationReport {
  iteration: number;
  draft: QualityEvaluation;
  audio?: QualityEvaluation;
}

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

function runScript(script: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, fromRoot(script), ...args], {
      cwd: fromRoot(),
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      code === 0 ? resolve() : reject(new Error(`${script} exited with code ${code}`));
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
const explicitNotes = typeof args.notes === "string" ? args.notes : "";
const feedback = await readFeedback(30);
const relevantFeedback = feedback.filter((entry) => !entry.url || entry.url === url);
const feedbackGuidance = buildFeedbackGuidance(relevantFeedback);
const manifestPath = fromRoot("public", "generated", "stories", "manifest.json");
const iterations: IterationReport[] = [];
let loopNotes = combineNotes([
  explicitNotes,
  feedbackGuidance ? `历史用户反馈，必须避免重复：\n${feedbackGuidance}` : "",
]);
let selectedManifest: StoryManifestItem | undefined;
let selectedProject: VideoProject | undefined;

console.log(`\n[harness] URL: ${url}`);
console.log(`[harness] target: ${targetSeconds}s, max iterations: ${maxIterations}`);
console.log(`[harness] feedback applied: ${relevantFeedback.length}`);

for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
  console.log(`\n[harness] iteration ${iteration}/${maxIterations}: generate draft`);
  const generateArgs = [
    "--url",
    url,
    "--url-only",
    "--count",
    "1",
    "--screenshots",
    String(screenshotLimit),
    "--seconds",
    String(targetSeconds),
    "--out-dir",
    outputDir,
    "--skip-tts",
  ];
  if (loopNotes) generateArgs.push("--notes", loopNotes.replace(/\r?\n/g, "；"));
  await runScript("src/pipeline/generate-stories.ts", generateArgs);

  const manifest = await readJson<StoryManifestItem[]>(manifestPath);
  const story = manifest[0];
  if (!story) throw new Error("No story project was generated.");
  let project = await readJson<VideoProject>(story.projectPath);
  const draft = await evaluateDraft(project, targetSeconds, feedbackGuidance);
  const iterationReport: IterationReport = { iteration, draft };
  iterations.push(iterationReport);
  console.log(`[harness] draft passed: ${draft.passed}`);
  console.log(`[harness] draft metrics: ${JSON.stringify(draft.metrics)}`);

  if (!draft.passed) {
    if (iteration === maxIterations) {
      selectedManifest = story;
      selectedProject = project;
      break;
    }
    loopNotes = combineNotes([
      explicitNotes,
      feedbackGuidance ? `历史用户反馈：\n${feedbackGuidance}` : "",
      `上一轮质量问题：\n${draft.issues.map((issue) => `- ${issue.message}`).join("\n")}`,
      `下一轮修改要求：\n${draft.revisionNotes.map((note) => `- ${note}`).join("\n")}`,
    ]);
    continue;
  }

  console.log(`[harness] iteration ${iteration}: synthesize narration`);
  const basename = `narration-agent-${slugify(project.sources[0]?.id ?? project.meta.title, "story")}`;
  await runScript("src/pipeline/synthesize-story.ts", [
    "--project", story.projectPath,
    "--basename", basename,
    "--seconds", String(targetSeconds),
  ]);
  project = await readJson<VideoProject>(story.projectPath);
  const audio = evaluateAudio(project, targetSeconds);
  iterationReport.audio = audio;
  console.log(`[harness] audio passed: ${audio.passed}`);
  console.log(`[harness] audio metrics: ${JSON.stringify(audio.metrics)}`);

  if (!audio.passed && iteration < maxIterations) {
    loopNotes = combineNotes([
      explicitNotes,
      feedbackGuidance ? `历史用户反馈：\n${feedbackGuidance}` : "",
      `上一轮音频问题：\n${audio.issues.map((issue) => `- ${issue.message}`).join("\n")}`,
      `下一轮修改要求：\n${audio.revisionNotes.map((note) => `- ${note}`).join("\n")}`,
    ]);
    continue;
  }

  selectedManifest = story;
  selectedProject = project;
  break;
}

if (!selectedManifest || !selectedProject) throw new Error("Harness did not produce a usable story project.");
const finalDraft = iterations[iterations.length - 1]?.draft;
const finalAudio = iterations[iterations.length - 1]?.audio ?? evaluateAudio(selectedProject, targetSeconds);
if (!finalDraft?.passed || !finalAudio.passed) {
  throw new Error("Quality gate failed after all iterations. Rendering stopped; inspect the draft/audio issues above.");
}

console.log(`\n[harness] render: ${selectedManifest.outputPath}`);
await runScript("src/pipeline/render-stories.ts", [
  "--manifest",
  manifestPath,
  "--limit",
  "1",
  "--overwrite",
]);

const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${slugify(selectedProject.meta.title, "video")}`;
const reportDir = fromRoot("dist", "quality", runId);
const video = await evaluateVideo(selectedManifest.outputPath, reportDir);
const passed = Boolean(finalDraft?.passed && finalAudio.passed && video.passed);
const report = {
  createdAt: new Date().toISOString(),
  url,
  outputPath: selectedManifest.outputPath,
  projectPath: selectedManifest.projectPath,
  targetSeconds,
  maxIterations,
  feedbackApplied: relevantFeedback,
  iterations,
  video,
  passed,
};
await mkdir(reportDir, { recursive: true });
await writeFile(path.join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
const markdown = [
  "# Video Quality Report",
  "",
  `- URL: ${url}`,
  `- Output: ${selectedManifest.outputPath}`,
  `- Target: ${targetSeconds}s`,
  `- Passed: ${passed}`,
  `- Feedback applied: ${relevantFeedback.length}`,
  "",
  ...iterations.flatMap((item) => [
    `## Iteration ${item.iteration}`,
    evaluationMarkdown(item.draft),
    item.audio ? evaluationMarkdown(item.audio) : "",
    "",
  ]),
  "## Final Video",
  evaluationMarkdown(video),
  "",
].join("\n");
await writeFile(path.join(reportDir, "report.md"), markdown, "utf8");

console.log(`\n[harness] video: ${selectedManifest.outputPath}`);
console.log(`[harness] report: ${path.join(reportDir, "report.md")}`);
console.log(`[harness] passed: ${passed}`);
if (!passed) process.exitCode = 2;
