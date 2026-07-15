import { availableParallelism, freemem } from "node:os";

export type HtmlEncodingPreset = "ultrafast" | "veryfast" | "medium";

export interface HtmlRenderBudget {
  renderConcurrency: number;
  ffmpegThreadsPerJob: number;
  encodingPreset: HtmlEncodingPreset;
  cpuCount: number;
  availableMemoryBytes: number;
}

export function resolveHtmlEncodingPreset(env: NodeJS.ProcessEnv = process.env): HtmlEncodingPreset {
  const value = env.HTML_RENDER_PRESET?.trim().toLowerCase();
  return value === "ultrafast" || value === "medium" ? value : "veryfast";
}

export function resolveHtmlRenderBudget(
  sceneCount: number,
  env: NodeJS.ProcessEnv = process.env,
  system: { cpuCount?: number; availableMemoryBytes?: number } = {},
): HtmlRenderBudget {
  const cpuCount = Math.max(1, Math.floor(system.cpuCount ?? availableParallelism()));
  const availableMemoryBytes = Math.max(0, system.availableMemoryBytes ?? freemem());
  const requested = Math.max(1, Math.floor(Number(env.HTML_RENDER_CONCURRENCY ?? 2) || 2));
  const memoryPerJobMb = Math.max(256, Number(env.HTML_RENDER_MEMORY_PER_JOB_MB ?? 1536) || 1536);
  const memoryLimit = Math.max(1, Math.floor(availableMemoryBytes / (memoryPerJobMb * 1024 * 1024)));
  const renderConcurrency = Math.max(1, Math.min(requested, cpuCount, memoryLimit, Math.max(1, sceneCount)));
  return {
    renderConcurrency,
    ffmpegThreadsPerJob: Math.max(1, Math.floor(cpuCount / renderConcurrency)),
    encodingPreset: resolveHtmlEncodingPreset(env),
    cpuCount,
    availableMemoryBytes,
  };
}
