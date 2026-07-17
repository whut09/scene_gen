import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { getRuntimeConfig, type RuntimeConfig } from "../../../config/runtime-config";
import { getOrCreateMediaCache } from "../../../cache/media-cache";
import { loadTtsPronunciationLexicon } from "../../tts-pronunciation";
import type { PronunciationPlan } from "../../pronunciation/schema";
import { probeDuration } from "../process";
import type { AzureTtsResult } from "./azure";

export interface NvidiaTtsResult { requestId: string; status: "succeeded"; outputPath: string; requestMs: number; pinyinText?: string }

class NvidiaWorker {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private buffer = "";
  private pending = new Map<string, { resolve: (value: NvidiaTtsResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private readonly config: RuntimeConfig) {}
  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const cfg = this.config.tts.nvidia;
      const child = spawn(cfg.python, [cfg.workerScript, "--endpoint", cfg.endpoint, "--function-id", cfg.functionId, "--voice", cfg.voice, "--language", cfg.language, "--sample-rate", String(cfg.sampleRateHz), "--lexicon", loadTtsPronunciationLexicon().filePath], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, NVIDIA_API_KEY: cfg.apiKey } });
      this.child = child;
      child.unref();
      (child.stdin as NodeJS.WritableStream & { unref?: () => void }).unref?.();
      (child.stdout as NodeJS.ReadableStream & { unref?: () => void }).unref?.();
      (child.stderr as NodeJS.ReadableStream & { unref?: () => void }).unref?.();
      const readyTimer = setTimeout(() => reject(new Error("NVIDIA TTS worker ready timeout.")), cfg.readyTimeoutMs);
      child.stdout.on("data", (chunk) => {
        this.buffer += chunk.toString();
        let newline = this.buffer.indexOf("\n");
        while (newline >= 0) {
          const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1); newline = this.buffer.indexOf("\n");
          if (!line) continue;
          const message = JSON.parse(line);
          if (message.type === "ready") { clearTimeout(readyTimer); resolve(); continue; }
          const pending = this.pending.get(message.requestId); if (!pending) continue;
          clearTimeout(pending.timer); this.pending.delete(message.requestId);
          message.status === "succeeded" ? pending.resolve(message) : pending.reject(new Error(`${message.errorType}: ${message.error}`));
        }
      });
      let stderr = ""; child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
      child.on("exit", (code) => { const error = new Error(`NVIDIA TTS worker exited ${code}: ${stderr}`); reject(error); for (const item of this.pending.values()) item.reject(error); this.pending.clear(); this.child = undefined; this.ready = undefined; });
      child.on("error", reject);
    });
    return this.ready;
  }
  async synthesize(text: string, outputPath: string, signal?: AbortSignal) {
    await this.start();
    if (signal?.aborted) throw signal.reason;
    const requestId = randomUUID();
    return new Promise<NvidiaTtsResult>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); this.child?.kill(); reject(new Error("NVIDIA TTS request timeout.")); }, this.config.tts.nvidia.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.child!.stdin.write(`${JSON.stringify({ requestId, text, outputPath })}\n`);
    });
  }
}

let worker: NvidiaWorker | undefined;

export async function nvidiaTts(input: { plan: PronunciationPlan; outputPath: string; force?: boolean; cacheSalt?: string; signal?: AbortSignal }, config = getRuntimeConfig()): Promise<{ reused: boolean; cacheKey: string; result: AzureTtsResult }> {
  if (!config.tts.nvidia.apiKey) throw new Error("NVIDIA_API_KEY is not configured.");
  const identity = { provider: "nvidia", model: config.tts.nvidia.model, voice: config.tts.nvidia.voice, language: config.tts.nvidia.language, sampleRateHz: config.tts.nvidia.sampleRateHz, synthesisText: input.plan.synthesisText, pronunciationPlanHash: input.plan.planHash, frontendVersion: "nvidia-magpie-pinyin-v1", cacheSalt: input.cacheSalt ?? "" };
  const cacheKey = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  let generated: NvidiaTtsResult | undefined;
  const cached = await getOrCreateMediaCache({ kind: "audio", cacheKey, extension: ".wav", targetPath: input.outputPath, identity, force: input.force, signal: input.signal, generate: async (targetPath) => { worker ??= new NvidiaWorker(config); generated = await worker.synthesize(input.plan.synthesisText, targetPath, input.signal); return { requestMs: generated.requestMs, pinyinText: generated.pinyinText, voice: config.tts.nvidia.voice }; } });
  const raw = generated ?? { requestId: `cache-${cacheKey.slice(0, 12)}`, status: "succeeded" as const, outputPath: input.outputPath, requestMs: 0 };
  return { reused: !cached.generated, cacheKey, result: { requestId: raw.requestId, sceneIndex: 0, status: "succeeded", outputPath: input.outputPath, durationSeconds: await probeDuration(input.outputPath), requestMs: raw.requestMs, retryCount: 0, billedCharacters: [...input.plan.synthesisText].length, voice: config.tts.nvidia.voice, region: config.tts.nvidia.endpoint, retryable: false, providerRequestId: raw.requestId, budgetUsedCharacters: 0, budgetRemainingCharacters: Number.MAX_SAFE_INTEGER, budgetWarning: false } };
}

export async function inspectNvidiaTts(config = getRuntimeConfig()) { if (!config.tts.nvidia.apiKey) throw new Error("NVIDIA_API_KEY is not configured."); worker ??= new NvidiaWorker(config); await worker.start(); return { endpoint: config.tts.nvidia.endpoint, voice: config.tts.nvidia.voice }; }
