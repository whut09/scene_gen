import { appendFeedback, compactFeedback, inspectFeedbackStore, resolveFeedback, setFeedbackEnabled, type FeedbackSeverity } from "../harness/feedback-store";
import { runManualCheck } from "../harness/manual-check";
import { runVideoAgent } from "../harness/video-agent";
import { builtInProfileNames, loadConfigProfile } from "../config/config-profiles";
import { formatDoctorReport, runDoctor } from "../doctor/doctor";
import { createExecutionPlan, formatExecutionPlan } from "../plan/plan";
import { fromRoot, loadDotEnv } from "../pipeline/utils";
import { commandHelp, parseStrictArgs, type CommandDefinition } from "./strict-args";
import { existsSync } from "node:fs";
import path from "node:path";
import { clearMediaCache, inspectMediaCache, pruneMediaCache } from "../cache/cache-manager";
import { createRuntimeConfig, restoreRuntimeConfig, runWithRuntimeConfig, runtimeConfigWithRunOverrides } from "../config/runtime-config";
import { migrateRunArtifacts } from "../persistence/run-migration";
import { readRunJournalFile } from "../harness/run-journal";
import { compilePronunciationPlan } from "../pipeline/pronunciation/compiler";
import { buildAzurePronunciationSsml } from "../pipeline/tts/providers/azure-ssml";
import { azureTts } from "../pipeline/tts/providers/azure";
import { listProviders } from "../production/provider-registry";
import { providerQuotaStatus } from "../production/provider-quota";
import { RunJournalStore } from "../harness/run-journal";
import { readProject } from "../harness/video-stages";
import { runAudioPronunciationGate } from "../harness/quality/audio-pronunciation-gate";

