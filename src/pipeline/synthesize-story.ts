import path from "node:path";
import { writeHtmlVideoContentGraph } from "../html-video/render-html-video";
import type { VideoProject } from "./types";
import { attachNarrationAudio } from "./tts";
import { fromRoot, loadDotEnv, parseArgs, readJson, slugify, writeJson } from "./utils";
import { videoProjectSchema } from "./schemas";
import { ensureNewsDateNarration, ensureTitleSpokenFirst, normalizeProjectDatePrecision } from "./news-date";
import { alignProjectSpeech } from "./speech-alignment";

loadDotEnv();

const args = parseArgs(process.argv.slice(2));
if (typeof args.project !== "string") {
  throw new Error("Usage: npm run synthesize:story -- --project <project.json> [--basename <name>] [--force-scenes 1,2] [--force-audio-rebuild] [--cache-salt <salt>] [--reason <code>]");
}

const projectPath = path.resolve(args.project);
let project = videoProjectSchema.parse(await readJson<unknown>(projectPath)) as VideoProject;
const targetSeconds = typeof args.seconds === "string" ? Number(args.seconds) : undefined;
if (targetSeconds && Number.isFinite(targetSeconds) && targetSeconds > 0) {
  project = { ...project, meta: { ...project.meta, durationSeconds: targetSeconds } };
}
project = normalizeProjectDatePrecision(project);
project = ensureTitleSpokenFirst(project);
project = ensureNewsDateNarration(project);
const sourceId = project.sources[0]?.id ?? slugify(project.meta.title, "story");
const basename =
  typeof args.basename === "string" ? args.basename : `narration-agent-${slugify(sourceId, "story")}`;
const forceSceneIndexes = typeof args["force-scenes"] === "string"
  ? [...new Set(args["force-scenes"].split(",").map(Number).filter((value) => Number.isInteger(value) && value >= 0))]
  : undefined;
const forceAudioRebuild = Boolean(args["force-audio-rebuild"]);
const cacheSalt = typeof args["cache-salt"] === "string" ? args["cache-salt"] : undefined;
const reason = typeof args.reason === "string" ? args.reason : undefined;
const pronunciationStrategy = args["pronunciation-strategy"] === "retry-verifier" || args["pronunciation-strategy"] === "switch-pronunciation-mode" || args["pronunciation-strategy"] === "use-spoken-fallback" || args["pronunciation-strategy"] === "switch-tts-provider" || args["pronunciation-strategy"] === "manual-confirmation" ? args["pronunciation-strategy"] : undefined;
const provider = args.provider === "nvidia" || args.provider === "azure" || args.provider === "cloudflare-melotts" || args.provider === "edge" || args.provider === "openai" || args.provider === "f5" || args.provider === "local" || args.provider === "mock" ? args.provider : undefined;

if (project.revision?.changedSceneIndexes.length) console.log(`Rebuilding narration scenes: ${project.revision.changedSceneIndexes.map((index) => index + 1).join(", ")}`);
project = await attachNarrationAudio(project, basename, { forceSceneIndexes, forceAudioRebuild, cacheSalt, reason, provider, pronunciationStrategy });
try {
  project = await alignProjectSpeech(project);
  const alignedCueCount = project.narrationSegments?.reduce((sum, segment) => sum + (segment.speechAlignment?.phrases.length ?? 0), 0) ?? 0;
  console.log(`Speech alignment: ${alignedCueCount} timestamped cues`);
} catch (error) {
  console.warn(`Speech alignment unavailable; using estimated sync cues: ${(error as Error).message}`);
}
project = { ...project, revision: undefined };
await writeJson(projectPath, videoProjectSchema.parse(project));

const slug = slugify(project.meta.title, sourceId);
const graphPath = fromRoot("public", "generated", "html-video", slug, "content-graph.json");
await writeHtmlVideoContentGraph(project, graphPath);

console.log(`Synthesized narration: ${project.audio?.src}`);
console.log(`Duration: ${project.meta.durationSeconds.toFixed(2)}s`);
console.log(`Project: ${projectPath}`);
