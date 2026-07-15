import { F5WorkerClient, type F5WorkerClientOptions, type F5WorkerRequest } from "./f5-worker-client";

export function resolveF5WorkerDevices(env: NodeJS.ProcessEnv = process.env) {
  const configured = (env.F5_TTS_DEVICES ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const devices = [...new Set(configured.length ? configured : [env.F5_TTS_DEVICE ?? "cuda"])];
  const requested = Math.max(1, Number(env.F5_TTS_CONCURRENCY ?? devices.length));
  return devices.slice(0, Math.min(devices.length, requested));
}

export class F5WorkerPool {
  private nextClient = 0;
  readonly clients: F5WorkerClient[];

  constructor(options: Omit<F5WorkerClientOptions, "device"> & { devices: string[] }) {
    if (options.devices.length === 0) throw new Error("F5 worker pool requires at least one device.");
    this.clients = options.devices.map((device) => new F5WorkerClient({ ...options, device }));
  }

  get concurrency() {
    return this.clients.length;
  }

  synthesize(input: Omit<F5WorkerRequest, "type" | "requestId"> & { requestId?: string; signal?: AbortSignal }) {
    const client = this.clients[this.nextClient % this.clients.length];
    this.nextClient += 1;
    return client.synthesize(input);
  }

  metrics() {
    return this.clients.reduce((total, client) => ({
      workerStartCount: total.workerStartCount + client.metrics.workerStartCount,
      workerStartupMs: total.workerStartupMs + client.metrics.workerStartupMs,
      modelLoadMs: total.modelLoadMs + client.metrics.modelLoadMs,
      queueWaitMs: total.queueWaitMs + client.metrics.queueWaitMs,
      synthesisMs: total.synthesisMs + client.metrics.synthesisMs,
    }), { workerStartCount: 0, workerStartupMs: 0, modelLoadMs: 0, queueWaitMs: 0, synthesisMs: 0 });
  }

  async dispose() {
    await Promise.all(this.clients.map((client) => client.dispose()));
  }
}
