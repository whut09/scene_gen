import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { VideoProject } from "../pipeline/types";
import { ensureDir, fromRoot, slugify } from "../pipeline/utils";
import { getTemplateById } from "../templates/template-registry";
import {
  buildHtmlVideoContentGraph,
  topoSortHtmlVideoGraph,
  type HtmlVideoContentGraph,
} from "./content-graph";

interface RenderedFrame {
  id: string;
  htmlPath: string;
  videoPath: string;
  durationSec: number;
  templateId: string;
  detectedMotionSec: number;
}

export interface HtmlVideoRenderResult {
  outputPath: string;
  graphPath: string;
  frames: RenderedFrame[];
}

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

function ffmpeg(args: string[]) {
  return run("ffmpeg", args);
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
  htmlPath,
  outputPath,
  durationSec,
  width,
  height,
  fps,
}: {
  htmlPath: string;
  outputPath: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
}) {
  const playwright = await import("playwright");
  const recordDir = await mkdtemp(path.join(tmpdir(), "scene-gen-html-video-"));
  let browser: Awaited<ReturnType<typeof playwright.chromium.launch>> | undefined;
  let leadInMs = 0;
  let detectedMotionSec = 0;
  try {
    browser = await playwright.chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
    });
    const recordStart = Date.now();
    const context = await browser.newContext({
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
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }

  const webmFiles = (await import("node:fs")).readdirSync(recordDir).filter((file) => file.endsWith(".webm"));
  if (webmFiles.length === 0) {
    await rm(recordDir, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(`Playwright produced no webm for ${htmlPath}`);
  }
  webmFiles.sort();
  const webmPath = path.join(recordDir, webmFiles[webmFiles.length - 1]);
  const seekSec = leadInMs > 200 ? Math.max(0, (leadInMs - 120) / 1000) : 0;
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
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-movflags",
    "+faststart",
    outputPath,
  ]);
  await rm(recordDir, { recursive: true, force: true }).catch(() => undefined);
  return detectedMotionSec;
}

function concatFileLine(filePath: string) {
  return `file '${filePath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
}

async function concatFrames(frames: RenderedFrame[], outputPath: string) {
  const listPath = path.join(path.dirname(outputPath), "concat-list.txt");
  await writeFile(listPath, `${frames.map((frame) => concatFileLine(frame.videoPath)).join("\n")}\n`, "utf8");
  await ffmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outputPath]);
}

function resolveAudioPath(project: VideoProject) {
  const src = project.audio?.src;
  if (!src) return null;
  if (/^[A-Za-z]:[\\/]/.test(src)) return src;
  return fromRoot("public", src.replace(/^\/+/, ""));
}

async function muxAudio(project: VideoProject, videoPath: string, outputPath: string) {
  const audioPath = resolveAudioPath(project);
  if (!audioPath || !existsSync(audioPath)) {
    await ffmpeg(["-y", "-i", videoPath, "-c", "copy", "-movflags", "+faststart", outputPath]);
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
  ]);
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
): Promise<HtmlVideoRenderResult> {
  const slug = slugify(project.meta.title, "story");
  const workDir = fromRoot("public", "generated", "html-video", slug);
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  await ensureDir(workDir);
  await ensureDir(path.dirname(outputPath));

  const graphPath = path.join(workDir, "content-graph.json");
  const graph: HtmlVideoContentGraph = await writeHtmlVideoContentGraph(project, graphPath);
  const frames: RenderedFrame[] = [];

  const nodeOrder = topoSortHtmlVideoGraph(graph);
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
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
      }),
    );
    const htmlPath = path.join(workDir, `${node.id}-${template.id}.html`);
    const videoPath = path.join(workDir, `${node.id}-${template.id}.mp4`);
    await writeFile(htmlPath, html, "utf8");
    console.log(`[html-video] recording ${node.id} with ${template.id}`);
    const detectedMotionSec = await recordHtmlFrame({
      htmlPath,
      outputPath: videoPath,
      durationSec: node.durationSec,
      width: project.meta.width,
      height: project.meta.height,
      fps: project.meta.fps,
    });
    frames.push({
      id: node.id,
      htmlPath,
      videoPath,
      durationSec: node.durationSec,
      templateId: template.id,
      detectedMotionSec,
    });
  }

  const silentVideoPath = path.join(workDir, "video-no-audio.mp4");
  const finalTemp = path.join(workDir, "final.mp4");
  await concatFrames(frames, silentVideoPath);
  await muxAudio(project, silentVideoPath, finalTemp);
  await ensureDir(path.dirname(outputPath));
  await rm(outputPath, { force: true }).catch(() => undefined);
  await (await import("node:fs/promises")).copyFile(finalTemp, outputPath);
  const info = await stat(outputPath);
  console.log(`[html-video] rendered ${outputPath} (${info.size} bytes)`);
  return { outputPath, graphPath, frames };
}
