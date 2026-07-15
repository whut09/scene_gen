import path from "node:path";
import type { VideoProject } from "./types";
import { HtmlSceneRenderError, renderHtmlVideoProject } from "../html-video/render-html-video";
import { bundleRemotion, renderProject } from "./render-core";
import { fromRoot, loadDotEnv, parseArgs, readJson, writeJsonAtomic } from "./utils";
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
const forceRender = Boolean(args["force-render"]);
const remuxOnly = Boolean(args["remux-only"]);
const forceSceneIndexes = forceRender
  ? undefined
  : typeof args["force-scenes"] === "string"
    ? [...new Set(args["force-scenes"].split(",").map(Number).filter((value) => Number.isInteger(value) && value >= 0))]
    : [];
const manifest = await readStoryManifest(manifestPath);
const stories = typeof limit === "number" ? manifest.slice(0, limit) : manifest;
const serveUrl = engine === "html-video" ? null : await bundleRemotion();
const renderResults: Array<{ outputPath: string; visualAuditPath?: string; metrics?: unknown }> = [];
const controller = new AbortController();
const cancel = () => controller.abort(new Error("HTML render process cancelled."));
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

try {
  for (const story of stories) {
    const project = videoProjectSchema.parse(await readJson<unknown>(story.projectPath)) as VideoProject;
    if (engine === "html-video") {
      const outputPath = overwrite ? story.outputPath : story.outputPath.replace(/\.mp4$/i, ".html-video.mp4");
      const result = await renderHtmlVideoProject(project, outputPath, {
        workDir: story.htmlVideoGraphPath ? path.dirname(story.htmlVideoGraphPath) : undefined,
        forceSceneIndexes: forceRender ? project.scenes.map((_, index) => index) : forceSceneIndexes,
        remuxOnly,
        signal: controller.signal,
      });
      renderResults.push({ outputPath, visualAuditPath: result.visualAuditPath, metrics: result.metrics });
    } else {
      await renderProject(project, story.outputPath, serveUrl as string);
      renderResults.push({ outputPath: story.outputPath });
    }
  }
} catch (error) {
  if (typeof args.result === "string") {
    await writeJsonAtomic(path.resolve(args.result), {
      engine,
      stories: renderResults,
      failedSceneIndex: error instanceof HtmlSceneRenderError ? error.sceneIndex : undefined,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  throw error;
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}

if (typeof args.result === "string") await writeJsonAtomic(path.resolve(args.result), { engine, stories: renderResults });

console.log(`Rendered ${stories.length} story videos with ${engine}.`);
