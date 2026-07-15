import { appendFeedback, type FeedbackSeverity } from "../harness/feedback-store";
import { runManualCheck } from "../harness/manual-check";
import { runVideoAgent } from "../harness/video-agent";
import { applyConfigProfile, builtInProfileNames } from "../config/config-profiles";
import { formatDoctorReport, runDoctor } from "../doctor/doctor";
import { createExecutionPlan, formatExecutionPlan } from "../plan/plan";
import { defaultOutputDir } from "../runtime/runtime-paths";
import { fromRoot, loadDotEnv, readJson } from "../pipeline/utils";
import { commandHelp, parseStrictArgs, type CommandDefinition } from "./strict-args";
import { existsSync } from "node:fs";
import path from "node:path";
import { clearMediaCache, inspectMediaCache, pruneMediaCache } from "../cache/cache-manager";

const profileOption = { type: "string" as const, description: `Configuration profile (${builtInProfileNames.join(", ")} or config/profiles/<name>.json).` };
const jsonOption = { type: "boolean" as const, description: "Print machine-readable JSON." };
const runOptions = {
  url: { type: "string" as const, required: true, description: "Article or GitHub URL." },
  profile: profileOption,
  seconds: { type: "number" as const, description: "Target duration in seconds." },
  iterations: { type: "number" as const, description: "Maximum draft/audio loop iterations." },
  "video-iterations": { type: "number" as const, description: "Maximum render/video-gate attempts." },
  screenshots: { type: "number" as const, description: "Maximum webpage screenshots." },
  engine: { type: "string" as const, choices: ["html-video", "remotion"], description: "Rendering engine." },
  "out-dir": { type: "string" as const, description: "Final video output directory." },
  notes: { type: "string" as const, description: "Editorial constraints and factual notes." },
  "quality-profile": { type: "string" as const, choices: ["balanced", "strict", "lenient"], description: "Quality gate profile." },
  "ignore-cache": { type: "boolean" as const, description: "Ignore generated project cache." },
  "dry-run": { type: "boolean" as const, description: "Fetch and print an execution plan without generation." },
  "plan-only": { type: "boolean" as const, description: "Alias for --dry-run." },
};

const definitions: Record<string, CommandDefinition> = {
  doctor: { summary: "Check runtime dependencies, models, APIs, permissions and disk space.", options: { profile: profileOption, json: jsonOption, "out-dir": { type: "string", description: "Output directory to test." } } },
  plan: { summary: "Fetch an article and show providers, templates, costs and environment requirements without generation.", options: { url: runOptions.url, profile: profileOption, seconds: runOptions.seconds, screenshots: runOptions.screenshots, engine: runOptions.engine, "out-dir": runOptions["out-dir"], json: jsonOption } },
  run: { summary: "Run the full scene generation, synthesis, quality and rendering pipeline.", options: runOptions, mutuallyExclusive: [["dry-run", "plan-only"]] },
  resume: {
    summary: "Resume an isolated run from its last failed stage or a selected stage.",
    positionals: [{ name: "run-id", required: true, description: "Run id or run directory." }],
    options: {
      profile: profileOption,
      "from-stage": { type: "string", choices: ["ingest", "draft", "draft-gate", "revise", "synthesize", "audio", "audio-gate", "render", "video-gate", "publish"], description: "Resume from this stage." },
      "force-stage": { type: "string", choices: ["ingest", "draft", "draft-gate", "revise", "synthesize", "audio", "audio-gate", "render", "video-gate", "publish"], description: "Force this stage and continue." },
      iterations: runOptions.iterations,
      "video-iterations": runOptions["video-iterations"],
      seconds: runOptions.seconds,
      screenshots: runOptions.screenshots,
      engine: runOptions.engine,
      "out-dir": runOptions["out-dir"],
      notes: runOptions.notes,
      "quality-profile": runOptions["quality-profile"],
      "ignore-cache": runOptions["ignore-cache"],
    },
    mutuallyExclusive: [["from-stage", "force-stage"]],
  },
  check: { summary: "Run draft, audio and video quality gates against existing artifacts.", options: { project: { type: "string", required: true, description: "Project JSON path." }, video: { type: "string", required: true, description: "Video file path." }, seconds: runOptions.seconds, profile: profileOption, json: jsonOption } },
  feedback: {
    summary: "Add scoped, deduplicated feedback to the feedback store.",
    options: {
      issue: { type: "string", required: true, description: "Observed problem." },
      category: { type: "string", description: "Feedback category." },
      severity: { type: "string", choices: ["low", "medium", "high", "critical"], description: "Feedback severity." },
      desired: { type: "string", description: "Desired behavior." },
      "applies-to": { type: "string", description: "Comma-separated scopes: global, url:<url>, stage:<stage>, category:<category>." },
      video: { type: "string", description: "Related video path." },
      disabled: { type: "boolean", description: "Store the feedback disabled." },
      resolved: { type: "boolean", description: "Mark this fingerprint as resolved." },
      json: jsonOption,
    },
  },
  cache: {
    summary: "Inspect, prune or clear the global content-addressed media cache.",
    positionals: [{ name: "action", required: true, description: "inspect, prune or clear." }],
    options: {
      "max-age-days": { type: "number", description: "Prune entries not accessed within this many days." },
      "max-size-gb": { type: "number", description: "Prune oldest entries until cache size is below this limit." },
      "dry-run": { type: "boolean", description: "Show prune results without deleting files." },
      json: jsonOption,
    },
  },
};

