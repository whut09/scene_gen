import path from "node:path";
import type { VideoProject } from "./types";
import { renderHtmlVideoProject } from "../html-video/render-html-video";
import { bundleRemotion, renderProject } from "./render-core";
import { fromRoot, loadDotEnv, parseArgs, readJson } from "./utils";
import { readStoryManifest } from "./story-manifest";
import { videoProjectSchema } from "./schemas";

loadDotEnv();

const args = parseArgs(process.argv.slice(2));
const manifestPath =
  typeof args.manifest === "string"
    ? args.manifest
    : fromRoot("public", "generated", "stories", "manifest.json");
const limit = args.limit ? Number(args.limit) : undefined;
const engine = typeof args.engine === "string" ? args.engine : "remotion";
const overwrite = Boolean(args.overwrite);
const manifest = await readStoryManifest(manifestPath);
const stories = typeof limit === "number" ? manifest.slice(0, limit) : manifest;
const serveUrl = engine === "html-video" ? null : await bundleRemotion();

for (const story of stories) {
  const project = videoProjectSchema.parse(await readJson<unknown>(story.projectPath)) as VideoProject;
  if (engine === "html-video") {
    const outputPath = overwrite ? story.outputPath : story.outputPath.replace(/\.mp4$/i, ".html-video.mp4");
    await renderHtmlVideoProject(project, outputPath, {
      workDir: story.htmlVideoGraphPath ? path.dirname(story.htmlVideoGraphPath) : undefined,
    });
  } else {
    await renderProject(project, story.outputPath, serveUrl as string);
  }
}

console.log(`Rendered ${stories.length} story videos with ${engine}.`);
