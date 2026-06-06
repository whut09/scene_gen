import { mkdir, readdir, copyFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { NEWS_STORY } from "../src/chapters/url-news/story-data";

const chapters = NEWS_STORY.chapters.map((chapter) => [
  chapter.id,
  chapter.steps.map((step) => step.narration),
] as const);

const root = resolve(".");
const outDir = resolve(root, "exports");
const tmpDir = resolve(outDir, "tmp");
const port = Number(process.env.PRESENTATION_PORT ?? 5174);
const url = `http://127.0.0.1:${port}/?capture=1`;
const finalMp4 = resolve(outDir, "glasswing-vertical.mp4");
const trackMp3 = resolve(tmpDir, "voice-track.mp3");
const silenceMp3 = resolve(tmpDir, "silence.mp3");
const videoWebm = resolve(tmpDir, "browser-recording.webm");

function run(command: string, args: string[], options: { quiet?: boolean } = {}) {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: options.quiet ? "ignore" : "inherit",
      shell: false,
    });
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with ${code}`));
    });
    child.on("error", reject);
  });
}

function spawnBackground(command: string, args: string[]) {
  return spawn(command, args, {
    cwd: root,
    stdio: "ignore",
    shell: false,
    detached: false,
  });
}

function output(command: string, args: string[]) {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code) => {
      if (code === 0) resolvePromise(stdout.trim());
      else reject(new Error(stderr || `${command} exited with ${code}`));
    });
    child.on("error", reject);
  });
}

async function durationSeconds(file: string) {
  const raw = await output("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  return Number(raw);
}

async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`dev server not reachable on port ${port}`);
}

async function ensureServer() {
  try {
    await waitForServer();
    return null;
  } catch {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawnBackground(npm, ["run", "dev", "--", "--port", String(port)]);
    await waitForServer();
    return child;
  }
}

async function makeAudioTrack(segments: { file: string; duration: number }[]) {
  await run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=44100:cl=mono",
    "-t",
    "0.2",
    "-q:a",
    "9",
    "-acodec",
    "libmp3lame",
    silenceMp3,
  ], { quiet: true });

  const listPath = resolve(tmpDir, "audio-list.txt");
  const lines: string[] = [];
  for (const segment of segments) {
    lines.push(`file '${segment.file.replaceAll("\\", "/")}'`);
    lines.push(`file '${silenceMp3.replaceAll("\\", "/")}'`);
  }
  await writeFile(listPath, lines.join("\n") + "\n", "utf8");
  await run("ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c",
    "copy",
    trackMp3,
  ], { quiet: true });
}

async function main() {
  await mkdir(outDir, { recursive: true });
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });

  const devServer = await ensureServer();

  const segments: { chapter: string; step: number; file: string; duration: number }[] = [];
  for (const [chapter, narrations] of chapters) {
    for (let index = 0; index < narrations.length; index++) {
      const file = resolve(root, "public", "audio", chapter, `${index + 1}.mp3`);
      if (!existsSync(file)) throw new Error(`missing audio: ${file}`);
      segments.push({
        chapter,
        step: index + 1,
        file,
        duration: await durationSeconds(file),
      });
    }
  }

  await makeAudioTrack(segments);

  const browser = await chromium.launch({
    headless: true,
    executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  });
  const context = await browser.newContext({
    viewport: { width: 1080, height: 1920 },
    recordVideo: {
      dir: tmpDir,
      size: { width: 1080, height: 1920 },
    },
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    console.log(
      `record ${index + 1}/${segments.length}: ${segment.chapter}/${segment.step} ${segment.duration.toFixed(2)}s`,
    );
    await page.waitForTimeout(Math.round(segment.duration * 1000) + 200);
    if (index < segments.length - 1) await page.keyboard.press("ArrowRight");
  }
  await page.waitForTimeout(500);

  const video = page.video();
  await context.close();
  await browser.close();
  const recorded = video ? await video.path() : null;
  if (!recorded) throw new Error("browser did not produce a video");
  await copyFile(recorded, videoWebm);

  await run("ffmpeg", [
    "-y",
    "-i",
    videoWebm,
    "-i",
    trackMp3,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    finalMp4,
  ]);

  const size = (await readdir(dirname(finalMp4))).includes("glasswing-vertical.mp4");
  if (!size) throw new Error("final mp4 missing");
  console.log(`exported: ${finalMp4}`);
  devServer?.kill();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
