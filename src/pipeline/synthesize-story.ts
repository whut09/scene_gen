import path from "node:path";
import { writeHtmlVideoContentGraph } from "../html-video/render-html-video";
import type { VideoProject } from "./types";
import { attachNarrationAudio } from "./tts";
import { fromRoot, loadDotEnv, parseArgs, readJson, slugify, writeJson } from "./utils";

loadDotEnv();

const args = parseArgs(process.argv.slice(2));
if (typeof args.project !== "string") {
  throw new Error("Usage: npm run synthesize:story -- --project <project.json> [--basename <name>]");
}

const projectPath = path.resolve(args.project);
let project = await readJson<VideoProject>(projectPath);
const targetSeconds = typeof args.seconds === "string" ? Number(args.seconds) : undefined;
if (targetSeconds && Number.isFinite(targetSeconds) && targetSeconds > 0) {
  project = { ...project, meta: { ...project.meta, durationSeconds: targetSeconds } };
}
const sourceId = project.sources[0]?.id ?? slugify(project.meta.title, "story");
const basename =
  typeof args.basename === "string" ? args.basename : `narration-agent-${slugify(sourceId, "story")}`;

project = await attachNarrationAudio(project, basename);
await writeJson(projectPath, project);

const slug = slugify(project.meta.title, sourceId);
const graphPath = fromRoot("public", "generated", "html-video", slug, "content-graph.json");
await writeHtmlVideoContentGraph(project, graphPath);

console.log(`Synthesized narration: ${project.audio?.src}`);
console.log(`Duration: ${project.meta.durationSeconds.toFixed(2)}s`);
console.log(`Project: ${projectPath}`);