const profileOption = { type: "string" as const, description: `Configuration profile (${builtInProfileNames.join(", ")} or config/profiles/<name>.json).` };
const jsonOption = { type: "boolean" as const, description: "Print machine-readable JSON." };
const runOptions = {
  url: { type: "string" as const, required: true, description: "Article or GitHub URL." },
  profile: profileOption,
  seconds: { type: "number" as const, description: "Target duration in seconds." },
  iterations: { type: "number" as const, description: "Maximum draft/audio loop iterations." },
  "video-iterations": { type: "number" as const, description: "Maximum render/video-gate attempts." },
  "max-llm-tokens": { type: "number" as const, description: "Maximum cumulative LLM tokens for repair loops." },
  "max-tts-rebuilds": { type: "number" as const, description: "Maximum generated TTS scene segments." },
  "max-render-minutes": { type: "number" as const, description: "Maximum cumulative render minutes." },
  "max-estimated-cost": { type: "number" as const, description: "Maximum cumulative normalized repair cost." },
  "max-issue-repairs": { type: "number" as const, description: "Maximum repairs attempted for one issue code." },
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
      "max-llm-tokens": runOptions["max-llm-tokens"],
      "max-tts-rebuilds": runOptions["max-tts-rebuilds"],
      "max-render-minutes": runOptions["max-render-minutes"],
      "max-estimated-cost": runOptions["max-estimated-cost"],
      "max-issue-repairs": runOptions["max-issue-repairs"],
      seconds: runOptions.seconds,
      screenshots: runOptions.screenshots,
      engine: runOptions.engine,
      "out-dir": runOptions["out-dir"],
      notes: runOptions.notes,
      "quality-profile": runOptions["quality-profile"],
      "ignore-cache": runOptions["ignore-cache"],
      "override-config": { type: "boolean", description: "Allow resume to replace the immutable original runtime config." },
    },
    mutuallyExclusive: [["from-stage", "force-stage"]],
  },
  migrate: {
    summary: "Back up and migrate a run journal and its versioned artifacts.",
    positionals: [{ name: "run-id", required: true, description: "Run id or run directory." }],
    options: { json: jsonOption },
  },
  check: { summary: "Run draft, audio and video quality gates against existing artifacts.", options: { project: { type: "string", required: true, description: "Project JSON path." }, video: { type: "string", required: true, description: "Video file path." }, seconds: runOptions.seconds, profile: profileOption, json: jsonOption } },
  feedback: {
    summary: "Add, inspect, disable, resolve or compact feedback.",
    positionals: [{ name: "action", description: "add (default), inspect, enable, disable, resolve, compact." }],
    options: {
      issue: { type: "string", description: "Observed problem for add." },
      fingerprint: { type: "string", description: "Feedback fingerprint for enable, disable or resolve." },
      actor: { type: "string", description: "Person or service making the change." },
      "run-id": { type: "string", description: "Run that caused this change." },
      reason: { type: "string", description: "Reason for the mutation." },
      category: { type: "string", description: "Feedback category." },
      severity: { type: "string", choices: ["low", "medium", "high", "critical"], description: "Feedback severity." },
      desired: { type: "string", description: "Desired behavior." },
      "applies-to": { type: "string", description: "Comma-separated scopes: global, url:<url>, stage:<stage>, category:<category>." },
      "content-domains": { type: "string", description: "Comma-separated content domains where this feedback applies." },
      "template-ids": { type: "string", description: "Comma-separated template IDs where this feedback applies." },
      "provider-ids": { type: "string", description: "Comma-separated provider IDs where this feedback applies." },
      "conflicts-with": { type: "string", description: "Comma-separated feedback fingerprints that conflict with this entry." },
      "minimum-confidence": { type: "number", description: "Minimum context confidence from 0 to 1." },
      "expires-at": { type: "string", description: "ISO timestamp after which this feedback is ignored." },
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
  pronunciation: {
    summary: "Inspect a context-aware pronunciation plan and Azure SSML.",
    positionals: [{ name: "action", required: true, description: "inspect." }],
    options: {
      text: { type: "string", required: true, description: "Chinese display text to inspect." },
      profile: profileOption,
      json: jsonOption,
    },
  },
  tts: {
    summary: "Inspect TTS providers, quota, or run an explicit provider smoke test.",
    positionals: [{ name: "action", required: true, description: "providers, quota or smoke." }],
    options: {
      provider: { type: "string", choices: ["azure", "cloudflare-melotts", "edge", "f5", "openai", "windows", "mock"], description: "Provider for quota or smoke." },
      text: { type: "string", description: "Text for the smoke synthesis." },
      output: { type: "string", description: "WAV output path for the smoke synthesis." },
      profile: profileOption,
      json: jsonOption,
    },
  },
  audio: {
    summary: "Verify pronunciation evidence for a scene in an existing run.",
    positionals: [{ name: "action", required: true, description: "verify." }],
    options: {
      run: { type: "string", required: true, description: "Run id or run directory." },
      scene: { type: "number", required: true, description: "Zero-based scene index." },
      profile: profileOption,
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
  const profile = await loadConfigProfile(profileName);
  const baseConfig = await createRuntimeConfig(profileName);
  const runtimeConfig = runtimeConfigWithRunOverrides(baseConfig, {
    engine: typeof options.engine === "string" ? options.engine as "html-video" | "remotion" : undefined,
    outputDir: typeof options["out-dir"] === "string" ? options["out-dir"] : undefined,
    screenshotLimit: options.screenshots === undefined ? undefined : Number(options.screenshots),
  });
  return createExecutionPlan({
    url: String(options.url),
    profile,
    runtimeConfig,
    targetSeconds: Number(options.seconds ?? 100),
    engine: runtimeConfig.rendering.engine,
    screenshots: runtimeConfig.rendering.screenshotLimit,
    outputDir: runtimeConfig.rendering.outputDir,
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
  if (command === "pronunciation") {
    if (parsed.positionals[0] !== "inspect") throw new Error("Pronunciation action must be inspect.");
    const runtimeConfig = await createRuntimeConfig(String(parsed.options.profile ?? process.env.SCENE_GEN_PROFILE ?? "local-f5"));
    const { plan, issues } = await compilePronunciationPlan({ displayText: String(parsed.options.text), domain: runtimeConfig.tts.pronunciation.domain, signal });
    const ssml = buildAzurePronunciationSsml(plan, {
      voice: runtimeConfig.tts.azure.voice,
      style: runtimeConfig.tts.azure.style,
      role: runtimeConfig.tts.azure.role,
    });
    const result = {
      displayText: plan.displayText,
      synthesisText: plan.synthesisText,
      spans: plan.spans.map((span) => ({ phrase: span.phrase, pinyin: span.providerOverrides.azure?.pinyin ?? span.expectedPinyin, source: span.source, confidence: span.confidence })),
      providerSsml: ssml,
      planHash: plan.planHash,
      issues,
    };
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "tts") {
    const action = parsed.positionals[0];
    if (!new Set(["providers", "quota", "smoke"]).has(action)) throw new Error("TTS action must be providers, quota or smoke.");
    const profileName = String(parsed.options.profile ?? process.env.SCENE_GEN_PROFILE ?? "local-f5");
    const runtimeConfig = await createRuntimeConfig(profileName);
    if (action === "providers") {
      const providers = await Promise.all(listProviders({ profile: profileName, language: "zh-CN" }).filter((provider) => provider.capability === "tts").map(async (provider) => ({
        id: provider.id, name: provider.name, enabled: provider.enabled, health: provider.health, local: provider.local,
        capabilities: provider.ttsCapabilities, quota: await providerQuotaStatus(provider.id, runtimeConfig),
      })));
      console.log(JSON.stringify(providers, null, 2));
      return;
    }
    const provider = String(parsed.options.provider ?? runtimeConfig.tts.provider);
    if (action === "quota") {
      console.log(JSON.stringify(await providerQuotaStatus(provider, runtimeConfig), null, 2));
      return;
    }
    if (provider !== "azure") throw new Error("The smoke command currently supports --provider azure only.");
    const text = String(parsed.options.text ?? "系统完成核心模块重构");
    const { plan, issues } = await compilePronunciationPlan({ displayText: text, domain: runtimeConfig.tts.pronunciation.domain, signal });
    const outputPath = path.resolve(String(parsed.options.output ?? fromRoot("dist", "smoke", "azure-tts.wav")));
    const synthesized = await azureTts({ sceneIndex: 0, displayText: plan.displayText, synthesisText: plan.synthesisText, pronunciationPlan: plan, pronunciationPlanHash: plan.planHash, outputPath, signal }, runtimeConfig);
    console.log(JSON.stringify({ provider, outputPath, planHash: plan.planHash, issues, ...synthesized }, null, 2));
    return;
  }
  if (command === "audio") {
    if (parsed.positionals[0] !== "verify") throw new Error("Audio action must be verify.");
    assertNonNegative("scene", parsed.options.scene, true);
    const direct = path.resolve(String(parsed.options.run));
    const runDir = existsSync(path.join(direct, "run.json")) ? direct : fromRoot("dist", "runs", String(parsed.options.run));
    const journal = await RunJournalStore.open(runDir);
    const snapshot = journal.snapshot();
    const projectPath = snapshot.artifacts.projectPath;
    if (!projectPath) throw new Error(`Run '${snapshot.runId}' does not have a projectPath artifact.`);
    const sceneIndex = Number(parsed.options.scene);
    const project = await readProject(projectPath);
    const segment = project.narrationSegments?.find((item) => item.sceneIndex === sceneIndex);
    if (!segment) throw new Error(`Scene ${sceneIndex} does not have a narration segment.`);
    const scopedProject = { ...project, narrationSegments: [segment] };
    const runtimeConfig = parsed.options.profile ? await createRuntimeConfig(String(parsed.options.profile)) : snapshot.config.runtimeConfig ? restoreRuntimeConfig(snapshot.config.runtimeConfig) : await createRuntimeConfig(snapshot.config.runtimeProfile);
    const result = await runAudioPronunciationGate({ project: scopedProject, config: runtimeConfig, signal });
    console.log(JSON.stringify({ runId: snapshot.runId, sceneIndex, ...result }, null, 2));
    return;
  }
  if (command === "migrate") {
    const result = await migrateRunArtifacts(parsed.positionals[0]);
    console.log(parsed.options.json ? JSON.stringify(result, null, 2) : `Migrated ${result.migratedCount} artifact(s) for ${result.runId}.\nRun: ${result.runDir}`);
    return;
  }
  let profileName = String(parsed.options.profile ?? process.env.SCENE_GEN_PROFILE ?? (command === "doctor" ? "ci-offline" : "local-f5"));
  if (command === "resume" && !parsed.options.profile) {
    const direct = path.resolve(parsed.positionals[0]);
    const runDir = existsSync(path.join(direct, "run.json")) ? direct : fromRoot("dist", "runs", parsed.positionals[0]);
    const stored = await readRunJournalFile(path.join(runDir, "run.json")).then((result) => result.value).catch(() => undefined);
    if (stored?.config.runtimeProfile && stored.config.runtimeProfile !== "custom") profileName = stored.config.runtimeProfile;
  }
  if (command === "doctor") {
    const profile = await loadConfigProfile(profileName);
    const runtimeConfig = runtimeConfigWithRunOverrides(await createRuntimeConfig(profileName), { outputDir: typeof parsed.options["out-dir"] === "string" ? parsed.options["out-dir"] : undefined });
    const report = await runDoctor(profile, runtimeConfig);
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
    assertIntegerRange("iterations", parsed.options.iterations, 1, 8);
    assertIntegerRange("video-iterations", parsed.options["video-iterations"], 1, 3);
    assertPositive("max-llm-tokens", parsed.options["max-llm-tokens"]);
    assertPositive("max-tts-rebuilds", parsed.options["max-tts-rebuilds"]);
    assertPositive("max-render-minutes", parsed.options["max-render-minutes"]);
    assertPositive("max-estimated-cost", parsed.options["max-estimated-cost"]);
    assertPositive("max-issue-repairs", parsed.options["max-issue-repairs"]);
    assertNonNegative("screenshots", parsed.options.screenshots, true);
    if (parsed.options["dry-run"] || parsed.options["plan-only"]) {
      console.log(formatExecutionPlan(await planFromOptions(parsed.options, profileName)));
      return;
    }
    const runtimeConfig = await createRuntimeConfig(profileName);
    const result = await runVideoAgent(harnessArgv(parsed.options), signal, runtimeConfig);
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 2;
    return;
  }
  if (command === "resume") {
    assertPositive("seconds", parsed.options.seconds);
    assertIntegerRange("iterations", parsed.options.iterations, 1, 8);
    assertIntegerRange("video-iterations", parsed.options["video-iterations"], 1, 3);
    assertPositive("max-llm-tokens", parsed.options["max-llm-tokens"]);
    assertPositive("max-tts-rebuilds", parsed.options["max-tts-rebuilds"]);
    assertPositive("max-render-minutes", parsed.options["max-render-minutes"]);
    assertPositive("max-estimated-cost", parsed.options["max-estimated-cost"]);
    assertPositive("max-issue-repairs", parsed.options["max-issue-repairs"]);
    assertNonNegative("screenshots", parsed.options.screenshots, true);
    const direct = path.resolve(parsed.positionals[0]);
    const runDir = existsSync(path.join(direct, "run.json")) ? direct : fromRoot("dist", "runs", parsed.positionals[0]);
    const stored = (await readRunJournalFile(path.join(runDir, "run.json"))).value;
    const overrideConfig = Boolean(parsed.options["override-config"]);
    if (parsed.options.profile && !overrideConfig) throw new Error("--profile requires --override-config when resuming a run.");
    const runtimeConfig = !overrideConfig && stored.config.runtimeConfig
      ? restoreRuntimeConfig(stored.config.runtimeConfig)
      : await createRuntimeConfig(profileName);
    const result = await runVideoAgent(harnessArgv(parsed.options, ["--resume", parsed.positionals[0]]), signal, runtimeConfig);
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 2;
    return;
  }
  if (command === "check") {
    assertPositive("seconds", parsed.options.seconds);
    const runtimeConfig = await createRuntimeConfig(profileName);
    const report = await runWithRuntimeConfig(runtimeConfig, () => runManualCheck({ projectPath: String(parsed.options.project), videoPath: String(parsed.options.video), targetSeconds: Number(parsed.options.seconds ?? 100) }));
    console.log(parsed.options.json ? JSON.stringify(report, null, 2) : `Check ${report.passed ? "passed" : "failed"}\nReport: ${report.reportPath}`);
    if (!report.passed) process.exitCode = 2;
    return;
  }
  if (command === "feedback") {
    const action = parsed.positionals[0] ?? "add";
    const context = { actor: typeof parsed.options.actor === "string" ? parsed.options.actor : undefined, runId: typeof parsed.options["run-id"] === "string" ? parsed.options["run-id"] : undefined, reason: typeof parsed.options.reason === "string" ? parsed.options.reason : action };
    if (action === "inspect") { const result = await inspectFeedbackStore(); console.log(JSON.stringify(result, null, 2)); return; }
    if (action === "compact") { const result = await compactFeedback(context); console.log(parsed.options.json ? JSON.stringify(result, null, 2) : `Feedback compacted: ${result.before} -> ${result.after}`); return; }
    if (["enable", "disable", "resolve"].includes(action)) {
      const fingerprint = typeof parsed.options.fingerprint === "string" ? parsed.options.fingerprint : undefined;
      if (!fingerprint) throw new Error(`feedback ${action} requires --fingerprint.`);
      const result = action === "resolve" ? await resolveFeedback(fingerprint, context) : await setFeedbackEnabled(fingerprint, action === "enable", context);
      console.log(parsed.options.json ? JSON.stringify(result, null, 2) : `Feedback ${action}: ${result.fingerprint}`); return;
    }
    if (action !== "add") throw new Error("feedback action must be add, inspect, enable, disable, resolve, or compact.");
    if (typeof parsed.options.issue !== "string") throw new Error("feedback add requires --issue.");
    const csv = (name: string) => typeof parsed.options[name] === "string" ? String(parsed.options[name]).split(",").map((item) => item.trim()).filter(Boolean) : undefined;
    const appliesTo = typeof parsed.options["applies-to"] === "string" ? parsed.options["applies-to"].split(",").map((item) => item.trim()).filter(Boolean) : ["global"];
    if (appliesTo.some((scope) => scope !== "global" && !/^(url:https?:\/\/|stage:[a-z-]+$|category:[^\s]+$)/.test(scope))) throw new Error("--applies-to scopes must be global, url:<http(s)-url>, stage:<stage>, or category:<category>.");
    const minimumConfidence = Number(parsed.options["minimum-confidence"] ?? 0);
    if (minimumConfidence < 0 || minimumConfidence > 1) throw new Error("--minimum-confidence must be between 0 and 1.");
    const expiresAt = typeof parsed.options["expires-at"] === "string" ? parsed.options["expires-at"] : undefined;
    if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) throw new Error("--expires-at must be a valid ISO timestamp.");
    const result = await appendFeedback({
      createdAt: new Date().toISOString(),
      category: String(parsed.options.category ?? "general"),
      severity: String(parsed.options.severity ?? "medium") as FeedbackSeverity,
      issue: String(parsed.options.issue),
      desired: typeof parsed.options.desired === "string" ? parsed.options.desired : undefined,
      videoPath: typeof parsed.options.video === "string" ? parsed.options.video : undefined,
      appliesTo,
      contentDomains: csv("content-domains"),
      templateIds: csv("template-ids"),
      providerIds: csv("provider-ids"),
      conflictsWith: csv("conflicts-with"),
      minimumConfidence,
      expiresAt,
      enabled: !parsed.options.disabled,
      resolvedAt: parsed.options.resolved ? new Date().toISOString() : undefined,
    }, context);
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
