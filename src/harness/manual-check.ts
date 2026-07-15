import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { VideoProject } from "../pipeline/types";
import { fromRoot, readJson, slugify, writeJsonAtomic } from "../pipeline/utils";
import { videoProjectSchema } from "../pipeline/schemas";
import { buildFeedbackGuidance, readFeedback, selectFeedback } from "./feedback-store";
import { evaluateAudio, evaluateDraft, evaluateVideo } from "./quality";

export async function runManualCheck(input: { projectPath: string; videoPath: string; targetSeconds: number }) {
  const projectPath = path.resolve(input.projectPath);
  const videoPath = path.resolve(input.videoPath);
  const project = videoProjectSchema.parse(await readJson<unknown>(projectPath)) as VideoProject;
  const feedback = selectFeedback(await readFeedback(30), { url: project.sources[0]?.url ?? "", stage: "draft" });
  const reportDir = fromRoot("dist", "quality", `manual-${slugify(project.meta.title, "video")}`);
  const draft = await evaluateDraft(project, input.targetSeconds, buildFeedbackGuidance(feedback));
  const audio = await evaluateAudio(project, input.targetSeconds);
  const video = await evaluateVideo(videoPath, reportDir, project.audio?.durationSeconds, project.scenes.map((scene) => scene.duration));
  const report = { createdAt: new Date().toISOString(), projectPath, videoPath, draft, audio, video, passed: draft.passed && audio.passed && video.passed };
  await mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "report.json");
  await writeJsonAtomic(reportPath, report);
  return { ...report, reportPath };
}
