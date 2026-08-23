import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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

async function fetchWithCurlFallback(url: string, init: RequestInit, timeoutMs: number) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "scene-gen-http-"));
  const outputPath = path.join(tempDir, "response.body");
  const inputPath = path.join(tempDir, "request.body");
  const curl = process.platform === "win32" ? "curl.exe" : "curl";
  try {
    const headers = new Headers(init.headers);
    const args = [
      "--location",
      "--silent",
      "--show-error",
      "--request",
      init.method ?? "GET",
      "--max-time",
      String(Math.max(1, Math.ceil(timeoutMs / 1000))),
      "--user-agent",
      headers.get("user-agent") ?? "scene-gen/0.1",
    ];
    headers.delete("content-length");
    for (const [name, value] of headers.entries()) args.push("--header", `${name}: ${value}`);
    if (typeof init.body === "string") {
      await writeFile(inputPath, init.body, "utf8");
      args.push("--data-binary", `@${inputPath}`);
    }
    args.push("--output", outputPath, "--write-out", "%{http_code}", url);
    const result = await runExternalProcess(curl, args, { timeoutMs: timeoutMs + 5000 });
    const status = Number.parseInt(result.stdout.trim(), 10);
    if (!Number.isInteger(status) || status < 100) throw new Error("curl returned an invalid HTTP status");
    const body = await readFile(outputPath);
    return new Response(body, {
      status,
      headers: { "content-type": headers.get("content-type") ?? "application/octet-stream" },
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: { timeoutMs?: number; retries?: number; signal?: AbortSignal; label?: string; allowCurlFallback?: boolean } = {},
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
        if (!options.signal?.aborted) {
          try {
            if (options.allowCurlFallback === false) throw new Error("curl fallback disabled");
            return await fetchWithCurlFallback(url, init, timeoutMs);
          } catch {
            // Preserve the original fetch error when the platform fallback also fails.
          }
        }
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
