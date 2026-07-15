import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rankProviders, selectProviderWithAudit } from "../../src/production/provider-registry";
import { calculateProviderStats, readProviderOutcomes, recordProviderOutcome } from "../../src/production/provider-stats";

function outcome(providerId: string, index: number, input: Partial<Record<string, unknown>> = {}) {
  return {
    version: 1,
    createdAt: `2026-07-15T00:${String(index).padStart(2, "0")}:00.000Z`,
    providerId,
    capability: "tts",
    operation: "test",
    success: true,
    latencyMs: 10_000,
    timeout: false,
    retryCount: 0,
    cost: 0,
    unitKind: "chars",
    unitCount: 1000,
    qualityScore: 0.9,
    pronunciationAccurate: true,
    language: "zh-CN",
    domain: "software",
    ...input,
  };
}

test("provider stats calculate rolling reliability, latency, retries, cost and health", { concurrency: false }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scene-gen-provider-stats-"));
  const filePath = path.join(directory, "outcomes.jsonl");
  const originalFile = process.env.PROVIDER_OUTCOME_FILE;
  process.env.PROVIDER_OUTCOME_FILE = filePath;
  try {
    const records = [
      outcome("openai-tts", 1, { latencyMs: 1000, cost: 0.02 }),
      outcome("openai-tts", 2, { latencyMs: 2000, cost: 0.03, retryCount: 1 }),
      outcome("openai-tts", 3, { latencyMs: 9000, cost: 0, success: false, timeout: true, pronunciationAccurate: false }),
    ];
    await writeFile(filePath, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
    const stats = calculateProviderStats("openai-tts", { profile: "production", language: "zh-CN", domain: "software" }, { quality: 0.9, latency: 0.35, cost: 0.2, pronunciationAccuracy: 0.9 });
    assert.equal(stats.samples, 3);
    assert.equal(stats.p50LatencyMs, 2000);
    assert.equal(stats.p95LatencyMs, 9000);
    assert.equal(stats.timeoutRate, 0.3333);
    assert.equal(stats.retryRate, 0.3333);
    assert.equal(stats.actualCostPer1000Chars, 0.05 / 3);
    assert.equal(stats.pronunciationAccuracy, 0.6667);
    assert.equal(stats.health, "degraded");
  } finally {
    if (originalFile === undefined) delete process.env.PROVIDER_OUTCOME_FILE; else process.env.PROVIDER_OUTCOME_FILE = originalFile;
    await rm(directory, { recursive: true, force: true });
  }
});

test("profile weighting favors latency for preview and reliability for production", { concurrency: false }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scene-gen-provider-rank-"));
  const filePath = path.join(directory, "outcomes.jsonl");
  const originalFile = process.env.PROVIDER_OUTCOME_FILE;
  const originalOpenAi = process.env.OPENAI_API_KEY;
  const originalF5 = process.env.F5_TTS_PYTHON;
  process.env.PROVIDER_OUTCOME_FILE = filePath;
  process.env.OPENAI_API_KEY = "test";
  process.env.F5_TTS_PYTHON = "python";
  try {
    const records = Array.from({ length: 20 }, (_, index) => [
      outcome("f5", index, { latencyMs: 105_000, qualityScore: 0.99, pronunciationAccurate: true, success: index !== 19 }),
      outcome("openai-tts", index + 20, { latencyMs: 4000, qualityScore: 0.8, pronunciationAccurate: index % 3 !== 0, success: index % 5 !== 0, cost: 0.02 }),
    ]).flat();
    await writeFile(filePath, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
    const preview = selectProviderWithAudit("tts", ["openai-tts", "f5", "local-tts"], { profile: "fast-preview", language: "zh-CN", domain: "software" });
    const production = selectProviderWithAudit("tts", ["f5", "openai-tts", "local-tts"], { profile: "production", language: "zh-CN", domain: "software", highRiskTerms: true });
    assert.equal(preview.selected?.id, "openai-tts");
    assert.equal(production.selected?.id, "f5");
    assert.ok(production.audit.candidates.every((candidate) => candidate.reasons.length > 0));
    assert.ok(production.audit.candidates.find((candidate) => candidate.providerId === "f5")!.reasons.some((reason) => reason.startsWith("pronunciation")));
  } finally {
    if (originalFile === undefined) delete process.env.PROVIDER_OUTCOME_FILE; else process.env.PROVIDER_OUTCOME_FILE = originalFile;
    if (originalOpenAi === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalOpenAi;
    if (originalF5 === undefined) delete process.env.F5_TTS_PYTHON; else process.env.F5_TTS_PYTHON = originalF5;
    await rm(directory, { recursive: true, force: true });
  }
});

test("unhealthy APIs are eliminated and F5 memory pressure is penalized", { concurrency: false }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scene-gen-provider-health-"));
  const filePath = path.join(directory, "outcomes.jsonl");
  const originalFile = process.env.PROVIDER_OUTCOME_FILE;
  const originalOpenAi = process.env.OPENAI_API_KEY;
  const originalF5 = process.env.F5_TTS_PYTHON;
  process.env.PROVIDER_OUTCOME_FILE = filePath;
  process.env.OPENAI_API_KEY = "test";
  process.env.F5_TTS_PYTHON = "python";
  try {
    const records = [
      ...Array.from({ length: 5 }, (_, index) => outcome("f5", index, { latencyMs: 20_000 })),
      ...Array.from({ length: 3 }, (_, index) => outcome("openai-tts", index + 5, { success: false, timeout: true, errorType: "timeout" })),
    ];
    await writeFile(filePath, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
    const ranked = rankProviders("tts", ["openai-tts", "f5"], { profile: "production" });
    assert.equal(ranked.find((candidate) => candidate.providerId === "openai-tts")?.eliminated, true);
    const pressured = rankProviders("tts", ["f5", "openai-tts"], { profile: "production", memoryPressure: true });
    assert.ok(pressured.find((candidate) => candidate.providerId === "f5")!.reasons.some((reason) => reason.includes("GPU memory pressure")));
  } finally {
    if (originalFile === undefined) delete process.env.PROVIDER_OUTCOME_FILE; else process.env.PROVIDER_OUTCOME_FILE = originalFile;
    if (originalOpenAi === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalOpenAi;
    if (originalF5 === undefined) delete process.env.F5_TTS_PYTHON; else process.env.F5_TTS_PYTHON = originalF5;
    await rm(directory, { recursive: true, force: true });
  }
});

test("provider outcome writes are schema validated", { concurrency: false }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scene-gen-provider-write-"));
  const filePath = path.join(directory, "outcomes.jsonl");
  const originalFile = process.env.PROVIDER_OUTCOME_FILE;
  process.env.PROVIDER_OUTCOME_FILE = filePath;
  try {
    await recordProviderOutcome({ providerId: "f5", capability: "tts", operation: "test", success: true, latencyMs: 1234, timeout: false, retryCount: 0, cost: 0, unitKind: "chars", unitCount: 200, qualityScore: 0.95 });
    assert.equal(readProviderOutcomes().length, 1);
    await assert.rejects(() => recordProviderOutcome({ providerId: "f5", capability: "tts", operation: "test", success: true, latencyMs: -1, timeout: false, retryCount: 0, cost: 0, unitKind: "chars", unitCount: 200 }));
  } finally {
    if (originalFile === undefined) delete process.env.PROVIDER_OUTCOME_FILE; else process.env.PROVIDER_OUTCOME_FILE = originalFile;
    await rm(directory, { recursive: true, force: true });
  }
});
