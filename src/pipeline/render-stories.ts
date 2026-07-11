import type { VideoProject } from "./types";
import { renderHtmlVideoProject } from "../html-video/render-html-video";
import { bundleRemotion, renderProject } from "./render-core";
import { fromRoot, loadDotEnv, parseArgs, readJson } from "./utils";

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
const manifestPath =
  typeof args.manifest === "string"
    ? args.manifest
    : fromRoot("public", "generated", "stories", "manifest.json");
const limit = args.limit ? Number(args.limit) : undefined;
const engine = typeof args.engine === "string" ? args.engine : "remotion";
const overwrite = Boolean(args.overwrite);
const manifest = await readJson<StoryManifestItem[]>(manifestPath);
const stories = typeof limit === "number" ? manifest.slice(0, limit) : manifest;
const serveUrl = engine === "html-video" ? null : await bundleRemotion();

for (const story of stories) {
  const project = await readJson<VideoProject>(story.projectPath);
  if (engine === "html-video") {
    const outputPath = overwrite ? story.outputPath : story.outputPath.replace(/\.mp4$/i, ".html-video.mp4");
    await renderHtmlVideoProject(project, outputPath);
  } else {
    await renderProject(project, story.outputPath, serveUrl as string);
  }
}

console.log(`Rendered ${stories.length} story videos with ${engine}.`);
