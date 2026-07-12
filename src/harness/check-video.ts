import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VideoProject } from "../pipeline/types";
import { fromRoot, loadDotEnv, parseArgs, readJson, slugify } from "../pipeline/utils";
import { buildFeedbackGuidance, readFeedback } from "./feedback-store";
import { evaluateAudio, evaluateDraft, evaluateVideo } from "./quality";

loadDotEnv();
const args = parseArgs(process.argv.slice(2));
if (typeof args.project !== "string" || typeof args.video !== "string") {
  throw new Error("Usage: npm run video:check -- --project <project.json> --video <video.mp4> [--seconds 100]");
}
const projectPath = path.resolve(args.project);
const videoPath = path.resolve(args.video);
const targetSeconds = Number(args.seconds ?? 100);
const project = await readJson<VideoProject>(projectPath);
const feedback = await readFeedback(30);
const guidance = buildFeedbackGuidance(feedback.filter((entry) => !entry.url || entry.url === project.sources[0]?.url));
const reportDir = fromRoot("dist", "quality", `manual-${slugify(project.meta.title, "video")}`);
const draft = await evaluateDraft(project, targetSeconds, guidance);
const audio = await evaluateAudio(project, targetSeconds);
const video = await evaluateVideo(videoPath, reportDir, project.audio?.durationSeconds, project.scenes.map((scene) => scene.duration));
const report = { createdAt: new Date().toISOString(), projectPath, videoPath, draft, audio, video, passed: draft.passed && audio.passed && video.passed };
await mkdir(reportDir, { recursive: true });
await writeFile(path.join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 2;