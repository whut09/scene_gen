import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Browser } from "playwright";
import type { VideoProject, VideoScene } from "../pipeline/types";
import { mapWithConcurrencyUntilError } from "../pipeline/bounded-task-queue";
import { ensureDir, fromRoot, slugify } from "../pipeline/utils";
import { getTemplateById } from "../templates/template-registry";
import { resolveHtmlRenderBudget, type HtmlRenderBudget } from "./render-budget";
import { getOrCreateMediaCache, hashFileContent, restoreMediaCache } from "../cache/media-cache";
import {
  buildHtmlVideoContentGraph,
  topoSortHtmlVideoGraph,
  type HtmlVideoContentGraph,
} from "./content-graph";

export interface RenderedFrame {
  sceneIndex: number;
  id: string;
  htmlPath: string;
  videoPath: string;
  durationSec: number;
  templateId: string;
  detectedMotionSec: number;
}

export interface HtmlRenderMetrics extends HtmlRenderBudget {
  browserStartupMs: number;
  cacheHitScenes: number[];
  renderedScenes: number[];
  perSceneRecordMs: Record<string, number>;
  perSceneEncodeMs: Record<string, number>;
  concatMs: number;
  muxMs: number;
  totalRenderMs: number;
}

export interface HtmlVideoRenderResult {
  outputPath: string;
  graphPath: string;
  frames: RenderedFrame[];
  remuxedVideo: boolean;
  metrics: HtmlRenderMetrics;
}

type HtmlBrowser = Pick<Browser, "newContext" | "close">;

export interface SceneRecordResult {
  detectedMotionSec: number;
  recordMs: number;
  encodeMs: number;
}

export interface SceneRecordInput {
  sceneIndex: number;
  browser: HtmlBrowser;
  htmlPath: string;
  outputPath: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  ffmpegThreads: number;
  encodingPreset: HtmlRenderBudget["encodingPreset"];
  signal?: AbortSignal;
}

export interface HtmlVideoRenderOptions {
  workDir?: string;
  forceSceneIndexes?: number[];
  remuxOnly?: boolean;
  signal?: AbortSignal;
  browserLauncher?: () => Promise<HtmlBrowser>;
  sceneRecorder?: (input: SceneRecordInput) => Promise<SceneRecordResult>;
  concatRenderer?: (frames: RenderedFrame[], outputPath: string, signal?: AbortSignal) => Promise<void>;
  audioMuxer?: (project: VideoProject, videoPath: string, outputPath: string, signal?: AbortSignal) => Promise<void>;
  renderBudget?: HtmlRenderBudget;
  cacheFingerprint?: Partial<HtmlVideoCacheFingerprint>;
}

export interface HtmlVideoCacheFingerprint {
  assetContentHash: string;
  fontBundleHash: string;
  globalCssHash: string;
  browserVersion: string;
  encoderProfile: string;
  rendererVersion: string;
}

const HTML_RENDERER_VERSION = "scene-gen-html-renderer-v2";
let browserVersionPromise: Promise<string> | undefined;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}