function globalHelp() {
  return [
    "Usage: scene-gen <command> [options]",
    "",
    "Commands:",
    ...Object.entries(definitions).map(([name, definition]) => `  ${name.padEnd(10)} ${definition.summary}`),
    "",
    "Run 'scene-gen <command> --help' for command-specific options.",
  ].join("\n");
}

function assertPositive(name: string, value: unknown, integer = false) {
  if (value === undefined) return;
  if (typeof value !== "number" || value <= 0 || (integer && !Number.isInteger(value))) throw new Error(`--${name} must be a positive${integer ? " integer" : " number"}.`);
}

function assertNonNegative(name: string, value: unknown, integer = false) {
  if (value === undefined) return;
  if (typeof value !== "number" || value < 0 || (integer && !Number.isInteger(value))) throw new Error(`--${name} must be a non-negative${integer ? " integer" : " number"}.`);
}

function assertIntegerRange(name: string, value: unknown, minimum: number, maximum: number) {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}.`);
}

function assertUrl(value: unknown) {
  if (typeof value !== "string") return;
  const url = new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("--url must use http or https.");
}

function harnessArgv(options: Record<string, string | number | boolean>, extras: string[] = []) {
  const excluded = new Set(["profile", "dry-run", "plan-only", "json"]);
  const values = [...extras];
  for (const [key, value] of Object.entries(options)) {
    if (excluded.has(key)) continue;
    values.push(`--${key}`);
    if (value !== true) values.push(String(value));
  }
  return values;
}

async function planFromOptions(options: Record<string, string | number | boolean>, profileName: string) {
  assertUrl(options.url);
  assertPositive("seconds", options.seconds);
  assertNonNegative("screenshots", options.screenshots, true);
  const profile = await applyConfigProfile(profileName);
  return createExecutionPlan({
    url: String(options.url),
    profile,
    targetSeconds: Number(options.seconds ?? 100),
    engine: (options.engine ?? process.env.VIDEO_RENDER_ENGINE ?? "html-video") as "html-video" | "remotion",
    screenshots: Number(options.screenshots ?? process.env.SCREENSHOT_LIMIT ?? 0),
    outputDir: String(options["out-dir"] ?? process.env.VIDEO_OUTPUT_DIR ?? defaultOutputDir()),
  });
}

export async function main(argv = process.argv.slice(2), signal?: AbortSignal) {
  loadDotEnv();
  const [command, ...commandArgs] = argv;
  if (!command || command === "--help" || command === "-h") {
    console.log(globalHelp());
    return;
  }
  const definition = definitions[command];
  if (!definition) throw new Error(`Unknown command '${command}'.\n\n${globalHelp()}`);
  const parsed = parseStrictArgs(commandArgs, definition);
  if (parsed.options.help) {
    console.log(commandHelp(command, definition));
    return;
  }
  if (command === "cache") {
    const action = parsed.positionals[0];
    if (!['inspect', 'prune', 'clear'].includes(action)) throw new Error("Cache action must be inspect, prune or clear.");
    assertNonNegative("max-age-days", parsed.options["max-age-days"]);
    assertNonNegative("max-size-gb", parsed.options["max-size-gb"]);
    if (action !== "prune" && (parsed.options["max-age-days"] !== undefined || parsed.options["max-size-gb"] !== undefined || parsed.options["dry-run"])) {
      throw new Error("Cache prune options are only valid with 'scene-gen cache prune'.");
    }
    const result = action === "inspect"
      ? await inspectMediaCache()
      : action === "clear"
        ? await clearMediaCache()
        : await pruneMediaCache({
          maxAgeDays: parsed.options["max-age-days"] === undefined ? undefined : Number(parsed.options["max-age-days"]),
          maxSizeBytes: parsed.options["max-size-gb"] === undefined ? undefined : Number(parsed.options["max-size-gb"]) * 1024 ** 3,
          dryRun: Boolean(parsed.options["dry-run"]),
        });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  let profileName = String(parsed.options.profile ?? process.env.SCENE_GEN_PROFILE ?? "local-f5");
  if (command === "resume" && !parsed.options.profile) {
    const direct = path.resolve(parsed.positionals[0]);
    const runDir = existsSync(path.join(direct, "run.json")) ? direct : fromRoot("dist", "runs", parsed.positionals[0]);
    const stored: { config?: { runtimeProfile?: string } } = await readJson<{ config?: { runtimeProfile?: string } }>(path.join(runDir, "run.json")).catch(() => ({ config: undefined }));
    if (stored.config?.runtimeProfile && stored.config.runtimeProfile !== "custom") profileName = stored.config.runtimeProfile;
  }
  if (command === "doctor") {
    const profile = await applyConfigProfile(profileName);
    const report = await runDoctor(profile, typeof parsed.options["out-dir"] === "string" ? parsed.options["out-dir"] : undefined);
    console.log(parsed.options.json ? JSON.stringify(report, null, 2) : formatDoctorReport(report));
    if (!report.passed) process.exitCode = 2;
    return;
  }
  if (command === "plan") {
    const plan = await planFromOptions(parsed.options, profileName);
    console.log(parsed.options.json ? JSON.stringify(plan, null, 2) : formatExecutionPlan(plan));
    return;
  }
  if (command === "run") {
    assertUrl(parsed.options.url);
    assertPositive("seconds", parsed.options.seconds);
    assertIntegerRange("iterations", parsed.options.iterations, 1, 4);
    assertIntegerRange("video-iterations", parsed.options["video-iterations"], 1, 3);
    assertNonNegative("screenshots", parsed.options.screenshots, true);
    if (parsed.options["dry-run"] || parsed.options["plan-only"]) {
      console.log(formatExecutionPlan(await planFromOptions(parsed.options, profileName)));
      return;
    }
    await applyConfigProfile(profileName);
    const result = await runVideoAgent(harnessArgv(parsed.options), signal);
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 2;
    return;
  }
  if (command === "resume") {
    assertPositive("seconds", parsed.options.seconds);
    assertIntegerRange("iterations", parsed.options.iterations, 1, 4);
    assertIntegerRange("video-iterations", parsed.options["video-iterations"], 1, 3);
    assertNonNegative("screenshots", parsed.options.screenshots, true);
    await applyConfigProfile(profileName);
    const result = await runVideoAgent(harnessArgv(parsed.options, ["--resume", parsed.positionals[0]]), signal);
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 2;
    return;
  }
  if (command === "check") {
    assertPositive("seconds", parsed.options.seconds);
    await applyConfigProfile(profileName);
    const report = await runManualCheck({ projectPath: String(parsed.options.project), videoPath: String(parsed.options.video), targetSeconds: Number(parsed.options.seconds ?? 100) });
    console.log(parsed.options.json ? JSON.stringify(report, null, 2) : `Check ${report.passed ? "passed" : "failed"}\nReport: ${report.reportPath}`);
    if (!report.passed) process.exitCode = 2;
    return;
  }
  if (command === "feedback") {
    const appliesTo = typeof parsed.options["applies-to"] === "string" ? parsed.options["applies-to"].split(",").map((item) => item.trim()).filter(Boolean) : ["global"];
    if (appliesTo.some((scope) => scope !== "global" && !/^(url:https?:\/\/|stage:[a-z-]+$|category:[^\s]+$)/.test(scope))) throw new Error("--applies-to scopes must be global, url:<http(s)-url>, stage:<stage>, or category:<category>.");
    const result = await appendFeedback({
      createdAt: new Date().toISOString(),
      category: String(parsed.options.category ?? "general"),
      severity: String(parsed.options.severity ?? "medium") as FeedbackSeverity,
      issue: String(parsed.options.issue),
      desired: typeof parsed.options.desired === "string" ? parsed.options.desired : undefined,
      videoPath: typeof parsed.options.video === "string" ? parsed.options.video : undefined,
      appliesTo,
      enabled: !parsed.options.disabled,
      resolvedAt: parsed.options.resolved ? new Date().toISOString() : undefined,
    });
    console.log(parsed.options.json ? JSON.stringify(result, null, 2) : `Feedback ${result.deduplicated ? "deduplicated" : "saved"}: ${result.entry.fingerprint}`);
  }
}

const controller = new AbortController();
process.once("SIGINT", () => controller.abort(new Error("Interrupted by SIGINT.")));
process.once("SIGTERM", () => controller.abort(new Error("Interrupted by SIGTERM.")));

main(process.argv.slice(2), controller.signal).catch((error) => {
  console.error(`scene-gen: ${(error as Error).message}`);
  process.exitCode = 1;
});
