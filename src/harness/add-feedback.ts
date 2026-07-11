import { appendFeedback, type FeedbackSeverity } from "./feedback-store";
import { loadDotEnv, parseArgs } from "../pipeline/utils";

loadDotEnv();
const args = parseArgs(process.argv.slice(2));
if (typeof args.issue !== "string") {
  throw new Error(
    "Usage: npm run feedback:add -- --issue <问题> [--category title] [--severity high] [--desired <期望>]",
  );
}

const severity = (typeof args.severity === "string" ? args.severity : "medium") as FeedbackSeverity;
if (!(["low", "medium", "high", "critical"] as const).includes(severity)) {
  throw new Error(`Invalid severity: ${severity}`);
}

const filePath = await appendFeedback({
  createdAt: new Date().toISOString(),
  category: typeof args.category === "string" ? args.category : "general",
  severity,
  issue: args.issue,
  desired: typeof args.desired === "string" ? args.desired : undefined,
  url: typeof args.url === "string" ? args.url : undefined,
  videoPath: typeof args.video === "string" ? args.video : undefined,
});

console.log(`Feedback saved: ${filePath}`);