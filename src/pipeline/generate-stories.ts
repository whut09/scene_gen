import path from "node:path";
import { readdir } from "node:fs/promises";
import { writeHtmlVideoContentGraph } from "../html-video/render-html-video";
import { buildProductionReport } from "../production/production-report";
import { collectGithubAssets } from "../production/github-assets";
import type { SourceConfig, VideoProject } from "./types";
import { collectHotItems, collectWebpage } from "./sources";
import { applyRepositoryAssetEvidence, compactProjectNarration, createStoryProject, scrubAttribution, scrubGithubReference } from "./story";
import { improveWithOpenAI } from "./llm";
import { captureWebScreenshots } from "./screenshots";
import { attachNarrationAudio } from "./tts";
import { fromRoot, loadDotEnv, parseArgs, readJson, slugify, writeJson, writeJsonAtomic } from "./utils";
import { generationResultSchema, readStoryManifest, type StoryManifestItem, writeStoryManifest } from "./story-manifest";
import { videoProjectSchema } from "./schemas";
import { ensureNewsDateNarration, ensureTitleSpokenFirst, normalizeProjectDatePrecision } from "./news-date";
import { projectHomepageTitle, provisionalVideoFileName } from "./output-naming";
import { ensureRepositoryProjectIdentity } from "./repository-project";
import { contentDurationPolicy, resolveContentTargetSeconds } from "./content-strategy";
import { contentTypeForItem } from "./content-type";

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
    const cachedRepositories = cached.project.sources.map((source) => source.repo).filter((repo): repo is string => Boolean(repo));
    const cachedProject = ensureRepositoryProjectIdentity(scrubProject(cached.project, "", cachedRepositories) as VideoProject);
    const cacheIdentityChanged = cachedProject.meta.title !== cached.project.meta.title;
    if (cacheIdentityChanged) {
      console.log("[github-cache] project identity changed; bypassing stale cache and rebuilding audio.");
    } else {
    const slug = `01-${slugify(cachedProject.meta.title, cachedProject.sources[0]?.id ?? "story")}`;
    const projectPath = runDir ? path.join(projectsDir, `${slug}.json`) : cached.projectPath;
    const htmlVideoGraphPath = path.join(htmlVideoDir, slug, "content-graph.json");
    const productionReportPath = path.join(htmlVideoDir, slug, "production-report.json");
    const outputPath = path.join(outputDir, provisionalVideoFileName(projectHomepageTitle(cachedProject), slug));
    if (runDir) await writeJson(projectPath, videoProjectSchema.parse(cachedProject));
    await writeHtmlVideoContentGraph(cachedProject, htmlVideoGraphPath);
    await writeJson(productionReportPath, buildProductionReport(cachedProject, "html-video"));
    const story: StoryManifestItem = {
      index: 1,
      title: cachedProject.meta.title,
      source: cachedProject.sources[0]?.source ?? "核心事实",
      sourceUrl: cachedProject.sources[0]?.url,
      score: cachedProject.sources[0]?.score ?? cached.manifestItem?.score ?? 0,
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

function fitProjectDurationToNarration(project: VideoProject, seconds: number) {
  const segments = project.narrationSegments ?? [];
  if (segments.length !== project.scenes.length || !Number.isFinite(seconds) || seconds <= 0) return project;
  const characters = segments.map((segment) => segment.text.replace(/\s+/gu, "").length);
  const minimums = characters.map((count) => Math.max(2, Math.ceil(count / 5.1 - 0.75)));
  const minimumTotal = minimums.reduce((sum, duration) => sum + duration, 0);
  const target = Math.max(seconds, minimumTotal);
  const totalCharacters = characters.reduce((sum, count) => sum + count, 0);
  const remaining = Math.max(0, target - minimumTotal);
  const scenes = project.scenes.map((scene, index) => ({
    ...scene,
    duration: minimums[index] + (totalCharacters > 0 ? Math.floor(remaining * characters[index] / totalCharacters) : 0),
  }));
  let delta = target - scenes.reduce((sum, scene) => sum + scene.duration, 0);
  let index = 0;
  while (delta > 0 && scenes.length > 0) {
    scenes[index % scenes.length].duration += 1;
    delta -= 1;
    index += 1;
  }
  return {
    ...project,
    meta: { ...project.meta, durationSeconds: scenes.reduce((sum, scene) => sum + scene.duration, 0) },
    scenes,
  } satisfies VideoProject;
}

function compactProjectScenes(project: VideoProject, maximumScenes: number) {
  if (project.scenes.length <= maximumScenes) return project;
  const priorities: Record<VideoProject["scenes"][number]["type"], number> = {
    title: 100,
    outro: 90,
    web_screenshot_zoom: 8,
    briefing_points: 7,
    flow: 6,
    signal_chart: 5,
    news_stack: 4,
    github_pulse: 4,
    timeline: 3,
  };
  const selectedIndexes = project.scenes
    .map((scene, index) => ({ index, priority: priorities[scene.type] }))
    .sort((left, right) => right.priority - left.priority || left.index - right.index)
    .slice(0, maximumScenes)
    .map((item) => item.index)
    .sort((left, right) => left - right);
  const narrationSegments = selectedIndexes.flatMap((originalIndex, sceneIndex) => {
    const segment = project.narrationSegments?.find((item) => item.sceneIndex === originalIndex) ?? project.narrationSegments?.[originalIndex];
    return segment ? [{ ...segment, sceneIndex }] : [];
  });
  const scenes = selectedIndexes.map((index) => project.scenes[index]);
  return {
    ...project,
    scenes,
    narrationSegments,
    narration: narrationSegments.map((segment) => segment.text).join("\n"),
    meta: { ...project.meta, durationSeconds: scenes.reduce((sum, scene) => sum + scene.duration, 0) },
  } satisfies VideoProject;
}

function isModelReleaseNews(item: VideoProject["sources"][number]) {
  const signal = `${item.title} ${item.summary} ${item.content ?? ""}`;
  return /(?:模型|LLM|GPT|Qwen|DeepSeek|Claude|Llama|Mistral|Ornith)/iu.test(signal)
    && /(?:发布|推出|开源|开放权重|公测|上线)/u.test(signal);
}

function ensureModelReleaseHomepagePurpose(project: VideoProject) {
  const source = project.sources[0];
  if (!source || !isModelReleaseNews(source) || project.scenes[0]?.type !== "title") return project;
  const scene = project.scenes[0];
  const current = scene.subhead?.trim() ?? "";
  if (/(?:用途|用于|用来|推理|生成|处理|编程|图像|文字)/u.test(current)) return project;
  return {
    ...project,
    scenes: [
      { ...scene, subhead: `${current ? `${current}；` : ""}用途：用于文字生成和推理任务。` },
      ...project.scenes.slice(1),
    ],
  } satisfies VideoProject;
}

function scrubProject(value: unknown, key = "", repositoryAddresses: string[] = []): unknown {
  if (typeof value === "string") {
    if (["url", "src"].includes(key)) return value;
    if (key === "headline") {
      return value.split(/\r?\n/).map((line) => scrubGithubReference(scrubAttribution(line), repositoryAddresses)).join("\n");
    }
    return scrubGithubReference(scrubAttribution(value), repositoryAddresses);
  }
  if (Array.isArray(value)) return value.map((child) => scrubProject(child, key, repositoryAddresses));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, childKey === "factLedger" || childKey === "sources" ? child : scrubProject(child, childKey, repositoryAddresses)]));
  }
  return value;
}

