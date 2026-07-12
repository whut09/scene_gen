import path from "node:path";
import { buildProductionReport } from "./production-report";
import type { VideoProject } from "../pipeline/types";
import { fromRoot, loadDotEnv, parseArgs, readJson, writeJson } from "../pipeline/utils";

loadDotEnv();
const args = parseArgs(process.argv.slice(2));
if (typeof args.project !== "string") throw new Error('Usage: npm run production:inspect -- --project "public/generated/stories/story.json"');
const projectPath = path.resolve(fromRoot(), args.project);
const project = await readJson<VideoProject>(projectPath);
const engine = typeof args.engine === "string" ? args.engine : process.env.VIDEO_RENDER_ENGINE ?? "html-video";
const report = buildProductionReport(project, engine);
const outputPath = typeof args.out === "string" ? path.resolve(args.out) : path.join(path.dirname(projectPath), path.basename(projectPath, ".json") + ".production-report.json");
await writeJson(outputPath, report);
console.log("[production] report: " + outputPath);
console.log("[production] visual mix: " + JSON.stringify(report.summary.sourceMix));
console.log("[production] enabled providers: " + report.summary.enabledProviders.join(", "));
