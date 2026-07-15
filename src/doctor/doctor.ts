import { mkdir, rm, statfs, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import type { ConfigProfile } from "../config/config-profiles";
import { runExternalProcess } from "../pipeline/external-operation";
import { defaultOutputDir, resolveF5PythonCommand, resolvePythonCommand } from "../runtime/runtime-paths";
import { mediaCacheRoot } from "../cache/media-cache";
import { loadTtsPronunciationLexicon } from "../pipeline/tts-pronunciation";
import { resolveHtmlRenderBudget } from "../html-video/render-budget";
import { fromRoot } from "../pipeline/utils";

export type DoctorStatus = "pass" | "warn" | "fail";
export interface DoctorCheck { id: string; status: DoctorStatus; required: boolean; summary: string; details?: string }
export interface DoctorReport { profile: string; createdAt: string; checks: DoctorCheck[]; passed: boolean }

async function commandCheck(id: string, command: string, args: string[], required: boolean): Promise<DoctorCheck> {
  try {
    const result = await runExternalProcess(command, args, { timeoutMs: 12_000 });
    return { id, status: "pass", required, summary: `${command} available`, details: (result.stdout || result.stderr).trim().split(/\r?\n/)[0] };
  } catch (error) {
    return { id, status: required ? "fail" : "warn", required, summary: `${command} unavailable`, details: (error as Error).message };
  }
}

function configured(...keys: string[]) {
  return keys.some((key) => Boolean(process.env[key] && process.env[key] !== "xxx"));
}

function huggingFaceCachePath(model: string) {
  const hub = process.env.HF_HOME ? path.join(process.env.HF_HOME, "hub") : path.join(homedir(), ".cache", "huggingface", "hub");
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

function htmlConcurrencyCheck(): DoctorCheck {
  const requested = Number(process.env.HTML_RENDER_CONCURRENCY ?? 2);
  const budget = resolveHtmlRenderBudget(5);
  const reasonable = Number.isInteger(requested) && requested > 0 && requested <= budget.cpuCount && requested <= 8;
  return {
    id: "html-concurrency",
    status: reasonable && requested <= budget.renderConcurrency ? "pass" : "warn",
    required: false,
    summary: `HTML render concurrency requested=${requested}, effective=${budget.renderConcurrency}`,
    details: `CPU=${budget.cpuCount}; freeMemoryGiB=${(budget.availableMemoryBytes / 1024 ** 3).toFixed(1)}; ffmpegThreadsPerJob=${budget.ffmpegThreadsPerJob}`,
  };
}

export async function runDoctor(profile: ConfigProfile, outputDir = process.env.VIDEO_OUTPUT_DIR || defaultOutputDir()): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({ id: "node", status: nodeMajor >= 20 ? "pass" : "fail", required: true, summary: `Node ${process.versions.node}`, details: "Node 20 or newer is required." });
  checks.push(await commandCheck("ffmpeg", "ffmpeg", ["-version"], true));
  checks.push(await commandCheck("ffprobe", "ffprobe", ["-version"], true));
  checks.push(await ffmpegEncoderCheck());
  const browserPath = chromium.executablePath();
  checks.push({ id: "playwright", status: existsSync(browserPath) ? "pass" : profile.doctor.requireBrowser ? "fail" : "warn", required: profile.doctor.requireBrowser, summary: existsSync(browserPath) ? "Playwright Chromium installed" : "Playwright Chromium missing", details: browserPath });
  checks.push(await commandCheck("python", resolvePythonCommand(), ["--version"], profile.doctor.requireF5 || profile.doctor.requireWhisper));
  const cuda = await commandCheck("cuda", "nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader"], profile.doctor.requireCuda);
  checks.push(cuda);
  checks.push(await commandCheck("cuda-python", resolvePythonCommand(), ["-c", "import torch; assert torch.cuda.is_available(), 'torch.cuda.is_available() is false'; print(torch.version.cuda)"], profile.doctor.requireCuda));
  const f5Python = resolveF5PythonCommand();
  const f5 = await commandCheck("f5", f5Python, ["-c", "import f5_tts; print(f5_tts.__file__)"], profile.doctor.requireF5);
  const f5Cache = existsSync(huggingFaceCachePath("SWivid/F5-TTS")) || existsSync(huggingFaceCachePath("SWivid/F5-TTS_v1_Base"));
  checks.push({ ...f5, summary: `${f5.summary}; model cache ${f5Cache ? "found" : "not found"}`, status: f5.status === "pass" && !f5Cache && process.env.F5_TTS_HF_OFFLINE === "1" ? profile.doctor.requireF5 ? "fail" : "warn" : f5.status });
  const workerScript = path.resolve(process.env.F5_TTS_WORKER_SCRIPT ?? fromRoot("scripts", "f5-worker.py"));
  checks.push(await commandCheck("f5-worker", f5Python, [workerScript, "--help"], profile.doctor.requireF5));
  checks.push(pronunciationLexiconCheck(profile.doctor.requireF5));
  const whisperModel = process.env.ASR_MODEL ?? "openai/whisper-tiny";
  const whisperImport = await commandCheck("whisper", resolvePythonCommand(), ["-c", "import transformers; print(transformers.__version__)"], profile.doctor.requireWhisper);
  const whisperCache = existsSync(huggingFaceCachePath(whisperModel));
  checks.push({ ...whisperImport, summary: `${whisperImport.summary}; ${whisperModel} cache ${whisperCache ? "found" : "not found"}`, status: whisperImport.status === "pass" && !whisperCache && process.env.HF_HUB_OFFLINE === "1" ? profile.doctor.requireWhisper ? "fail" : "warn" : whisperImport.status });
  const apiReady = configured("NEWS_LLM_API_KEY", "OPENAI_API_KEY") && configured("NEWS_LLM_MODEL", "OPENAI_MODEL");
  checks.push({ id: "api", status: apiReady ? "pass" : profile.doctor.requireApi ? "fail" : "warn", required: profile.doctor.requireApi, summary: apiReady ? "LLM API configuration present" : "LLM API configuration incomplete", details: "Set API key, base URL when required, and model." });
  checks.push(htmlConcurrencyCheck());
  checks.push(await storageCheck("output", path.resolve(outputDir), true));
  checks.push(await storageCheck("cache", mediaCacheRoot(), true));
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
