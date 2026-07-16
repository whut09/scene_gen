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

const result = await appendFeedback({
  createdAt: new Date().toISOString(),
  category: typeof args.category === "string" ? args.category : "general",
  severity,
  issue: args.issue,
  desired: typeof args.desired === "string" ? args.desired : undefined,
  url: typeof args.url === "string" ? args.url : undefined,
  videoPath: typeof args.video === "string" ? args.video : undefined,
  appliesTo: typeof args["applies-to"] === "string" ? args["applies-to"].split(",").map((item) => item.trim()).filter(Boolean) : undefined,
  contentDomains: typeof args["content-domains"] === "string" ? args["content-domains"].split(",").map((item) => item.trim()).filter(Boolean) : undefined,
  templateIds: typeof args["template-ids"] === "string" ? args["template-ids"].split(",").map((item) => item.trim()).filter(Boolean) : undefined,
  providerIds: typeof args["provider-ids"] === "string" ? args["provider-ids"].split(",").map((item) => item.trim()).filter(Boolean) : undefined,
  conflictsWith: typeof args["conflicts-with"] === "string" ? args["conflicts-with"].split(",").map((item) => item.trim()).filter(Boolean) : undefined,
  minimumConfidence: typeof args["minimum-confidence"] === "string" ? Number(args["minimum-confidence"]) : undefined,
  expiresAt: typeof args["expires-at"] === "string" ? args["expires-at"] : undefined,
  enabled: !args.disabled,
  resolvedAt: args.resolved ? new Date().toISOString() : undefined,
});

console.log(`Feedback ${result.deduplicated ? "deduplicated" : "saved"}: ${result.filePath} (${result.entry.fingerprint})`);
