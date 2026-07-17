import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRuntimeConfig } from "../../src/config/runtime-config";
import { assessAzurePronunciation } from "../../src/harness/quality/azure-pronunciation-assessment";

function wavBuffer(durationSeconds = 1, sampleRate = 16_000) {
  const samples = Math.max(1, Math.floor(durationSeconds * sampleRate));
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + dataSize, 4); buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

async function server(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const instance = createServer((request, response) => void Promise.resolve(handler(request, response)));
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  const address = instance.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return { endpoint: `http://127.0.0.1:${address.port}/assessment`, close: () => new Promise<void>((resolve, reject) => instance.close((error) => error ? reject(error) : resolve())) };
}

function config(root: string, endpoint: string, overrides: NodeJS.ProcessEnv = {}) {
  return buildRuntimeConfig({ ...process.env, SCENE_GEN_CACHE_DIR: path.join(root, "cache"), PRONUNCIATION_VERIFIER_PROVIDER: "azure", AZURE_PRONUNCIATION_KEY: "pronunciation-secret", AZURE_PRONUNCIATION_ENDPOINT: endpoint, AZURE_PRONUNCIATION_MONTHLY_SECONDS_BUDGET: "60", ...overrides }, "test");
}

test("Azure pronunciation assessment requests SAPI phoneme granularity and parses acoustic evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scene-gen-azure-assessment-"));
  let header = "";
  let key = "";
  const mock = await server((request, response) => {
    header = String(request.headers["pronunciation-assessment"] ?? "");
    key = String(request.headers["ocp-apim-subscription-key"] ?? "");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ NBest: [{ Words: [{ Word: "重构", Offset: 1_000_000, Duration: 8_000_000, Phonemes: [
      { Phoneme: "chong 2", PronunciationAssessment: { AccuracyScore: 95, NBestPhonemes: [{ Phoneme: "chong 2", Score: 95 }] } },
      { Phoneme: "gou 4", PronunciationAssessment: { AccuracyScore: 97, NBestPhonemes: [{ Phoneme: "gou 4", Score: 97 }] } },
    ] }] }] }));
  });
  try {
    const audioPath = path.join(root, "scene.wav");
    await writeFile(audioPath, wavBuffer());
    const result = await assessAzurePronunciation({ audioPath, referenceText: "系统完成重构", phrase: "重构", expectedPinyin: ["chong2", "gou4"] }, config(root, mock.endpoint));
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    assert.equal(decoded.granularity, "Phoneme");
    assert.equal(decoded.phonemeAlphabet, "SAPI");
    assert.equal(decoded.nBestPhonemeCount, 5);
    assert.equal(key, "pronunciation-secret");
    assert.deepEqual(result.actualPinyin, ["chong 2", "gou 4"]);
    assert.equal(result.startMs, 100);
    assert.equal(result.endMs, 900);
    assert.equal(result.confidence, 0.96);
  } finally { await mock.close(); await rm(root, { recursive: true, force: true }); }
});

test("Azure pronunciation assessment quota exhaustion is inconclusive without HTTP", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scene-gen-azure-assessment-budget-"));
  let calls = 0;
  const mock = await server((_request, response) => { calls += 1; response.end("{}"); });
  try {
    const audioPath = path.join(root, "scene.wav");
    await writeFile(audioPath, wavBuffer(2));
    const result = await assessAzurePronunciation({ audioPath, referenceText: "重构", phrase: "重构", expectedPinyin: ["chong2", "gou4"] }, config(root, mock.endpoint, { AZURE_PRONUNCIATION_MONTHLY_SECONDS_BUDGET: "1" }));
    assert.equal(result.status, "inconclusive");
    assert.equal(result.reason, "quota_exhausted");
    assert.equal(calls, 0);
  } finally { await mock.close(); await rm(root, { recursive: true, force: true }); }
});
