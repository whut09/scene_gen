import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRuntimeConfig, runWithRuntimeConfig } from "../../src/config/runtime-config";
import { pronunciationPlanHash, type PronunciationPlan } from "../../src/pipeline/pronunciation/schema";
import { PronunciationAttemptLedger, routeTtsProvider } from "../../src/production/tts-routing";

function plan(text: string, highRisk = false): PronunciationPlan {
  const base = {
    displayText: text,
    semanticText: text,
    synthesisText: text,
    spans: highRisk ? [{ phrase: "重构", start: text.indexOf("重构"), end: text.indexOf("重构") + 2, expectedPinyin: ["chong2", "gou4"], source: "manual" as const, confidence: 1, risk: "high" as const, spokenFallback: "重新构建", providerOverrides: {} }] : [],
    frontendVersion: "test-v1",
  };
  return { ...base, planHash: pronunciationPlanHash(base) };
}

async function withRoutingEnv(env: NodeJS.ProcessEnv, task: () => Promise<void>) {
  const original = { ...process.env };
  Object.assign(process.env, env);
  try { await task(); } finally {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  }
}

test("production high-risk text selects Azure explicit phoneme", { concurrency: false }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scene-gen-routing-"));
  try {
    await withRoutingEnv({ AZURE_SPEECH_KEY: "test", AZURE_SPEECH_REGION: "eastasia", SCENE_GEN_CACHE_DIR: directory, PROVIDER_OUTCOME_FILE: path.join(directory, "outcomes.jsonl") }, async () => {
      const config = buildRuntimeConfig(process.env, "production");
      await runWithRuntimeConfig(config, async () => {
        const routed = await routeTtsProvider({ profile: "production", plan: plan("系统完成重构", true) });
        assert.equal(routed.selectedProvider, "azure");
        assert.equal(routed.pronunciationStrategy, "switch-pronunciation-mode");
      });
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Azure hard quota falls back and Edge is excluded from production", { concurrency: false }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scene-gen-routing-quota-"));
  try {
    await writeFile(path.join(directory, "metadata", "placeholder"), "", { flag: "a" }).catch(() => undefined);
    await withRoutingEnv({ AZURE_SPEECH_KEY: "test", AZURE_SPEECH_REGION: "eastasia", AZURE_TTS_MONTHLY_CHARACTER_BUDGET: "1", EDGE_TTS_COMMAND: "edge-tts", F5_TTS_PYTHON: "python", SCENE_GEN_CACHE_DIR: directory }, async () => {
      const config = buildRuntimeConfig(process.env, "production");
      await runWithRuntimeConfig(config, async () => {
        const usagePath = path.join(directory, "metadata", "azure-tts-usage.json");
        await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(usagePath), { recursive: true }));
        await writeFile(usagePath, JSON.stringify({ version: 1, month: new Date().toISOString().slice(0, 7), usedCharacters: 1, updatedAt: new Date().toISOString() }));
        const routed = await routeTtsProvider({ profile: "production", plan: plan("系统完成重构", true) });
        assert.equal(routed.selectedProvider, "f5");
        assert.equal(routed.candidates.find((candidate) => candidate.providerId === "azure")?.eliminated, true);
        assert.equal(routed.candidates.find((candidate) => candidate.providerId === "edge")?.eliminated, true);
      });
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("attempt ledger prevents repeated F5 strategy and enforces scene budgets", () => {
  const ledger = new PronunciationAttemptLedger();
  const identity = { phraseFingerprint: "phrase", provider: "f5", pronunciationStrategy: "switch-pronunciation-mode" as const, pronunciationPlanHash: "plan" };
  assert.equal(ledger.claim(2, identity), true);
  assert.equal(ledger.claim(2, identity), false);
  assert.equal(ledger.claim(2, { ...identity, pronunciationStrategy: "use-spoken-fallback" }), true);
  assert.equal(ledger.claim(2, { ...identity, provider: "azure", pronunciationStrategy: "switch-tts-provider" }), false);
  assert.equal(ledger.claimProviderSwitch(2), true);
  assert.equal(ledger.claimProviderSwitch(2), false);
  assert.equal(ledger.claimVerification(2), true);
  assert.equal(ledger.claimVerification(2), false);
  assert.equal(ledger.metrics().avoidedTtsRegenerationCount, 2);
});

test("explicit F5 selection is not replaced by ci-offline mock", { concurrency: false }, async () => {
  await withRoutingEnv({ SCENE_GEN_PROFILE: "ci-offline", TTS_PROVIDER: "mock", F5_TTS_PYTHON: "python" }, async () => {
    const routed = await routeTtsProvider({ profile: "ci-offline", plan: plan("系统完成重构", true), explicitProvider: "f5" });
    assert.equal(routed.selectedProvider, "f5");
    assert.equal(routed.candidates.find((candidate) => candidate.providerId === "mock")?.eliminated, true);
  });
});
