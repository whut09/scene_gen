import { mkdir, rm, statfs, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import type { ConfigProfile } from "../config/config-profiles";
import { runExternalProcess } from "../pipeline/external-operation";
import { defaultOutputDir, resolveF5PythonCommand, resolvePythonCommand } from "../runtime/runtime-paths";

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

async function outputCheck(outputDir: string): Promise<DoctorCheck> {
  const probe = path.join(outputDir, `.scene-gen-doctor-${process.pid}.tmp`);
  try {
    await mkdir(outputDir, { recursive: true });
    await writeFile(probe, "ok", "utf8");
    await rm(probe, { force: true });
    const disk = await statfs(outputDir);
    const freeGb = Number(disk.bavail * disk.bsize) / 1024 ** 3;
    return { id: "output", status: freeGb < 5 ? "warn" : "pass", required: true, summary: `Output directory writable; ${freeGb.toFixed(1)} GiB free`, details: outputDir };
  } catch (error) {
    return { id: "output", status: "fail", required: true, summary: "Output directory is not writable", details: `${outputDir}: ${(error as Error).message}` };
  }
}

export async function runDoctor(profile: ConfigProfile, outputDir = process.env.VIDEO_OUTPUT_DIR || defaultOutputDir()): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({ id: "node", status: nodeMajor >= 20 ? "pass" : "fail", required: true, summary: `Node ${process.versions.node}`, details: "Node 20 or newer is required." });
  checks.push(await commandCheck("ffmpeg", "ffmpeg", ["-version"], true));
  checks.push(await commandCheck("ffprobe", "ffprobe", ["-version"], true));
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
  const whisperModel = process.env.ASR_MODEL ?? "openai/whisper-tiny";
  const whisperImport = await commandCheck("whisper", resolvePythonCommand(), ["-c", "import transformers; print(transformers.__version__)"], profile.doctor.requireWhisper);
  const whisperCache = existsSync(huggingFaceCachePath(whisperModel));
  checks.push({ ...whisperImport, summary: `${whisperImport.summary}; ${whisperModel} cache ${whisperCache ? "found" : "not found"}`, status: whisperImport.status === "pass" && !whisperCache && process.env.HF_HUB_OFFLINE === "1" ? profile.doctor.requireWhisper ? "fail" : "warn" : whisperImport.status });
  const apiReady = configured("NEWS_LLM_API_KEY", "OPENAI_API_KEY") && configured("NEWS_LLM_MODEL", "OPENAI_MODEL");
  checks.push({ id: "api", status: apiReady ? "pass" : profile.doctor.requireApi ? "fail" : "warn", required: profile.doctor.requireApi, summary: apiReady ? "LLM API configuration present" : "LLM API configuration incomplete", details: "Set API key, base URL when required, and model." });
  checks.push(await outputCheck(path.resolve(outputDir)));
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
