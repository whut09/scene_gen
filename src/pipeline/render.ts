import type { VideoProject } from "./types";
import { bundleRemotion, renderProject } from "./render-core";
import { fromRoot, loadDotEnv, parseArgs, readJson } from "./utils";
import { videoProjectSchema } from "./schemas";

loadDotEnv();

const args = parseArgs(process.argv.slice(2));
const projectPath = typeof args.project === "string" ? args.project : fromRoot("public", "generated", "project.json");
const outputPath = typeof args.out === "string" ? args.out : fromRoot("dist", "ai-news.mp4");
const project = videoProjectSchema.parse(await readJson<unknown>(projectPath)) as VideoProject;
const serveUrl = await bundleRemotion();

await renderProject(project, outputPath, serveUrl);
