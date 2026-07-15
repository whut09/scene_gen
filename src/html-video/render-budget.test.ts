import assert from "node:assert/strict";
import test from "node:test";
import { resolveHtmlRenderBudget } from "./render-budget";

test("HTML render budget respects profile, CPU, memory and scene limits", () => {
  const configured = resolveHtmlRenderBudget(5, { HTML_RENDER_CONCURRENCY: "3", HTML_RENDER_MEMORY_PER_JOB_MB: "1024", HTML_RENDER_PRESET: "medium" }, { cpuCount: 8, availableMemoryBytes: 16 * 1024 ** 3 });
  assert.equal(configured.renderConcurrency, 3);
  assert.equal(configured.ffmpegThreadsPerJob, 2);
  assert.equal(configured.encodingPreset, "medium");

  assert.equal(resolveHtmlRenderBudget(5, { HTML_RENDER_CONCURRENCY: "4" }, { cpuCount: 2, availableMemoryBytes: 16 * 1024 ** 3 }).renderConcurrency, 2);
  assert.equal(resolveHtmlRenderBudget(5, { HTML_RENDER_CONCURRENCY: "4", HTML_RENDER_MEMORY_PER_JOB_MB: "2048" }, { cpuCount: 8, availableMemoryBytes: 3 * 1024 ** 3 }).renderConcurrency, 1);
  assert.equal(resolveHtmlRenderBudget(1, { HTML_RENDER_CONCURRENCY: "4" }, { cpuCount: 8, availableMemoryBytes: 16 * 1024 ** 3 }).renderConcurrency, 1);
});
