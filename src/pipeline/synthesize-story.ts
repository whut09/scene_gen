import path from "node:path";
import { writeHtmlVideoContentGraph } from "../html-video/render-html-video";
import type { VideoProject } from "./types";
import { attachNarrationAudio } from "./tts";
import { fromRoot, loadDotEnv, parseArgs, readJson, slugify, writeJson } from "./utils";
import { videoProjectSchema } from "./schemas";

loadDotEnv();

const args = parseArgs(process.argv.slice(2));
if (typeof args.project !== "string") {
  throw new Error("Usage: npm run synthesize:story -- --project <project.json> [--basename <name>]");
}

const projectPath = path.resolve(args.project);
let project = videoProjectSchema.parse(await readJson<unknown>(projectPath)) as VideoProject;
const targetSeconds = typeof args.seconds === "string" ? Number(args.seconds) : undefined;
if (targetSeconds && Number.isFinite(targetSeconds) && targetSeconds > 0) {
  project = { ...project, meta: { ...project.meta, durationSeconds: targetSeconds } };
}
const sourceId = project.sources[0]?.id ?? slugify(project.meta.title, "story");
const basename =
  typeof args.basename === "string" ? args.basename : `narration-agent-${slugify(sourceId, "story")}`;

if (project.revision?.changedSceneIndexes.length) console.log(`Rebuilding narration scenes: ${project.revision.changedSceneIndexes.map((index) => index + 1).join(", ")}`);
project = await attachNarrationAudio(project, basename);
project = { ...project, revision: undefined };
await writeJson(projectPath, videoProjectSchema.parse(project));

const slug = slugify(project.meta.title, sourceId);
const graphPath = fromRoot("public", "generated", "html-video", slug, "content-graph.json");
await writeHtmlVideoContentGraph(project, graphPath);

console.log(`Synthesized narration: ${project.audio?.src}`);
console.log(`Duration: ${project.meta.durationSeconds.toFixed(2)}s`);
console.log(`Project: ${projectPath}`);
