import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fromRoot } from "./utils";
import {
  f5WorkerReadySchema,
  f5WorkerRequestSchema,
  f5WorkerResultSchema,
  type F5WorkerReady,
  type F5WorkerRequest,
  type F5WorkerResult,
} from "./generated/f5-worker-protocol";

export {
  f5WorkerReadySchema,
  f5WorkerRequestSchema,
  f5WorkerResultSchema,
  type F5WorkerReady,
  type F5WorkerRequest,
  type F5WorkerResult,
} from "./generated/f5-worker-protocol";

class F5WorkerResultError extends Error {
  constructor(readonly result: F5WorkerResult) {
    super(`${result.errorType ?? "worker_error"}: ${result.error ?? "F5 worker request failed."}`);
  }
}

export interface F5WorkerMetrics {
  workerStartCount: number;
  workerStartupMs: number;
  modelLoadMs: number;
  queueWaitMs: number;
  synthesisMs: number;
}

export interface F5WorkerClientOptions {
  pythonCommand: string;
  workerScript?: string;
  model: string;
  device: string;
  refAudio: string;
  refText: string;
  lexiconPath: string;
  pronunciationLexiconHash: string;
  defaultNfeStep: number;
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxRestarts?: number;
  env?: NodeJS.ProcessEnv;
}

interface PendingRequest {
  requestId: string;
  resolve: (value: F5WorkerResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  abortCleanup?: () => void;
}

export class F5WorkerClient {
  private child?: ChildProcessWithoutNullStreams;
  private readyPromise?: Promise<F5WorkerReady>;
  private readyResolve?: (value: F5WorkerReady) => void;
  private readyReject?: (error: Error) => void;
  private readyTimer?: NodeJS.Timeout;
  private stdoutBuffer = "";
  private stderr = "";
  private pendingRequest?: PendingRequest;
  private serial = Promise.resolve();
  private disposed = false;
  private readonly exitHandler = () => this.killWorker();
  readonly metrics: F5WorkerMetrics = { workerStartCount: 0, workerStartupMs: 0, modelLoadMs: 0, queueWaitMs: 0, synthesisMs: 0 };

  constructor(private readonly options: F5WorkerClientOptions) {
    process.once("exit", this.exitHandler);
  }