export class HtmlSceneRenderError extends Error {
  constructor(readonly sceneIndex: number, cause: unknown) {
    super(`HTML scene ${sceneIndex} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

export function createHtmlVideoCacheKey(input: {
  scene: VideoScene;
  templateId: string;
  templateVersion: string;
  variantId: string;
  width: number;
  height: number;
  fps: number;
  assetContentHash?: string;
  fontBundleHash?: string;
  globalCssHash?: string;
  browserVersion?: string;
  encoderProfile?: string;
  rendererVersion?: string;
}) {
  const scene = { ...input.scene, duration: undefined };
  return createHash("sha256").update(JSON.stringify(stableValue({
    scene,
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    variantId: input.variantId,
    width: input.width,
    height: input.height,
    fps: input.fps,
    assetContentHash: input.assetContentHash ?? "none",
    fontBundleHash: input.fontBundleHash ?? "none",
    globalCssHash: input.globalCssHash ?? "none",
    browserVersion: input.browserVersion ?? "unknown",
    encoderProfile: input.encoderProfile ?? "default",
    rendererVersion: input.rendererVersion ?? HTML_RENDERER_VERSION,
  }))).digest("hex");
}

function hashValues(values: unknown[]) {
  return createHash("sha256").update(JSON.stringify(stableValue(values))).digest("hex");
}

async function hashDirectory(directory: string) {
  const files: string[] = [];
  async function visit(current: string) {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  }
  await visit(directory);
  const hashes = await Promise.all(files.sort().map(async (filePath) => [path.relative(directory, filePath), await hashFileContent(filePath)]));
  return hashValues(hashes);
}

function localAssetPath(src: string) {
  if (/^file:/i.test(src)) return fileURLToPath(src);
  if (/^(https?:|data:)/i.test(src)) return undefined;
  if (path.isAbsolute(src)) return src;
  return fromRoot("public", src.replace(/^\/+/, ""));
}

async function resolveCacheFingerprint(html: string, budget: HtmlRenderBudget, overrides: Partial<HtmlVideoCacheFingerprint> = {}) {
  browserVersionPromise ??= (async () => {
    const playwrightPackage: { version?: string } = await readFile(fromRoot("node_modules", "playwright", "package.json"), "utf8")
      .then((raw) => JSON.parse(raw) as { version?: string }).catch(() => ({}));
    const executablePath = await import("playwright").then((module) => module.chromium.executablePath()).catch(() => "");
    const chromiumHash = executablePath && existsSync(executablePath) ? await hashFileContent(executablePath) : "missing";
    return `${playwrightPackage.version ?? "unknown"}:${chromiumHash}`;
  })();
  const globalCssPath = fromRoot("src", "remotion", "styles.css");
  return {
    assetContentHash: overrides.assetContentHash ?? await hashHtmlAssetContent(html),
    fontBundleHash: overrides.fontBundleHash ?? await hashDirectory(fromRoot("public", "fonts")),
    globalCssHash: overrides.globalCssHash ?? hashValues([html, existsSync(globalCssPath) ? await hashFileContent(globalCssPath) : "missing"]),
    browserVersion: overrides.browserVersion ?? await browserVersionPromise,
    encoderProfile: overrides.encoderProfile ?? `${budget.encodingPreset}:crf20:threads${budget.ffmpegThreadsPerJob}`,
    rendererVersion: overrides.rendererVersion ?? HTML_RENDERER_VERSION,
  } satisfies HtmlVideoCacheFingerprint;
}

export async function hashHtmlAssetContent(html: string) {
  const assetSources = [...html.matchAll(/\bsrc=["']([^"']+)["']/g)].map((match) => match[1]);
  const assets = await Promise.all([...new Set(assetSources)].sort().map(async (src) => {
    const filePath = localAssetPath(src);
    return [src, filePath && existsSync(filePath) ? await hashFileContent(filePath) : hashValues([src])];
  }));
  return hashValues(assets);
}

function run(command: string, args: string[], signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error(`${command} aborted.`));
      return;
    }
    const proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stderr = "";
    let settled = false;
    const onAbort = () => {
      if (!proc.killed) proc.kill();
      if (!settled) reject(signal?.reason instanceof Error ? signal.reason : new Error(`${command} aborted.`));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    proc.on("exit", (code) => {
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolve();
      else if (!signal?.aborted) reject(new Error(`${command} exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

function ffmpeg(args: string[], signal?: AbortSignal) {
  return run("ffmpeg", args, signal);
}

function publicAssetFileUrl(src: string) {
  if (/^(https?:|file:|data:)/i.test(src)) return src;
  const clean = src.replace(/^\/+/, "");
  return pathToFileURL(fromRoot("public", clean)).href;
}

function rewritePublicAssetUrls(html: string) {
  return html.replace(/\bsrc=(["'])(\/[^"']+)\1/g, (_match, quote: string, src: string) => {
    return `src=${quote}${publicAssetFileUrl(src)}${quote}`;
  });
}

async function waitForFonts(page: {
  evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
}) {
  await page
    .evaluate(
      () =>
        new Promise<void>((resolve) => {
          const fonts = document.fonts;
          const finish = () => requestAnimationFrame(() => requestAnimationFrame(() => {
            document.body?.getBoundingClientRect();
            resolve();
          }));
          if (!fonts?.ready) {
            finish();
            return;
          }
          const timer = setTimeout(finish, 8000);
          Promise.all([...fonts].map((face) => face.load().catch(() => undefined)))
            .then(() => fonts.ready)
            .then(() => {
              clearTimeout(timer);
              finish();
            })
            .catch(() => {
              clearTimeout(timer);
              finish();
            });
        }),
    )
    .catch(() => undefined);
}

async function recordHtmlFrame({
  browser,
  htmlPath,
  outputPath,
  durationSec,
  width,
  height,
  fps,
  ffmpegThreads,
  encodingPreset,
  signal,
}: SceneRecordInput): Promise<SceneRecordResult> {
  const recordDir = await mkdtemp(path.join(tmpdir(), "scene-gen-html-video-"));
  let context: Awaited<ReturnType<HtmlBrowser["newContext"]>> | undefined;
  let leadInMs = 0;
  let detectedMotionSec = 0;
  let captureError: unknown;
  const recordStarted = Date.now();
  const onAbort = () => { void context?.close().catch(() => undefined); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const recordStart = Date.now();
    context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      recordVideo: { dir: recordDir, size: { width, height } },
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const style = document.createElement("style");
      style.id = "__sg_freeze";
      style.textContent =
        "*,*::before,*::after{animation-play-state:paused!important;transition:none!important}";
      const attach = () => (document.head || document.documentElement).appendChild(style);
      if (document.head || document.documentElement) attach();
      else document.addEventListener("DOMContentLoaded", attach, { once: true });
      const pauseSvg = () => document.querySelectorAll("svg").forEach((svg) => svg.pauseAnimations?.());
      const resumeSvg = () => document.querySelectorAll("svg").forEach((svg) => svg.unpauseAnimations?.());
      document.addEventListener("DOMContentLoaded", pauseSvg, { once: true });
      (window as unknown as { __sgUnfreeze?: () => void }).__sgUnfreeze = () => {
        document.getElementById("__sg_freeze")?.remove();
        resumeSvg();
      };
    });

    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "domcontentloaded" });
    await waitForFonts(page);
    detectedMotionSec = await page.evaluate(() => {
      const durations = document.getAnimations().map((animation) => {
        const timing = animation.effect?.getComputedTiming();
        return typeof timing?.endTime === "number" && Number.isFinite(timing.endTime) ? timing.endTime / 1000 : 0;
      });
      return durations.length ? Math.max(...durations) : 0;
    }).catch(() => 0);
    if (detectedMotionSec > durationSec + 0.25) {
      console.warn(`[html-video] motion ${detectedMotionSec.toFixed(2)}s exceeds scene ${durationSec.toFixed(2)}s; scene timing remains narration-led`);
    }
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      (window as unknown as { __sgUnfreeze?: () => void }).__sgUnfreeze?.();
    });
    leadInMs = Date.now() - recordStart;
    await page.waitForTimeout(Math.max(500, Math.round(durationSec * 1000)));
    await context.close();
    context = undefined;
  } catch (error) {
    captureError = error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (context) await context.close().catch(() => undefined);
  }
  if (captureError) {
    await rm(recordDir, { recursive: true, force: true }).catch(() => undefined);
    throw captureError;
  }
  const recordMs = Date.now() - recordStarted;

  const webmFiles = (await import("node:fs")).readdirSync(recordDir).filter((file) => file.endsWith(".webm"));
  if (webmFiles.length === 0) {
    await rm(recordDir, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(`Playwright produced no webm for ${htmlPath}`);
  }
  webmFiles.sort();
  const webmPath = path.join(recordDir, webmFiles[webmFiles.length - 1]);
  const seekSec = leadInMs > 200 ? Math.max(0, (leadInMs - 120) / 1000) : 0;
  const encodeStarted = Date.now();
  try {
    await ffmpeg([
      "-y",
      ...(seekSec > 0 ? ["-ss", seekSec.toFixed(3)] : []),
      "-i",
      webmPath,
      "-vf",
      `tpad=stop_mode=clone:stop_duration=${durationSec}`,
      "-t",
      String(durationSec),
      "-r",
      String(fps),
      "-c:v",
      "libx264",
      "-threads",
      String(ffmpegThreads),
      "-pix_fmt",
      "yuv420p",
      "-preset",
      encodingPreset,
      "-crf",
      "20",
      "-movflags",
      "+faststart",
      outputPath,
    ], signal);
  } finally {
    await rm(recordDir, { recursive: true, force: true }).catch(() => undefined);
  }
  return { detectedMotionSec, recordMs, encodeMs: Date.now() - encodeStarted };
}

