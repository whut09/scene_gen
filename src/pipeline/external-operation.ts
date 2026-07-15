import { spawn } from "node:child_process";

export type ExternalFailureKind = "timeout" | "cancelled" | "rate-limit" | "server" | "network" | "process-exit" | "permanent";

export class ExternalOperationError extends Error {
  constructor(message: string, readonly kind: ExternalFailureKind, readonly retryable: boolean) {
    super(message);
    this.name = "ExternalOperationError";
  }
}

function delay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new ExternalOperationError("Operation cancelled.", "cancelled", false));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: { timeoutMs?: number; retries?: number; signal?: AbortSignal; label?: string } = {},
) {
  const retries = Math.max(0, options.retries ?? 2);
  const timeoutMs = options.timeoutMs ?? Number(process.env.EXTERNAL_FETCH_TIMEOUT_MS ?? 90_000);
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new ExternalOperationError(`${options.label ?? "fetch"} timed out.`, "timeout", true)), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const retryableStatus = response.status === 429 || response.status >= 500;
      if (!retryableStatus || attempt === retries) return response;
      await response.body?.cancel().catch(() => undefined);
      await delay(500 * 2 ** attempt, options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw new ExternalOperationError(`${options.label ?? "fetch"} cancelled.`, "cancelled", false);
      const timeout = controller.signal.aborted;
      if (attempt === retries) {
        throw error instanceof ExternalOperationError
          ? error
          : new ExternalOperationError(`${options.label ?? "fetch"} failed: ${(error as Error).message}`, timeout ? "timeout" : "network", true);
      }
      await delay(500 * 2 ** attempt, options.signal);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
  throw new ExternalOperationError(`${options.label ?? "fetch"} failed.`, "network", true);
}

export async function runExternalProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs?: number;
    retries?: number;
    retryOnExit?: boolean;
    signal?: AbortSignal;
    inheritOutput?: boolean;
  } = {},
) {
  const retries = Math.max(0, options.retries ?? 0);
  const timeoutMs = options.timeoutMs ?? Number(process.env.EXTERNAL_PROCESS_TIMEOUT_MS ?? 300_000);
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(command, args, {
          cwd: options.cwd,
          env: options.env,
          windowsHide: true,
          stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          callback();
        };
        const terminate = () => {
          if (!child.killed) child.kill("SIGTERM");
        };
        const onAbort = () => {
          terminate();
          finish(() => reject(new ExternalOperationError(`${command} cancelled.`, "cancelled", false)));
        };
        const timer = setTimeout(() => {
          terminate();
          finish(() => reject(new ExternalOperationError(`${command} timed out after ${timeoutMs}ms.`, "timeout", true)));
        }, timeoutMs);
        options.signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout?.on("data", (chunk) => {
          const text = chunk.toString();
          stdout = `${stdout}${text}`.slice(-100_000);
          if (options.inheritOutput) process.stdout.write(text);
        });
        child.stderr?.on("data", (chunk) => {
          const text = chunk.toString();
          stderr = `${stderr}${text}`.slice(-100_000);
          if (options.inheritOutput) process.stderr.write(text);
        });
        child.on("error", (error) => finish(() => reject(new ExternalOperationError(`${command} failed to start: ${error.message}`, "network", true))));
        child.on("close", (code) => finish(() => {
          if (code === 0) resolve({ stdout, stderr });
          else {
            const transient = Boolean(options.retryOnExit) && (
              code !== 1 || /429|5\d\d|ECONN|ETIMEDOUT|timed?\s*out|temporar|connection reset|unexpected eof|network/i.test(stderr)
            );
            reject(new ExternalOperationError(`${command} exited with code ${code}${stderr ? `\n${stderr.slice(-8000)}` : ""}`, "process-exit", transient));
          }
        }));
        if (options.input) {
          child.stdin?.write(options.input);
          child.stdin?.end();
        }
      });
    } catch (error) {
      const retryable = error instanceof ExternalOperationError && error.retryable;
      if (!retryable || attempt === retries) throw error;
      await delay(500 * 2 ** attempt, options.signal);
    }
  }
  throw new ExternalOperationError(`${command} failed.`, "permanent", false);
}