  async start() {
    if (this.disposed) throw new Error("F5 worker client is disposed.");
    if (this.child && this.readyPromise) return this.readyPromise;
    const args = [
      this.options.workerScript ?? fromRoot("scripts", "f5-worker.py"),
      "--model", this.options.model,
      "--device", this.options.device,
      "--ref-audio", this.options.refAudio,
      "--ref-text", this.options.refText,
      "--lexicon", this.options.lexiconPath,
      "--default-nfe-step", String(this.options.defaultNfeStep),
      "--parent-pid", String(process.pid),
    ];
    this.stderr = "";
    this.stdoutBuffer = "";
    this.metrics.workerStartCount += 1;
    const child = spawn(this.options.pythonCommand, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...this.options.env },
    });
    this.child = child;
    this.readyPromise = new Promise<F5WorkerReady>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.readyTimer = setTimeout(() => {
      const error = new Error(`F5 worker ready timeout after ${this.options.readyTimeoutMs ?? 120_000}ms.`);
      this.readyReject?.(error);
      this.killWorker(error);
    }, this.options.readyTimeoutMs ?? 120_000);
    child.stdout.on("data", (chunk) => this.handleStdout(chunk.toString()));
    child.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${chunk.toString()}`.slice(-12_000); });
    child.on("error", (error) => this.handleWorkerExit(error));
    child.on("exit", (code, signal) => this.handleWorkerExit(new Error(`F5 worker exited code=${code} signal=${signal}: ${this.stderr}`)));
    return this.readyPromise;
  }

  synthesize(input: Omit<F5WorkerRequest, "type" | "requestId"> & { requestId?: string; signal?: AbortSignal }) {
    const enqueuedAt = Date.now();
    const run = async () => {
      this.metrics.queueWaitMs += Date.now() - enqueuedAt;
      if (input.signal?.aborted) throw input.signal.reason instanceof Error ? input.signal.reason : new Error("F5 request aborted.");
      const request = f5WorkerRequestSchema.parse({
        type: "synthesize",
        requestId: input.requestId ?? randomUUID(),
        sceneIndex: input.sceneIndex,
        text: input.text,
        outputPath: path.resolve(input.outputPath),
        speed: input.speed,
        nfeStep: input.nfeStep,
        seed: input.seed,
        pronunciationLexiconHash: input.pronunciationLexiconHash,
        pronunciationPhrasesBase64: input.pronunciationPhrasesBase64,
      });
      let lastError: Error | undefined;
      const attempts = Math.max(1, (this.options.maxRestarts ?? 1) + 1);
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          await this.startWithSignal(input.signal);
          const result = await this.sendRequest(request, input.signal);
          this.metrics.synthesisMs += result.synthesisMs;
          if (result.status === "failed") throw new F5WorkerResultError(result);
          return result;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          this.killWorker(lastError);
          if (error instanceof F5WorkerResultError && !error.result.retryable) break;
          if (attempt === attempts || input.signal?.aborted) break;
        }
      }
      throw lastError ?? new Error("F5 worker request failed.");
    };
    const result = this.serial.then(run, run);
    this.serial = result.then(() => undefined, () => undefined);
    return result;
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    process.removeListener("exit", this.exitHandler);
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 1_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`, () => child.stdin.end());
    });
    this.resetWorkerState();
  }

  private sendRequest(request: F5WorkerRequest, signal?: AbortSignal) {
    if (!this.child?.stdin.writable) throw new Error("F5 worker stdin is unavailable.");
    return new Promise<F5WorkerResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`F5 worker request timeout after ${this.options.requestTimeoutMs ?? 600_000}ms.`);
        reject(error);
        this.killWorker(error);
      }, this.options.requestTimeoutMs ?? 600_000);
      const onAbort = () => {
        const error = signal?.reason instanceof Error ? signal.reason : new Error("F5 worker request aborted.");
        clearTimeout(timer);
        reject(error);
        this.killWorker(error);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pendingRequest = {
        requestId: request.requestId,
        resolve,
        reject,
        timer,
        abortCleanup: () => signal?.removeEventListener("abort", onAbort),
      };
      this.child?.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error) {
          clearTimeout(timer);
          reject(error);
          this.killWorker(error);
        }
      });
    });
  }

  private startWithSignal(signal?: AbortSignal) {
    if (!signal) return this.start();
    if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("F5 worker startup aborted."));
    return new Promise<F5WorkerReady>((resolve, reject) => {
      const onAbort = () => {
        const error = signal.reason instanceof Error ? signal.reason : new Error("F5 worker startup aborted.");
        reject(error);
        this.killWorker(error);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.start().then(
        (ready) => { signal.removeEventListener("abort", onAbort); resolve(ready); },
        (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
      );
    });
  }

  private handleStdout(chunk: string) {
    this.stdoutBuffer += chunk;
    while (this.stdoutBuffer.includes("\n")) {
      const newline = this.stdoutBuffer.indexOf("\n");
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let payload: unknown;
      try { payload = JSON.parse(line); } catch { this.killWorker(new Error(`Invalid JSON from F5 worker: ${line}`)); continue; }
      const ready = f5WorkerReadySchema.safeParse(payload);
      if (ready.success) {
        if (ready.data.pronunciationLexiconHash !== this.options.pronunciationLexiconHash) {
          this.killWorker(new Error("F5 worker loaded a different pronunciation lexicon hash."));
          continue;
        }
        if (this.readyTimer) clearTimeout(this.readyTimer);
        this.metrics.workerStartupMs += ready.data.workerStartupMs;
        this.metrics.modelLoadMs += ready.data.modelLoadMs;
        this.readyResolve?.(ready.data);
        continue;
      }
      const result = f5WorkerResultSchema.safeParse(payload);
      if (!result.success) { this.killWorker(new Error(`Invalid F5 worker response: ${line}`)); continue; }
      if (!this.pendingRequest || result.data.requestId !== this.pendingRequest.requestId) {
        this.killWorker(new Error(`Unexpected F5 worker response for ${result.data.requestId}.`));
        continue;
      }
      clearTimeout(this.pendingRequest.timer);
      this.pendingRequest.abortCleanup?.();
      const pending = this.pendingRequest;
      this.pendingRequest = undefined;
      pending.resolve(result.data);
    }
  }

  private handleWorkerExit(error: Error) {
    if (!this.child && !this.readyPromise) return;
    this.readyReject?.(error);
    if (this.pendingRequest) {
      clearTimeout(this.pendingRequest.timer);
      this.pendingRequest.abortCleanup?.();
      this.pendingRequest.reject(error);
      this.pendingRequest = undefined;
    }
    this.resetWorkerState();
  }

  private killWorker(error = new Error("F5 worker stopped.")) {
    const child = this.child;
    if (child && !child.killed) child.kill();
    this.handleWorkerExit(error);
  }

  private resetWorkerState() {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.child = undefined;
    this.readyPromise = undefined;
    this.readyResolve = undefined;
    this.readyReject = undefined;
    this.readyTimer = undefined;
    this.stdoutBuffer = "";
  }
}
