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
import { fromRoot, loadDotEnv, parseArgs, readJson, slugify, writeJson, writeJsonAtomic } from "./utils";
import { generationResultSchema, readStoryManifest, type StoryManifestItem, writeStoryManifest } from "./story-manifest";
import { videoProjectSchema } from "./schemas";
import { ensureNewsDateNarration, ensureTitleSpokenFirst, normalizeProjectDatePrecision } from "./news-date";

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
  const manifest = await readStoryManifest(manifestPath).catch(() => []);
  const fromManifest = manifest.find((item) => githubKey(item.sourceUrl ?? "") === key);
  const names = await readdir(storiesDir).catch(() => []);
  for (const name of names.filter((value) => value.endsWith(".json") && value !== "manifest.json")) {
    const projectPath = path.join(storiesDir, name);
    const project = await readJson<unknown>(projectPath).then((value) => videoProjectSchema.parse(value) as VideoProject).catch(() => null);
    if (!project || !Array.isArray(project.sources) || githubKey(project.sources[0]?.url ?? "") !== key) continue;
    const manifestItem = manifest.find((item) => item.projectPath === projectPath || item.title === project.meta.title);
    return { projectPath, project, manifestItem };
  }
  if (!fromManifest) return null;
  const project = await readJson<unknown>(fromManifest.projectPath).then((value) => videoProjectSchema.parse(value) as VideoProject).catch(() => null);
  return project ? { projectPath: fromManifest.projectPath, project, manifestItem: fromManifest } : null;
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
const skipTts = Boolean(args["skip-tts"]);
const outputDir =
  typeof args["out-dir"] === "string" ? path.resolve(args["out-dir"]) : fromRoot("dist", "stories");
const runDir = typeof args["run-dir"] === "string" ? path.resolve(args["run-dir"]) : undefined;
const resultFile = typeof args["result-file"] === "string"
  ? path.resolve(args["result-file"])
  : runDir
    ? path.join(runDir, "generation-result.json")
    : undefined;
const manifestPath = runDir
  ? path.join(runDir, "manifest.json")
  : fromRoot("public", "generated", "stories", "manifest.json");
const projectsDir = runDir ? path.join(runDir, "projects") : fromRoot("public", "generated", "stories");
const htmlVideoDir = runDir ? path.join(runDir, "html-video") : fromRoot("public", "generated", "html-video");

if (urls.length === 1 && !args["ignore-cache"]) {
  const cached = await findGithubCache(urls[0]);
  if (cached) {
    const slug = `01-${slugify(cached.project.meta.title, cached.project.sources[0]?.id ?? "story")}`;
    const projectPath = runDir ? path.join(projectsDir, `${slug}.json`) : cached.projectPath;
    const htmlVideoGraphPath = path.join(htmlVideoDir, slug, "content-graph.json");
    const productionReportPath = path.join(htmlVideoDir, slug, "production-report.json");
    const outputPath = path.join(outputDir, `${slug}.mp4`);
    if (runDir) await writeJson(projectPath, videoProjectSchema.parse(cached.project));
    await writeHtmlVideoContentGraph(cached.project, htmlVideoGraphPath);
    await writeJson(productionReportPath, buildProductionReport(cached.project, "html-video"));
    const story: StoryManifestItem = {
      index: 1,
      title: cached.project.meta.title,
      source: cached.project.sources[0]?.source ?? "核心事实",
      sourceUrl: cached.project.sources[0]?.url,
      score: cached.project.sources[0]?.score ?? cached.manifestItem?.score ?? 0,
      projectPath,
      htmlVideoGraphPath,
      productionReportPath,
      outputPath,
    };
    await writeStoryManifest(manifestPath, [story]);
    if (resultFile) {
      await writeJsonAtomic(resultFile, generationResultSchema.parse({
        createdAt: new Date().toISOString(),
        cacheHit: true,
        manifestPath,
        stories: [story],
      }));
    }
    console.log("\n[github-cache] 已经生成过，已写入本次运行结果");
    console.log("[github-cache] 仓库: " + githubKey(urls[0]));
    console.log("[github-cache] 项目: " + projectPath);
    console.log("[github-cache] 视频: " + outputPath);
    console.log("[github-cache] 生成时间: " + cached.project.meta.createdAt);
    process.exit(0);
  }
}

const config = await readJson<SourceConfig>(fromRoot("config", "sources.json"));
const items = (
  urlOnly && urls.length > 0 ? await collectWebpage(urls, config) : await collectHotItems(config, urls)
).slice(0, count);
if (items.length === 0) throw new Error("No source items were collected for generation.");
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
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, childKey === "factLedger" ? child : scrubProject(child, childKey)]));
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
  project = normalizeProjectDatePrecision(project);
  project = ensureNewsDateNarration(project);
  project = ensureTitleSpokenFirst(project);
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
  const projectPath = path.join(projectsDir, `${slug}.json`);
  const htmlVideoGraphPath = path.join(htmlVideoDir, slug, "content-graph.json");
  const productionReportPath = path.join(htmlVideoDir, slug, "production-report.json");
  const outputPath = path.join(outputDir, `${slug}.mp4`);
  await writeJson(projectPath, videoProjectSchema.parse(project));
  await writeHtmlVideoContentGraph(project, htmlVideoGraphPath);
  await writeJson(productionReportPath, buildProductionReport(project, "html-video"));

  manifest.push({
    index: storyNo,
    title: project.meta.title,
    source: project.sources[0]?.source ?? "核心事实",
    sourceUrl: project.sources[0]?.url,
    score: item.score,
    projectPath,
    htmlVideoGraphPath,
    productionReportPath,
    outputPath,
  });
}

await writeStoryManifest(manifestPath, manifest);
if (!runDir) await writeStoryManifest(fromRoot("dist", "stories-manifest.json"), manifest);
if (resultFile) {
  await writeJsonAtomic(resultFile, generationResultSchema.parse({
    createdAt: new Date().toISOString(),
    cacheHit: false,
    manifestPath,
    stories: manifest,
  }));
}

console.log(`\nGenerated ${manifest.length} independent story projects:`);
for (const story of manifest) {
  console.log(`${story.index}. ${story.title}`);
  console.log(`   project: ${path.relative(fromRoot(), story.projectPath)}`);
  console.log(`   output : ${path.relative(fromRoot(), story.outputPath)}`);
}
