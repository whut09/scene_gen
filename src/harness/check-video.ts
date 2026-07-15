import { loadDotEnv, parseArgs } from "../pipeline/utils";
import { runManualCheck } from "./manual-check";

loadDotEnv();
const args = parseArgs(process.argv.slice(2));
if (typeof args.project !== "string" || typeof args.video !== "string") throw new Error("Usage: npm run video:check -- --project <project.json> --video <video.mp4> [--seconds 100]");
const report = await runManualCheck({ projectPath: args.project, videoPath: args.video, targetSeconds: Number(args.seconds ?? 100) });
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 2;
