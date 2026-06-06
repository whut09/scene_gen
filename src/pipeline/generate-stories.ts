import path from "node:path";
import type { SourceConfig, VideoProject } from "./types";
import { collectHotItems } from "./sources";
import { createStoryProject } from "./story";
import { improveWithOpenAI } from "./llm";
import { captureWebScreenshots } from "./screenshots";
import { attachNarrationAudio } from "./tts";
import { fromRoot, loadDotEnv, parseArgs, readJson, slugify, writeJson } from "./utils";

interface StoryManifestItem {
  index: number;
  title: string;
  source: string;
  score: number;
  projectPath: string;
  outputPath: string;
}

loadDotEnv();

const args = parseArgs(process.argv.slice(2));
const urls = typeof args.url === "string" ? [args.url] : [];
const count = Number(args.count ?? process.env.STORY_COUNT ?? 3);
const screenshotLimit = Number(args.screenshots ?? process.env.SCREENSHOT_LIMIT ?? 1);
const width = Number(args.width ?? process.env.VIDEO_WIDTH ?? 1080);
const height = Number(args.height ?? process.env.VIDEO_HEIGHT ?? 1920);
const fps = Number(args.fps ?? process.env.VIDEO_FPS ?? 30);

const config = await readJson<SourceConfig>(fromRoot("config", "sources.json"));
const items = (await collectHotItems(config, urls)).slice(0, count);
const manifest: StoryManifestItem[] = [];

for (const [index, item] of items.entries()) {
  const storyNo = index + 1;
  const slug = `${String(storyNo).padStart(2, "0")}-${slugify(item.title, item.id)}`;
  console.log(`\n[story ${storyNo}/${items.length}] ${item.title}`);

  const screenshots = await captureWebScreenshots([item], screenshotLimit);
  let project: VideoProject = createStoryProject(item, {
    width,
    height,
    fps,
    screenshots,
    index: storyNo,
  });
  project = await improveWithOpenAI(project);
  project = await attachNarrationAudio(project, `narration-${slug}`);

  const projectPath = fromRoot("public", "generated", "stories", `${slug}.json`);
  const outputPath = fromRoot("dist", "stories", `${slug}.mp4`);
  await writeJson(projectPath, project);

  manifest.push({
    index: storyNo,
    title: project.meta.title,
    source: item.source,
    score: item.score,
    projectPath,
    outputPath,
  });
}

await writeJson(fromRoot("public", "generated", "stories", "manifest.json"), manifest);
await writeJson(fromRoot("dist", "stories-manifest.json"), manifest);

console.log(`\nGenerated ${manifest.length} independent story projects:`);
for (const story of manifest) {
  console.log(`${story.index}. ${story.title}`);
  console.log(`   project: ${path.relative(fromRoot(), story.projectPath)}`);
  console.log(`   output : ${path.relative(fromRoot(), story.outputPath)}`);
}
