import type { SourceConfig } from "./types";
import { collectHotItems } from "./sources";
import { createProject } from "./story";
import { improveWithOpenAI } from "./llm";
import { captureWebScreenshots } from "./screenshots";
import { attachNarrationAudio } from "./tts";
import { fromRoot, loadDotEnv, parseArgs, readJson, writeJson } from "./utils";

loadDotEnv();

const args = parseArgs(process.argv.slice(2));
const urls = typeof args.url === "string" ? [args.url] : [];
const width = Number(args.width ?? process.env.VIDEO_WIDTH ?? 1080);
const height = Number(args.height ?? process.env.VIDEO_HEIGHT ?? 1920);
const fps = Number(args.fps ?? process.env.VIDEO_FPS ?? 30);

const config = await readJson<SourceConfig>(fromRoot("config", "sources.json"));
const items = await collectHotItems(config, urls);
const screenshotLimit = Number(args.screenshots ?? process.env.SCREENSHOT_LIMIT ?? 3);
const screenshots = await captureWebScreenshots(items, screenshotLimit);
let project = createProject(items, { width, height, fps, screenshots });
project = await improveWithOpenAI(project);
project = await attachNarrationAudio(project);

await writeJson(fromRoot("public", "generated", "project.json"), project);
await writeJson(fromRoot("dist", "latest-project.json"), project);

console.log(`Generated: ${project.meta.title}`);
console.log(`Sources: ${project.sources.length}`);
console.log(`Screenshots: ${project.screenshots?.length ?? 0}`);
console.log(`Audio: ${project.audio?.provider ?? "none"} ${project.audio?.src ?? ""}`);