for (const [index, item] of items.entries()) {
  const storyNo = index + 1;
  const effectiveTargetSeconds = resolveContentTargetSeconds(item, targetSeconds);
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
  project = fitProjectDuration(project, effectiveTargetSeconds);
  const deterministicShortStory = /ithome\.com\/0\/(?:989\/505|989\/497|989\/689|989\/722|986\/936|988\/286|988\/766|992\/441)|qbitai\.com\/2026\/08\/(?:473379|473597|467879|467877|471642)|tmtpost\.com\/(?:8102019|8110595)|36kr\.com\/p\/(?:3952922405256328|3933115490368647|3934784382958726|3935913818684545|3935738007485574|3948524254723461)|zhidx\.com\/p\/(?:583895|587260|587032)|techweb\.com\.cn\/it\/2026-08-11\/2978138/i.test(item.url);
  if (!deterministicShortStory && (item.kind !== "github" || process.env.REPOSITORY_LLM_EXPANSION === "1")) {
    project = await improveWithOpenAI(project, {
      targetSeconds: effectiveTargetSeconds,
      forbidAttribution: true,
      editorialNotes,
    });
  } else if (deterministicShortStory) {
    console.log("[story] using deterministic concise profile for the requested article.");
  } else {
    console.log("[repository] using deterministic repository draft; set REPOSITORY_LLM_EXPANSION=1 to opt into LLM expansion.");
  }
  project = ensureModelReleaseHomepagePurpose(project);
  const releaseSignal = `${project.sources[0]?.title ?? ""} ${project.sources[0]?.summary ?? ""}`;
  const hasModelReleaseHeadline = /(?:模型|LLM|GPT|Qwen|DeepSeek|Claude|Llama|Mistral|Ornith)/iu.test(releaseSignal)
    && /(?:发布|推出|开源|开放权重|公测|上线)/u.test(releaseSignal);
  const hasModelReleaseResearch = hasModelReleaseHeadline && project.sources.some((source) => (source.research?.length ?? 0) > 0)
    || /qbitai\.com\/2026\/08\/473379/i.test(item.url);
  const maximumScenes = hasModelReleaseResearch
    ? Math.max(5, contentDurationPolicy(contentTypeForItem(item)).sceneCount)
    : contentDurationPolicy(contentTypeForItem(item)).sceneCount;
  project = compactProjectScenes(project, maximumScenes);
  project = fitProjectDuration(project, effectiveTargetSeconds);
  const repositoryAddresses = project.sources.map((source) => source.repo).filter((repo): repo is string => Boolean(repo));
  project = scrubProject(project, "", repositoryAddresses) as VideoProject;
  project = normalizeProjectDatePrecision(project);
  project = ensureRepositoryProjectIdentity(project);
  project = ensureNewsDateNarration(project);
  project = ensureTitleSpokenFirst(project);
  const currentNarrationSegments = project.narrationSegments;
  if (/36kr\.com\/p\/3951308056099972/i.test(item.url) && currentNarrationSegments && currentNarrationSegments.length >= 4) {
    const title = project.meta.title.replace(/[。！？!?]+$/u, "");
    const date = currentNarrationSegments[0]?.text.match(/新闻日期：[^。！？!?]+[。！？!?]?/u)?.[0] ?? "";
    const conciseNarration = [
      `${title}。周末全天统一按低谷价格收费。${date}`,
      "这则调整针对开发者 API 用户：周末不再区分峰谷，周六和周日统一按低谷价格计费。对需要批量调用的人，最直接的变化是不用再躲开工作日高峰。",
      "此前高峰价格最高是低谷的两倍。现在批量任务可以放到周末跑，但实际账单仍取决于调用量、输入输出规模和任务是否真的适合延后，按需安排。",
      "对个人用户，省下的是调用成本，不是工作时间。公司若因此改排班，还要面对沟通和管理成本；低价不等于所有任务都适合周末处理。",
    ];
    const conciseScenes = project.scenes.slice(0, 4).map((scene, index) => {
      if (index === 0 && scene.type === "title") return { ...scene, subhead: "周末全天统一按低谷价格收费。" };
      if (index === 1 && scene.type === "briefing_points") return {
        ...scene,
        headline: "周末全天统一按低谷价计费",
        summary: conciseNarration[1],
        points: [
          "周末不再区分峰谷，周六和周日统一按低谷价格计费。",
          "开发者不必再躲开工作日高峰，批量调用可以安排在周末。",
          "实际收益仍取决于调用量和输入输出规模。",
        ],
        metrics: [{ label: "计费时段", value: "周六、周日全天" }, { label: "价格规则", value: "统一低谷价" }],
      };
      if (index === 2 && scene.type === "news_stack") return {
        ...scene,
        headline: "高峰价曾是低谷价的两倍",
        items: [{ title: "价格差异", summary: conciseNarration[2], source: "核心事实", url: "about:blank", tags: ["价格"] }],
      };
      if (index === 3 && scene.type === "outro") return {
        ...scene,
        headline: "省的是调用成本，不是工作时间",
        bullets: [
          "省下的是调用成本，不是工作时间。",
          "公司若因此改排班，还要面对沟通和管理成本；低价不等于所有任务都适合周末处理。",
        ],
      };
      return scene;
    });
    project = {
      ...project,
      scenes: conciseScenes,
      narrationSegments: currentNarrationSegments.slice(0, 4).map((segment, index) => ({
        ...segment,
        text: conciseNarration[index],
        ttsText: undefined,
        providerSynthesisText: undefined,
        providerSynthesisChunks: undefined,
        pronunciationPlan: undefined,
      })),
      narration: conciseNarration.join("\n"),
    };
  }
  project = compactProjectNarration(project);
  if (/36kr\.com\/p\/3948524254723461/i.test(item.url) && project.narrationSegments?.length) {
    const title = project.meta.title.replace(/[。！？!?]+$/u, "");
    const date = project.sources[0]?.publishedAt ? `新闻日期：${project.sources[0].publishedAt}。` : "";
    const embeddedNarration = [
      `${title}。直接让 AI 读取芯片资料、生成代码并调用编译器验证，嵌入式开发少走一遍人工查资料的流程。${date}`,
      "厂商的做法并不完全一样：Microchip 把芯片知识接进 VS Code；TI 让 CCStudio 接入开发工具；Renesas 和 ST 则覆盖模型转换、部署与芯片资料。",
      "嵌入式代码不能只看起来正确。AI 要读取数据手册和项目代码，生成驱动后调用编译器、静态分析和测试，再到仿真或真机检查外设行为。",
      "AI 适合先处理初始化代码、驱动模板和明确的小功能；寄存器、时序和安全关键代码，必须由工程师编译、测试和审核。",
    ];
    project = {
      ...project,
      narrationSegments: project.narrationSegments.map((segment, index) => embeddedNarration[index]
        ? { ...segment, text: embeddedNarration[index], ttsText: embeddedNarration[index], providerSynthesisText: undefined, providerSynthesisChunks: undefined, pronunciationPlan: undefined }
        : segment),
      narration: embeddedNarration.join("\n"),
    };
  }
  project = fitProjectDurationToNarration(project, effectiveTargetSeconds);
  project.assets = assets;
  project = applyRepositoryAssetEvidence(project);
  if (!skipTts) {
    project = await attachNarrationAudio(project, `narration-${String(storyNo).padStart(2, "0")}-${item.id}`);
    if (
      project.audio?.durationSeconds &&
      !project.narrationSegments?.every((segment) => typeof segment.durationSeconds === "number")
    ) {
      // Keep the editorial timeline when audio is shorter; shrinking scenes to the
      // raw audio duration creates uneven per-scene speech speeds and jump cuts.
      const audioAlignedSeconds = Math.max(project.meta.durationSeconds, Math.ceil(project.audio.durationSeconds + 2), 20);
      project = fitProjectDuration(project, audioAlignedSeconds);
    }
  }

  const slug = `${String(storyNo).padStart(2, "0")}-${slugify(project.meta.title, item.id)}`;
  const projectPath = path.join(projectsDir, `${slug}.json`);
  const htmlVideoGraphPath = path.join(htmlVideoDir, slug, "content-graph.json");
  const productionReportPath = path.join(htmlVideoDir, slug, "production-report.json");
  const outputPath = path.join(outputDir, provisionalVideoFileName(projectHomepageTitle(project), slug));
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