function concatFileLine(filePath: string) {
  return `file '${filePath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
}

async function concatFrames(frames: RenderedFrame[], outputPath: string, signal?: AbortSignal) {
  const listPath = path.join(path.dirname(outputPath), "concat-list.txt");
  await writeFile(listPath, `${frames.map((frame) => concatFileLine(frame.videoPath)).join("\n")}\n`, "utf8");
  await ffmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outputPath], signal);
}

function resolveAudioPath(project: VideoProject) {
  const src = project.audio?.src;
  if (!src) return null;
  if (path.isAbsolute(src)) return src;
  return fromRoot("public", src.replace(/^\/+/, ""));
}

async function muxAudio(project: VideoProject, videoPath: string, outputPath: string, signal?: AbortSignal) {
  const audioPath = resolveAudioPath(project);
  if (!audioPath || !existsSync(audioPath)) {
    await ffmpeg(["-y", "-i", videoPath, "-c", "copy", "-movflags", "+faststart", outputPath], signal);
    return;
  }
  const duration = String(project.meta.durationSeconds);
  await ffmpeg([
    "-y",
    "-i",
    videoPath,
    "-i",
    audioPath,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-af",
    "apad",
    "-t",
    duration,
    "-movflags",
    "+faststart",
    outputPath,
  ], signal);
}

export async function writeHtmlVideoContentGraph(project: VideoProject, graphPath: string) {
  const graph = buildHtmlVideoContentGraph(project);
  await ensureDir(path.dirname(graphPath));
  await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
  return graph;
}

export async function renderHtmlVideoProject(
  project: VideoProject,
  outputPath: string,
  options: HtmlVideoRenderOptions = {},
): Promise<HtmlVideoRenderResult> {
  const totalStarted = Date.now();
  const slug = slugify(project.meta.title, "story");
  const workDir = options.workDir ?? fromRoot("public", "generated", "html-video", slug);
  await ensureDir(workDir);
  await ensureDir(path.dirname(outputPath));

  const graphPath = path.join(workDir, "content-graph.json");
  const graph: HtmlVideoContentGraph = await writeHtmlVideoContentGraph(project, graphPath);
  const frames: RenderedFrame[] = [];
  const silentVideoPath = path.join(workDir, "video-no-audio.mp4");
  const finalTemp = path.join(workDir, "final.mp4");
  const budget = options.renderBudget ?? resolveHtmlRenderBudget(project.scenes.length);
  const metrics: HtmlRenderMetrics = {
    ...budget,
    browserStartupMs: 0,
    cacheHitScenes: [],
    renderedScenes: [],
    perSceneRecordMs: {},
    perSceneEncodeMs: {},
    concatMs: 0,
    muxMs: 0,
    totalRenderMs: 0,
  };
  const concatRenderer = options.concatRenderer ?? concatFrames;
  const audioMuxer = options.audioMuxer ?? muxAudio;

  if (options.remuxOnly) {
    if (!existsSync(silentVideoPath)) throw new Error(`Cannot remux audio because the silent video is missing: ${silentVideoPath}`);
    const muxStarted = Date.now();
    await audioMuxer(project, silentVideoPath, finalTemp, options.signal);
    metrics.muxMs = Date.now() - muxStarted;
    await rm(outputPath, { force: true }).catch(() => undefined);
    await (await import("node:fs/promises")).copyFile(finalTemp, outputPath);
    console.log(`[html-video] remuxed audio into ${outputPath}`);
    metrics.totalRenderMs = Date.now() - totalStarted;
    return { outputPath, graphPath, frames, remuxedVideo: true, metrics };
  }

  const nodeOrder = topoSortHtmlVideoGraph(graph);
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const prepared: Array<{
    node: HtmlVideoContentGraph["nodes"][number];
    htmlPath: string;
    videoPath: string;
    cachePath: string;
    cacheKey: string;
    cacheIdentity: Record<string, unknown>;
    templateId: string;
    cachedFrame?: RenderedFrame;
  }> = [];
  for (const nodeId of nodeOrder) {
    const node = nodesById.get(nodeId);
    if (!node) continue;
    const scene = project.scenes[node.sceneIndex];
    const template = getTemplateById(node.templateId);
    if (!template) throw new Error(`Template ${node.templateId} was selected but is not registered.`);
    const html = rewritePublicAssetUrls(
      template.renderHtml({
        project,
        scene,
        sceneIndex: node.sceneIndex,
        width: project.meta.width,
        height: project.meta.height,
        variantId: node.variantId,
      }),
    );
    const htmlPath = path.join(workDir, `${node.id}-${template.id}.html`);
    const videoPath = path.join(workDir, `${node.id}-${template.id}.mp4`);
    const cachePath = `${videoPath}.cache.json`;
    const fingerprint = await resolveCacheFingerprint(html, budget, options.cacheFingerprint);
    const cacheIdentity = {
      scene: { ...scene, duration: undefined },
      templateId: node.templateId,
      templateVersion: template.version,
      variantId: node.variantId,
      width: project.meta.width,
      height: project.meta.height,
      fps: project.meta.fps,
      ...fingerprint,
    };
    const cacheKey = createHtmlVideoCacheKey({
      scene,
      templateId: node.templateId,
      templateVersion: template.version,
      variantId: node.variantId,
      width: project.meta.width,
      height: project.meta.height,
      fps: project.meta.fps,
      ...fingerprint,
    });
    await writeFile(htmlPath, html, "utf8");
    let cachedFrame: RenderedFrame | undefined;
    if (!options.forceSceneIndexes?.includes(node.sceneIndex)) {
      const cached = await restoreMediaCache({ kind: "video-scene", cacheKey, extension: ".mp4", targetPath: videoPath });
      if (cached) {
        const detectedMotionSec = typeof cached.details.detectedMotionSec === "number" ? cached.details.detectedMotionSec : 0;
        const cachedDuration = typeof cached.details.durationSec === "number" ? cached.details.durationSec : node.durationSec;
        if (Math.abs(cachedDuration - node.durationSec) > 0.001) {
          const adjustedPath = `${videoPath}.adjusted.mp4`;
          const ratio = node.durationSec / cachedDuration;
          const encodeStarted = Date.now();
          try {
            await ffmpeg(["-y", "-i", videoPath, "-vf", `setpts=${ratio.toFixed(9)}*PTS,tpad=stop_mode=clone:stop_duration=1`, "-t", String(node.durationSec), "-r", String(project.meta.fps), "-c:v", "libx264", "-threads", String(budget.ffmpegThreadsPerJob), "-pix_fmt", "yuv420p", "-preset", budget.encodingPreset, "-crf", "20", adjustedPath], options.signal);
          } catch (error) {
            await rm(adjustedPath, { force: true }).catch(() => undefined);
            throw new HtmlSceneRenderError(node.sceneIndex, error);
          }
          metrics.perSceneEncodeMs[String(node.sceneIndex)] = Date.now() - encodeStarted;
          await rm(videoPath, { force: true });
          await (await import("node:fs/promises")).rename(adjustedPath, videoPath);
          console.log(`[html-video] retiming ${node.id} from ${cachedDuration.toFixed(3)}s to ${node.durationSec.toFixed(3)}s`);
        } else {
          console.log(`[html-video] reusing ${node.id} with ${template.id}:${node.variantId}`);
        }
        await writeFile(cachePath, JSON.stringify({ cacheKey, detectedMotionSec, durationSec: node.durationSec }), "utf8");
        metrics.cacheHitScenes.push(node.sceneIndex);
        cachedFrame = { sceneIndex: node.sceneIndex, id: node.id, htmlPath, videoPath, durationSec: node.durationSec, templateId: template.id, detectedMotionSec };
      }
    }
    prepared.push({ node, htmlPath, videoPath, cachePath, cacheKey, cacheIdentity, templateId: template.id, cachedFrame });
  }

  const misses = prepared.filter((item) => !item.cachedFrame);
  const renderedByScene = new Map<number, RenderedFrame>();
  let browser: HtmlBrowser | undefined;
  let browserPromise: Promise<HtmlBrowser> | undefined;
  if (misses.length) {
    const launchBrowser = options.browserLauncher ?? (async () => {
      const playwright = await import("playwright");
      return playwright.chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"] });
    });
    const ensureBrowser = async () => {
      browserPromise ??= (async () => {
        const browserStarted = Date.now();
        browser = await launchBrowser();
        metrics.browserStartupMs = Date.now() - browserStarted;
        return browser;
      })();
      return browserPromise;
    };
    const sceneRecorder = options.sceneRecorder ?? recordHtmlFrame;
    try {
      const rendered = await mapWithConcurrencyUntilError(misses, budget.renderConcurrency, async (item, _index, queueSignal) => {
        const sceneTimeoutMs = Math.max(1_000, Number(process.env.HTML_RENDER_SCENE_TIMEOUT_MS ?? 300_000));
        const sceneSignal = AbortSignal.any([queueSignal, AbortSignal.timeout(sceneTimeoutMs)]);
        console.log(`[html-video] recording ${item.node.id} with ${item.templateId}:${item.node.variantId}`);
        try {
          const cacheResult = await getOrCreateMediaCache({
            kind: "video-scene",
            cacheKey: item.cacheKey,
            extension: ".mp4",
            targetPath: item.videoPath,
            identity: item.cacheIdentity,
            force: options.forceSceneIndexes?.includes(item.node.sceneIndex),
            signal: sceneSignal,
            details: { durationSec: item.node.durationSec },
            generate: async (cacheOutputPath) => {
              const recorded = await sceneRecorder({
                sceneIndex: item.node.sceneIndex, browser: await ensureBrowser(), htmlPath: item.htmlPath, outputPath: cacheOutputPath,
                durationSec: item.node.durationSec, width: project.meta.width, height: project.meta.height,
                fps: project.meta.fps, ffmpegThreads: budget.ffmpegThreadsPerJob,
                encodingPreset: budget.encodingPreset, signal: sceneSignal,
              });
              metrics.perSceneRecordMs[String(item.node.sceneIndex)] = recorded.recordMs;
              metrics.perSceneEncodeMs[String(item.node.sceneIndex)] = recorded.encodeMs;
              return { detectedMotionSec: recorded.detectedMotionSec, durationSec: item.node.durationSec };
            },
          });
          const detectedMotionSec = typeof cacheResult.metadata.details.detectedMotionSec === "number"
            ? cacheResult.metadata.details.detectedMotionSec
            : 0;
          await writeFile(item.cachePath, JSON.stringify({ cacheKey: item.cacheKey, detectedMotionSec, durationSec: item.node.durationSec }), "utf8");
          (cacheResult.generated ? metrics.renderedScenes : metrics.cacheHitScenes).push(item.node.sceneIndex);
          return { sceneIndex: item.node.sceneIndex, id: item.node.id, htmlPath: item.htmlPath, videoPath: item.videoPath, durationSec: item.node.durationSec, templateId: item.templateId, detectedMotionSec } satisfies RenderedFrame;
        } catch (error) {
          await rm(item.cachePath, { force: true }).catch(() => undefined);
          await rm(item.videoPath, { force: true }).catch(() => undefined);
          throw new HtmlSceneRenderError(item.node.sceneIndex, error);
        }
      }, options.signal);
      for (const frame of rendered) renderedByScene.set(frame.sceneIndex, frame);
    } finally {
      await browser?.close().catch(() => undefined);
      browser = undefined;
    }
  }

  frames.push(...prepared.map((item) => item.cachedFrame ?? renderedByScene.get(item.node.sceneIndex)).filter((frame): frame is RenderedFrame => Boolean(frame)));
  if (frames.length !== prepared.length) throw new Error(`HTML render produced ${frames.length}/${prepared.length} scene videos.`);
  const concatStarted = Date.now();
  await concatRenderer(frames, silentVideoPath, options.signal);
  metrics.concatMs = Date.now() - concatStarted;
  const muxStarted = Date.now();
  await audioMuxer(project, silentVideoPath, finalTemp, options.signal);
  metrics.muxMs = Date.now() - muxStarted;
  await ensureDir(path.dirname(outputPath));
  await rm(outputPath, { force: true }).catch(() => undefined);
  await (await import("node:fs/promises")).copyFile(finalTemp, outputPath);
  const info = await stat(outputPath);
  console.log(`[html-video] rendered ${outputPath} (${info.size} bytes)`);
  metrics.cacheHitScenes.sort((left, right) => left - right);
  metrics.renderedScenes.sort((left, right) => left - right);
  metrics.totalRenderMs = Date.now() - totalStarted;
  return { outputPath, graphPath, frames, remuxedVideo: false, metrics };
}
