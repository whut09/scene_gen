import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { fromRoot } from "../utils";

export const g2pwPredictionSchema = z.object({ phrase: z.string().min(1), start: z.number().int().nonnegative(), end: z.number().int().positive(), pinyin: z.array(z.string()).min(1), confidence: z.number().min(0).max(1) }).strict();
const responseSchema = z.object({ type: z.literal("result"), requestId: z.string(), status: z.enum(["succeeded", "failed"]), predictions: z.array(g2pwPredictionSchema).default([]), error: z.string().optional() }).strict();
const readySchema = z.object({ type: z.literal("ready"), status: z.enum(["ready", "unavailable"]), modelLoadMs: z.number().nonnegative(), error: z.string().optional() }).strict();

export type G2pwPrediction = z.infer<typeof g2pwPredictionSchema>;
export interface G2pwPredictor { predict(text: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<G2pwPrediction[]> }

export class G2pwWorkerClient implements G2pwPredictor {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private buffer = "";
  private pending = new Map<string, { resolve: (value: G2pwPrediction[]) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; abort?: () => void }>();

  constructor(private readonly options: { python?: string; script?: string; modelDir?: string; readyTimeoutMs?: number; requestTimeoutMs?: number; pypinyinOnly?: boolean } = {}) {}

  private start() {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.python ?? (process.platform === "win32" ? "python" : "python3"), [this.options.script ?? fromRoot("scripts", "g2pw-worker.py"), ...(this.options.modelDir ? ["--model-dir", path.resolve(this.options.modelDir)] : []), ...(this.options.pypinyinOnly ? ["--pypinyin-only"] : [])], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
      this.child = child;
      const timer = setTimeout(() => reject(new Error("G2PW worker ready timeout.")), this.options.readyTimeoutMs ?? 30_000);
      const onReady = (line: string) => {
        const parsed = readySchema.safeParse(JSON.parse(line));
        if (!parsed.success) return;
        clearTimeout(timer);
        parsed.data.status === "ready" ? resolve() : reject(new Error(parsed.data.error ?? "G2PW worker unavailable."));
      };
      child.stdout.on("data", (chunk) => this.handleData(chunk.toString(), onReady));
      child.stderr.on("data", () => undefined);
      child.on("exit", () => this.failPending(new Error("G2PW worker exited.")));
      child.on("error", (error) => { clearTimeout(timer); reject(error); this.failPending(error); });
    });
    return this.ready;
  }

  private handleData(chunk: string, onReady?: (line: string) => void) {
    this.buffer += chunk;
    while (this.buffer.includes("\n")) {
      const newline = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      if (onReady) onReady(line);
      const parsed = responseSchema.safeParse(JSON.parse(line));
      if (!parsed.success) continue;
      const pending = this.pending.get(parsed.data.requestId);
      if (!pending) continue;
      clearTimeout(pending.timer);
      pending.abort?.();
      this.pending.delete(parsed.data.requestId);
      parsed.data.status === "succeeded" ? pending.resolve(parsed.data.predictions) : pending.reject(new Error(parsed.data.error ?? "G2PW prediction failed."));
    }
  }

  private async predictMode(text: string, mode: "g2pw" | "pypinyin", options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
    await this.start();
    if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error("G2PW prediction aborted.");
    const requestId = randomUUID();
    return new Promise<G2pwPrediction[]>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error("G2PW prediction timeout.")); }, options.timeoutMs ?? this.options.requestTimeoutMs ?? 10_000);
      const onAbort = () => { clearTimeout(timer); this.pending.delete(requestId); reject(options.signal?.reason instanceof Error ? options.signal.reason : new Error("G2PW prediction aborted.")); };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(requestId, { resolve, reject, timer, abort: () => options.signal?.removeEventListener("abort", onAbort) });
      this.child?.stdin.write(`${JSON.stringify({ type: "predict", requestId, text, mode })}\n`);
    });
  }

  predict(text: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
    return this.predictMode(text, "g2pw", options);
  }

  pypinyin(text: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
    return this.predictMode(text, "pypinyin", options);
  }

  private failPending(error: Error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.abort?.(); pending.reject(error); }
    this.pending.clear();
    this.child = undefined;
    this.ready = undefined;
  }

  async dispose() {
    if (!this.child) return;
    this.child.stdin.end(`${JSON.stringify({ type: "shutdown" })}\n`);
    this.child.kill();
    this.failPending(new Error("G2PW worker disposed."));
  }
}
