import path from "node:path";
import { readdir } from "node:fs/promises";
import { writeHtmlVideoContentGraph } from "../html-video/render-html-video";
import { buildProductionReport } from "../production/production-report";
import { collectGithubAssets } from "../production/github-assets";
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
  productionReportPath?: string;
  outputPath: string;
}

loadDotEnv();

const args = parseArgs(process.argv.slice(2));
function githubKey(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== "github.com") return "";
    const parts = parsed.pathname.split("/").filter(Boolean).slice(0, 2);
    return parts.length === 2 ? parts.join("/").toLowerCase() : "";
  } catch { return ""; }
}

async function findGithubCache(url: string) {
  const key = githubKey(url);
  if (!key) return null;
  const storiesDir = fromRoot("public", "generated", "stories");
  const manifestPath = fromRoot("public", "generated", "stories", "manifest.json");
  const manifest = await readJson<StoryManifestItem[]>(manifestPath).catch(() => []);
  const fromManifest = manifest.find((item) => githubKey(item.source) === key || githubKey(item.projectPath) === key);
  const names = await readdir(storiesDir).catch(() => []);
  for (const name of names.filter((value) => value.endsWith(".json") && value !== "manifest.json")) {
    const projectPath = path.join(storiesDir, name);
    const project = await readJson<VideoProject>(projectPath).catch(() => null);
    if (!project || !Array.isArray(project.sources) || githubKey(project.sources[0]?.url ?? "") !== key) continue;
    const manifestItem = manifest.find((item) => item.projectPath === projectPath || item.title === project.meta.title);
    return { projectPath, project, manifestItem, outputPath: manifestItem?.outputPath ?? path.join(process.env.VIDEO_OUTPUT_DIR ?? "F:\\发布视频", name.replace(/\.json$/, ".mp4")) };
  }
  return fromManifest ? { projectPath: fromManifest.projectPath, project: null, manifestItem: fromManifest, outputPath: fromManifest.outputPath } : null;
}

const urls = typeof args.url === "string" ? [args.url] : [];
const count = Number(args.count ?? process.env.STORY_COUNT ?? 3);
const screenshotLimit = Number(args.screenshots ?? process.env.SCREENSHOT_LIMIT ?? 1);
const width = Number(args.width ?? process.env.VIDEO_WIDTH ?? 1080);
const height = Number(args.height ?? process.env.VIDEO_HEIGHT ?? 1920);
const fps = Number(args.fps ?? process.env.VIDEO_FPS ?? 30);
const targetSeconds = args.seconds ? Number(args.seconds) : undefined;
const urlOnly = Boolean(args["url-only"]);
const editorialNotes = typeof args.notes === "string" ? args.notes : undefined;
if (urls.length === 1) {
  const cached = await findGithubCache(urls[0]);
  if (cached) {
    console.log("\n[github-cache] 已经生成过，直接退出");
    console.log("[github-cache] 仓库: " + githubKey(urls[0]));
    console.log("[github-cache] 项目: " + cached.projectPath);
    console.log("[github-cache] 视频: " + cached.outputPath);
    if (cached.project?.meta.createdAt) console.log("[github-cache] 生成时间: " + cached.project.meta.createdAt);
    process.exit(0);
  }
}
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

  const [screenshots, assets] = await Promise.all([
    captureWebScreenshots([item], screenshotLimit),
    collectGithubAssets(item, Number(process.env.GITHUB_ASSET_LIMIT ?? 3)),
  ]);
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
  project.assets = assets;
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
  const productionReportPath = fromRoot("public", "generated", "html-video", slug, "production-report.json");
  const outputPath = path.join(outputDir, `${slug}.mp4`);
  await writeJson(projectPath, project);
  await writeHtmlVideoContentGraph(project, htmlVideoGraphPath);
  await writeJson(productionReportPath, buildProductionReport(project, "html-video"));

  manifest.push({
    index: storyNo,
    title: project.meta.title,
    source: project.sources[0]?.source ?? "核心事实",
    score: item.score,
    projectPath,
    htmlVideoGraphPath,
    productionReportPath,
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
