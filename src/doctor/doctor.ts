import { mkdir, rm, statfs, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import type { ConfigProfile } from "../config/config-profiles";
import type { RuntimeConfig } from "../config/runtime-config";
import { runExternalProcess } from "../pipeline/external-operation";
import { resolvePythonCommand } from "../runtime/runtime-paths";
import { resolveStoryPlanCandidateCount } from "../pipeline/story-planner";
import { loadTtsPronunciationLexicon } from "../pipeline/tts-pronunciation";
import { resolveHtmlRenderBudgetFromConfig } from "../html-video/render-budget";
import { fromRoot } from "../pipeline/utils";
import { readTemplateOutcomes, templateOutcomeFilePath } from "../templates/template-learning";
import { listProviders } from "../production/provider-registry";
import { providerOutcomeFilePath, readProviderOutcomes } from "../production/provider-stats";
import { inspectFeedbackStore } from "../harness/feedback-store";
import { inspectAzureVoice, readAzureUsage } from "../pipeline/tts/providers/azure";

export type DoctorStatus = "pass" | "warn" | "fail";
export interface DoctorCheck { id: string; status: DoctorStatus; required: boolean; summary: string; details?: string }
export interface DoctorReport { profile: string; createdAt: string; checks: DoctorCheck[]; passed: boolean }

async function azureSpeechChecks(config: RuntimeConfig): Promise<DoctorCheck[]> {
  const required = config.tts.provider === "azure";
  const configured = Boolean(config.tts.azure.apiKey && (config.tts.azure.region || config.tts.azure.endpoint));
  const usage = await readAzureUsage(config);
  const budget = config.tts.azure.monthlyCharacterBudget;
  const ratio = usage.usedCharacters / budget;
  const checks: DoctorCheck[] = [{
    id: "azure-config",
    status: configured ? "pass" : required ? "fail" : "warn",
    required,
    summary: configured ? "Azure Speech configured for " + (config.tts.azure.region ?? "custom endpoint") : "Azure Speech configuration incomplete",
    details: "Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION, or provide AZURE_SPEECH_ENDPOINT.",
  }, {
    id: "azure-budget",
    status: usage.usedCharacters >= budget ? "fail" : ratio >= config.tts.azure.budgetWarningRatio ? "warn" : "pass",
    required,
    summary: usage.usedCharacters + "/" + budget + " Azure billed characters used for " + usage.month,
    details: Math.max(0, budget - usage.usedCharacters) + " characters remain before the hard limit.",
  }];
  if (!configured) return checks;
  try {
    const voice = await inspectAzureVoice(config);
    checks.push({ id: "azure-network", status: "pass", required, summary: "Azure voices endpoint reachable (" + voice.voiceCount + " voices)" });
    checks.push({ id: "azure-voice", status: voice.voiceFound ? "pass" : "fail", required, summary: voice.voiceFound ? "Azure voice " + config.tts.azure.voice + " is available" : "Azure voice " + config.tts.azure.voice + " was not found" });
  } catch (error) {
    checks.push({ id: "azure-network", status: required ? "fail" : "warn", required, summary: "Azure voices endpoint is unavailable", details: (error as Error).message });
    checks.push({ id: "azure-voice", status: required ? "fail" : "warn", required, summary: "Could not verify Azure voice " + config.tts.azure.voice });
  }
  return checks;
}

async function commandCheck(id: string, command: string, args: string[], required: boolean): Promise<DoctorCheck> {
  try {
    const result = await runExternalProcess(command, args, { timeoutMs: 12_000 });
    return { id, status: "pass", required, summary: `${command} available`, details: (result.stdout || result.stderr).trim().split(/\r?\n/)[0] };
  } catch (error) {
    return { id, status: required ? "fail" : "warn", required, summary: `${command} unavailable`, details: (error as Error).message };
  }
}

function huggingFaceCachePath(model: string, config: RuntimeConfig) {
  const hub = path.join(config.cache.huggingFaceHome, "hub");
  return path.join(hub, `models--${model.replace(/\//g, "--")}`);
}

async function storageCheck(id: string, directory: string, required: boolean): Promise<DoctorCheck> {
  const probe = path.join(directory, `.scene-gen-doctor-${process.pid}.tmp`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(probe, "ok", "utf8");
    await rm(probe, { force: true });
    const disk = await statfs(directory);
    const freeGb = Number(disk.bavail * disk.bsize) / 1024 ** 3;
    return { id, status: freeGb < 5 ? "warn" : "pass", required, summary: `${id === "cache" ? "Cache" : "Output"} directory writable; ${freeGb.toFixed(1)} GiB free`, details: directory };
  } catch (error) {
    return { id, status: required ? "fail" : "warn", required, summary: `${id === "cache" ? "Cache" : "Output"} directory is not writable`, details: `${directory}: ${(error as Error).message}` };
  }
}

async function ffmpegEncoderCheck(): Promise<DoctorCheck> {
  try {
    const result = await runExternalProcess("ffmpeg", ["-hide_banner", "-encoders"], { timeoutMs: 12_000 });
    const output = `${result.stdout}\n${result.stderr}`;
    const software = output.includes("libx264");
    const hardware = ["h264_nvenc", "h264_qsv", "h264_amf"].filter((encoder) => output.includes(encoder));
    return {
      id: "ffmpeg-h264",
      status: software ? "pass" : "fail",
      required: true,
      summary: software ? "FFmpeg libx264 encoder available" : "FFmpeg libx264 encoder missing",
      details: `Optional hardware encoders: ${hardware.join(", ") || "none"}`,
    };
  } catch (error) {
    return { id: "ffmpeg-h264", status: "fail", required: true, summary: "Unable to inspect FFmpeg encoders", details: (error as Error).message };
  }
}

function pronunciationLexiconCheck(required: boolean): DoctorCheck {
  try {
    const loaded = loadTtsPronunciationLexicon();
    return { id: "tts-lexicon", status: "pass", required, summary: `Pronunciation lexicon valid (${loaded.lexicon.entries.length} entries)`, details: `${loaded.filePath}; hash=${loaded.hash}` };
  } catch (error) {
    return { id: "tts-lexicon", status: required ? "fail" : "warn", required, summary: "Pronunciation lexicon invalid", details: (error as Error).message };
  }
}

function htmlConcurrencyCheck(config: RuntimeConfig): DoctorCheck {
  const requested = config.rendering.html.concurrency;
  const budget = resolveHtmlRenderBudgetFromConfig(5, config);
  const reasonable = Number.isInteger(requested) && requested > 0 && requested <= budget.cpuCount && requested <= 8;
  return {
    id: "html-concurrency",
    status: reasonable && requested <= budget.renderConcurrency ? "pass" : "warn",
    required: false,
    summary: `HTML render concurrency requested=${requested}, effective=${budget.renderConcurrency}`,
    details: `CPU=${budget.cpuCount}; freeMemoryGiB=${(budget.availableMemoryBytes / 1024 ** 3).toFixed(1)}; ffmpegThreadsPerJob=${budget.ffmpegThreadsPerJob}`,
  };
}

function visualQualityConfigCheck(config: RuntimeConfig): DoctorCheck {
  const values = {
    lumaRange: config.rendering.visual.blankLumaRangeMin,
    edgeDensity: config.rendering.visual.blankEdgeDensityMin,
    ocrCoverage: config.rendering.ocr.keyTextMin,
  };
  const valid = values.lumaRange > 0 && values.lumaRange <= 255
    && values.edgeDensity > 0 && values.edgeDensity < 1
    && values.ocrCoverage > 0 && values.ocrCoverage <= 1;
  return { id: "visual-quality", status: valid ? "pass" : "fail", required: true, summary: valid ? "Visual quality thresholds valid" : "Visual quality thresholds invalid", details: JSON.stringify(values) };
}

async function templateLearningCheck(config: RuntimeConfig): Promise<DoctorCheck> {
  const filePath = templateOutcomeFilePath();
  const directory = path.dirname(filePath);
  const rate = config.rendering.templateLearning.explorationRate;
  const probe = path.join(directory, `.scene-gen-template-learning-${process.pid}.tmp`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(probe, "ok", "utf8");
    await rm(probe, { force: true });
    const validRate = Number.isFinite(rate) && rate >= 0 && rate <= 0.25;
    const outcomes = readTemplateOutcomes();
    return {
      id: "template-learning",
      status: validRate ? "pass" : "fail",
      required: true,
      summary: validRate ? `Template learning ready; ${outcomes.length} outcomes` : `Invalid template exploration rate ${rate}`,
      details: `${filePath}; exploration=${rate}; disabled=${config.rendering.templateLearning.disabled}`,
    };
  } catch (error) {
    return { id: "template-learning", status: "fail", required: true, summary: "Template outcome directory is not writable", details: `${filePath}: ${(error as Error).message}` };
  }
}

async function providerHistoryCheck(): Promise<DoctorCheck> {
  const filePath = providerOutcomeFilePath();
  const directory = path.dirname(filePath);
  const probe = path.join(directory, `.scene-gen-provider-history-${process.pid}.tmp`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(probe, "ok", "utf8");
    await rm(probe, { force: true });
    const outcomes = readProviderOutcomes();
    const providers = listProviders();
    const unhealthy = providers.filter((provider) => provider.health === "unhealthy").map((provider) => provider.id);
    const degraded = providers.filter((provider) => provider.health === "degraded").map((provider) => provider.id);
    return {
      id: "provider-history",
      status: unhealthy.length ? "warn" : "pass",
      required: false,
      summary: `Provider history ready; ${outcomes.length} outcomes`,
      details: `${filePath}; degraded=${degraded.join(",") || "none"}; unhealthy=${unhealthy.join(",") || "none"}`,
    };
  } catch (error) {
    return { id: "provider-history", status: "warn", required: false, summary: "Provider history directory is not writable", details: `${filePath}: ${(error as Error).message}` };
  }
}

export async function runDoctor(profile: ConfigProfile, config: RuntimeConfig): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({ id: "node", status: nodeMajor >= 20 ? "pass" : "fail", required: true, summary: `Node ${process.versions.node}`, details: "Node 20 or newer is required." });
  checks.push(await commandCheck("ffmpeg", "ffmpeg", ["-version"], true));
  checks.push(await commandCheck("ffprobe", "ffprobe", ["-version"], true));
  checks.push(await ffmpegEncoderCheck());
  checks.push(visualQualityConfigCheck(config));
  checks.push(await templateLearningCheck(config));
  checks.push(await providerHistoryCheck());
  checks.push(...await azureSpeechChecks(config));
  const feedback = await inspectFeedbackStore();
  checks.push({ id: "feedback", status: feedback.invalidLines > 0 || feedback.quarantineCount > 0 ? "warn" : "pass", required: false, summary: `${feedback.total} entries; ${feedback.quarantineCount} quarantined lines`, details: feedback.quarantineCount ? feedback.quarantinePath : feedback.filePath });
  if (config.rendering.ocr.enabled) checks.push(await commandCheck("video-ocr", config.rendering.ocr.command, ["--version"], true));
  const browserPath = chromium.executablePath();
  checks.push({ id: "playwright", status: existsSync(browserPath) ? "pass" : profile.doctor.requireBrowser ? "fail" : "warn", required: profile.doctor.requireBrowser, summary: existsSync(browserPath) ? "Playwright Chromium installed" : "Playwright Chromium missing", details: browserPath });
  checks.push(await commandCheck("python", config.asr.python ?? config.tts.f5.python ?? resolvePythonCommand({}), ["--version"], profile.doctor.requireF5 || profile.doctor.requireWhisper));
  const cuda = await commandCheck("cuda", "nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader"], profile.doctor.requireCuda);
  checks.push(cuda);
  checks.push(await commandCheck("cuda-python", config.tts.f5.python, ["-c", "import torch; assert torch.cuda.is_available(), 'torch.cuda.is_available() is false'; print(torch.version.cuda)"], profile.doctor.requireCuda));
  const f5Python = config.tts.f5.python;
  const f5 = await commandCheck("f5", f5Python, ["-c", "import f5_tts; print(f5_tts.__file__)"], profile.doctor.requireF5);
  const f5Cache = existsSync(huggingFaceCachePath("SWivid/F5-TTS", config)) || existsSync(huggingFaceCachePath("SWivid/F5-TTS_v1_Base", config));
  checks.push({ ...f5, summary: `${f5.summary}; model cache ${f5Cache ? "found" : "not found"}`, status: f5.status === "pass" && !f5Cache && config.tts.f5.hfOffline ? profile.doctor.requireF5 ? "fail" : "warn" : f5.status });
  const workerScript = path.resolve(config.tts.f5.workerScript ?? fromRoot("scripts", "f5-worker.py"));
  checks.push(await commandCheck("f5-worker", f5Python, [workerScript, "--help"], profile.doctor.requireF5));
  checks.push(pronunciationLexiconCheck(profile.doctor.requireF5));
  const whisperModel = config.asr.model;
  const whisperImport = await commandCheck("whisper", config.asr.python ?? resolvePythonCommand({}), ["-c", "import transformers; print(transformers.__version__)"], profile.doctor.requireWhisper);
  const whisperCache = existsSync(huggingFaceCachePath(whisperModel, config));
  checks.push({ ...whisperImport, summary: `${whisperImport.summary}; ${whisperModel} cache ${whisperCache ? "found" : "not found"}`, status: whisperImport.status === "pass" && !whisperCache && config.cache.huggingFaceOffline ? profile.doctor.requireWhisper ? "fail" : "warn" : whisperImport.status });
  const apiReady = Boolean(config.llm.news.apiKey && config.llm.news.apiKey !== "xxx" && config.llm.news.model);
  checks.push({ id: "api", status: apiReady ? "pass" : profile.doctor.requireApi ? "fail" : "warn", required: profile.doctor.requireApi, summary: apiReady ? "LLM API configuration present" : "LLM API configuration incomplete", details: "Set API key, base URL when required, and model." });
  try {
    const candidateCount = resolveStoryPlanCandidateCount(profile.name, profile.env.STORY_PLAN_CANDIDATES);
    checks.push({ id: "story-plans", status: "pass", required: false, summary: `Story planning candidates: ${candidateCount}`, details: "Allowed range is 1 to 4." });
  } catch (error) {
    checks.push({ id: "story-plans", status: "fail", required: true, summary: "Invalid story planning configuration", details: (error as Error).message });
  }
  checks.push(htmlConcurrencyCheck(config));
  checks.push(await storageCheck("output", config.rendering.outputDir, true));
  checks.push(await storageCheck("cache", config.cache.rootDir, true));
  const passed = !checks.some((check) => check.required && check.status === "fail");
  return { profile: profile.name, createdAt: new Date().toISOString(), checks, passed };
}

export function formatDoctorReport(report: DoctorReport) {
  const marker = { pass: "PASS", warn: "WARN", fail: "FAIL" } as const;
  return [
    `scene-gen doctor (${report.profile})`,
    ...report.checks.map((check) => `${marker[check.status].padEnd(4)} ${check.id.padEnd(12)} ${check.summary}${check.details ? `\n     ${check.details}` : ""}`),
    `\nResult: ${report.passed ? "ready" : "not ready"}`,
  ].join("\n");
}
