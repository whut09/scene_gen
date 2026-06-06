import type { VideoProject } from "./types";
import { bundleRemotion, renderProject } from "./render-core";
import { fromRoot, loadDotEnv, parseArgs, readJson } from "./utils";

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
const manifestPath =
  typeof args.manifest === "string"
    ? args.manifest
    : fromRoot("public", "generated", "stories", "manifest.json");
const limit = args.limit ? Number(args.limit) : undefined;
const manifest = await readJson<StoryManifestItem[]>(manifestPath);
const stories = typeof limit === "number" ? manifest.slice(0, limit) : manifest;
const serveUrl = await bundleRemotion();

for (const story of stories) {
  const project = await readJson<VideoProject>(story.projectPath);
  await renderProject(project, story.outputPath, serveUrl);
}

console.log(`Rendered ${stories.length} story videos.`);
