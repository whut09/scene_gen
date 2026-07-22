import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { getOrCreateMediaCache } from "../../../cache/media-cache";
import { getRuntimeConfig, type RuntimeConfig } from "../../../config/runtime-config";
import { indexTtsPronunciationInput } from "../../pronunciation/provider-adapters";
import type { PronunciationPlan } from "../../pronunciation/schema";
import { probeDuration, run } from "../process";

export const INDEXTTS_FRONTEND_VERSION = "indextts2-fixed-reference-v2-mixed-pinyin";
type WorkerResult = { requestId: string; status: "succeeded"; outputPath: string; synthesisMs: number };

class IndexTtsWorker {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private buffer = "";
  private pending = new Map<string, { resolve: (value: WorkerResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly config: RuntimeConfig) {}

  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const cfg = this.config.tts.indextts;
      const child = spawn(cfg.python, [cfg.workerScript, "--root", cfg.root, "--model-dir", cfg.modelDir, "--ref-audio", cfg.refAudio], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      this.child = child;
      const readyTimer = setTimeout(() => reject(new Error("IndexTTS2 worker ready timeout")), cfg.readyTimeoutMs);
      readyTimer.unref();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        this.buffer += chunk;
        for (;;) {
          const newline = this.buffer.indexOf("\n");
          if (newline < 0) break;
          const line = this.buffer.slice(0, newline).trim();
          this.buffer = this.buffer.slice(newline + 1);
          if (!line) continue;
          let message: ({ type: string; requestId?: string; status?: string; error?: string } & Partial<WorkerResult>) | undefined;
          try {
            message = JSON.parse(line) as { type: string; requestId?: string; status?: string; error?: string } & Partial<WorkerResult>;
          } catch {
            continue;
          }
          if (message.type === "ready") {
            clearTimeout(readyTimer);
            resolve();
          }
          if (message.type !== "result" || !message.requestId) continue;
          const pending = this.pending.get(message.requestId);
          if (!pending) continue;
          clearTimeout(pending.timer);
          this.pending.delete(message.requestId);
          message.status === "succeeded" ? pending.resolve(message as WorkerResult) : pending.reject(new Error(message.error ?? "IndexTTS2 failed"));
        }
      });
      child.stderr.on("data", () => undefined);
      child.once("error", (error) => {
        clearTimeout(readyTimer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(readyTimer);
        const error = new Error("IndexTTS2 worker exited");
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();
        this.ready = undefined;
        this.child = undefined;
      });
    });
    return this.ready;
  }

  async synthesize(text: string, outputPath: string, seed: number, signal?: AbortSignal) {
    await this.start();
    const requestId = randomUUID();
    return new Promise<WorkerResult>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error("IndexTTS2 synthesis timeout")); }, this.config.tts.indextts.timeoutMs);
      const abort = () => { clearTimeout(timer); this.pending.delete(requestId); reject(signal?.reason instanceof Error ? signal.reason : new Error("IndexTTS2 synthesis aborted")); };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(requestId, { resolve: (value) => { signal?.removeEventListener("abort", abort); resolve(value); }, reject, timer });
      const cfg = this.config.tts.indextts;
      this.child!.stdin.write(`${JSON.stringify({ requestId, text, outputPath, seed, topP: cfg.topP, topK: cfg.topK, temperature: cfg.temperature, repetitionPenalty: cfg.repetitionPenalty })}\n`, "utf8");
    });
  }

  async dispose() {
    const child = this.child;
    this.child = undefined;
    this.ready = undefined;
    const error = new Error("IndexTTS2 worker disposed");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!child || child.exitCode !== null) return;
    child.stdin.end();
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    if (!graceful && child.exitCode === null) {
      child.kill();
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
    }
  }
}

let worker: IndexTtsWorker | undefined;

export async function releaseIndexTtsWorker() {
  const active = worker;
  worker = undefined;
  await active?.dispose();
}

export async function indexTts(input: { plan: PronunciationPlan; outputPath: string; force?: boolean; cacheSalt?: string; signal?: AbortSignal }, config = getRuntimeConfig()) {
  const pronunciation = indexTtsPronunciationInput(input.plan);
  const referenceDurationSeconds = await probeDuration(config.tts.indextts.refAudio);
  if (referenceDurationSeconds < config.tts.indextts.minimumReferenceSeconds) throw new Error(`IndexTTS2 reference audio must be at least ${config.tts.indextts.minimumReferenceSeconds}s; received ${referenceDurationSeconds.toFixed(2)}s.`);
  const referenceAudioHash = createHash("sha256").update(await readFile(config.tts.indextts.refAudio)).digest("hex");
  const seedIdentity = createHash("sha256").update(`${input.plan.planHash}:${input.cacheSalt ?? ""}`).digest("hex");
  const seedOffset = Number.parseInt(seedIdentity.slice(0, 8), 16);
  const seed = (config.tts.indextts.seed + seedOffset) & 0x7FFFFFFF;
  const identity = { provider: "indextts", model: "IndexTTS2", text: pronunciation.text, pronunciationPlanHash: input.plan.planHash, referenceAudioHash, referenceDurationSeconds, useRandom: false, seed, topP: config.tts.indextts.topP, topK: config.tts.indextts.topK, temperature: config.tts.indextts.temperature, repetitionPenalty: config.tts.indextts.repetitionPenalty, tempo: config.tts.indextts.tempo, loudnessLufs: config.tts.indextts.loudnessLufs, truePeakDb: config.tts.indextts.truePeakDb, frontendVersion: INDEXTTS_FRONTEND_VERSION, cacheSalt: input.cacheSalt ?? "" };
  const cacheKey = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  let result: WorkerResult | undefined;
  const cached = await getOrCreateMediaCache({
    kind: "audio", cacheKey, extension: ".wav", targetPath: input.outputPath, identity, force: input.force, signal: input.signal,
    generate: async (targetPath) => {
      worker ??= new IndexTtsWorker(config);
      const rawPath = targetPath.replace(/\.wav$/i, ".raw.wav");
      try {
        result = await worker.synthesize(pronunciation.text, rawPath, seed, input.signal);
        await run("ffmpeg", ["-y", "-i", rawPath, "-af", `highpass=f=55,afade=t=in:st=0:d=0.035,areverse,afade=t=in:st=0:d=0.055,areverse,atempo=${config.tts.indextts.tempo},loudnorm=I=${config.tts.indextts.loudnessLufs}:TP=${config.tts.indextts.truePeakDb}:LRA=7`, "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", targetPath]);
      } finally {
        await rm(rawPath, { force: true });
      }
      return { synthesisMs: result.synthesisMs, fixedReference: true, useRandom: false, seed, mixedPinyin: pronunciation.mixedPinyin };
    },
  });
  return { reused: !cached.generated, cacheKey, result: { requestId: result?.requestId ?? `cache-${cacheKey.slice(0, 12)}`, sceneIndex: 0, status: "succeeded" as const, outputPath: input.outputPath, durationSeconds: await probeDuration(input.outputPath), requestMs: result?.synthesisMs ?? 0, retryCount: 0, billedCharacters: 0, voice: "IndexTTS2.Fixed.Reference", region: "local", retryable: false, providerRequestId: result?.requestId, budgetUsedCharacters: 0, budgetRemainingCharacters: Number.MAX_SAFE_INTEGER, budgetWarning: false } };
}
