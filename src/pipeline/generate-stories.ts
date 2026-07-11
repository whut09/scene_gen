import path from "node:path";
import { writeHtmlVideoContentGraph } from "../html-video/render-html-video";
import type { SourceConfig, VideoProject } from "./types";
import { collectHotItems, collectWebpage } from "./sources";
import { createStoryProject, scrubAttribution } from "./story";
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
  htmlVideoGraphPath?: string;
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
const targetSeconds = args.seconds ? Number(args.seconds) : undefined;
const urlOnly = Boolean(args["url-only"]);
const editorialNotes = typeof args.notes === "string" ? args.notes : undefined;
const skipTts = Boolean(args["skip-tts"]);
const outputDir =
  typeof args["out-dir"] === "string" ? path.resolve(args["out-dir"]) : fromRoot("dist", "stories");

const config = await readJson<SourceConfig>(fromRoot("config", "sources.json"));
const items = (
  urlOnly && urls.length > 0 ? await collectWebpage(urls, config) : await collectHotItems(config, urls)
).slice(0, count);
const manifest: StoryManifestItem[] = [];

function fitProjectDuration(project: VideoProject, seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return project;
  const current = project.scenes.reduce((sum, scene) => sum + scene.duration, 0);
  if (current <= 0) return project;
  const ratio = seconds / current;
  let scenes = project.scenes.map((scene) => ({
    ...scene,
    duration: Math.max(2, Math.round(scene.duration * ratio)),
  }));
  let delta = seconds - scenes.reduce((sum, scene) => sum + scene.duration, 0);
  let index = 0;
  while (delta !== 0 && scenes.length > 0) {
    const scene = scenes[index % scenes.length];
    if (delta > 0) {
      scene.duration += 1;
      delta -= 1;
    } else if (scene.duration > 2) {
      scene.duration -= 1;
      delta += 1;
    }
    index += 1;
    if (index > 200) break;
  }
  scenes = scenes.filter((scene) => scene.duration > 0);
  const durationSeconds = scenes.reduce((sum, scene) => sum + scene.duration, 0);
  return {
    ...project,
    meta: {
      ...project.meta,
      durationSeconds,
    },
    scenes,
  } satisfies VideoProject;
}

function scrubProject(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (["url", "src"].includes(key)) return value;
    if (key === "headline") {
      return value.split(/\r?\n/).map((line) => scrubAttribution(line)).join("\n");
    }
    return scrubAttribution(value);
  }
  if (Array.isArray(value)) return value.map((child) => scrubProject(child, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, scrubProject(child, childKey)]));
  }
  return value;
}

for (const [index, item] of items.entries()) {
  const storyNo = index + 1;
  console.log(`\n[story ${storyNo}/${items.length}] ${item.title}`);

  const screenshots = await captureWebScreenshots([item], screenshotLimit);
  let project: VideoProject = createStoryProject(item, {
    width,
    height,
    fps,
    screenshots,
    index: storyNo,
  });
  project = fitProjectDuration(project, targetSeconds ?? project.meta.durationSeconds);
  project = await improveWithOpenAI(project, {
    targetSeconds,
    forbidAttribution: true,
    editorialNotes,
  });
  project = scrubProject(project) as VideoProject;
  if (!skipTts) {
    project = await attachNarrationAudio(project, `narration-${String(storyNo).padStart(2, "0")}-${item.id}`);
    if (
      project.audio?.durationSeconds &&
      !project.narrationSegments?.every((segment) => typeof segment.durationSeconds === "number")
    ) {
      const audioAlignedSeconds = Math.max(20, Math.ceil(project.audio.durationSeconds + 2));
      project = fitProjectDuration(project, audioAlignedSeconds);
    }
  }

  const slug = `${String(storyNo).padStart(2, "0")}-${slugify(project.meta.title, item.id)}`;
  const projectPath = fromRoot("public", "generated", "stories", `${slug}.json`);
  const htmlVideoGraphPath = fromRoot("public", "generated", "html-video", slug, "content-graph.json");
  const outputPath = path.join(outputDir, `${slug}.mp4`);
  await writeJson(projectPath, project);
  await writeHtmlVideoContentGraph(project, htmlVideoGraphPath);

  manifest.push({
    index: storyNo,
    title: project.meta.title,
    source: project.sources[0]?.source ?? "核心事实",
    score: item.score,
    projectPath,
    htmlVideoGraphPath,
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
