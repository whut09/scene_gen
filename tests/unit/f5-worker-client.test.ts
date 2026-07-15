import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { F5WorkerClient } from "../../src/pipeline/f5-worker-client";
import { resolveF5WorkerDevices } from "../../src/pipeline/f5-worker-pool";
import { attachNarrationAudio } from "../../src/pipeline/tts";
import { loadTtsPronunciationLexicon } from "../../src/pipeline/tts-pronunciation";
import { fromRoot } from "../../src/pipeline/utils";
import { resolvePythonCommand } from "../../src/runtime/runtime-paths";
import { createFixtureProject } from "../fixtures/project";

async function lines(filePath: string) {
  return readFile(filePath, "utf8").then((value) => value.trim().split(/\r?\n/).filter(Boolean)).catch(() => []);
}

async function fixtureOptions(env: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scene-gen-f5-client-"));
  const refAudio = path.join(directory, "reference.wav");
  await writeFile(refAudio, "fixture");
  const lexicon = loadTtsPronunciationLexicon();
  return {
    directory,
    options: {
      pythonCommand: resolvePythonCommand(),
      workerScript: fromRoot("tests", "fixtures", "mock-f5-worker.py"),
      model: "mock-f5",
      device: "cuda:0",
      refAudio,
      refText: "reference",
      lexiconPath: lexicon.filePath,
      pronunciationLexiconHash: lexicon.hash,
      defaultNfeStep: 16,
      readyTimeoutMs: 2_000,
      requestTimeoutMs: 2_000,
      maxRestarts: 1,
      env,
    },
  };
}

function request(outputPath: string, sceneIndex = 0, signal?: AbortSignal) {
  return {
    sceneIndex,
    text: `scene ${sceneIndex}`,
    outputPath,
    speed: 1.1,
    nfeStep: 16,
    seed: -1,
    pronunciationLexiconHash: loadTtsPronunciationLexicon().hash,
    signal,
  };
}

test("persistent F5 worker handles multiple requests after one model start", async () => {
  const startCount = path.join(os.tmpdir(), `f5-start-${Date.now()}.txt`);
  const requestCount = path.join(os.tmpdir(), `f5-request-${Date.now()}.txt`);
  const fixture = await fixtureOptions({ MOCK_F5_START_COUNT_FILE: startCount, MOCK_F5_REQUEST_COUNT_FILE: requestCount });
  const client = new F5WorkerClient(fixture.options);
  try {
    const [first, second] = await Promise.all([
      client.synthesize(request(path.join(fixture.directory, "first.wav"), 0)),
      client.synthesize(request(path.join(fixture.directory, "second.wav"), 1)),
    ]);
    assert.equal(first.status, "succeeded");
    assert.equal(second.status, "succeeded");
    assert.equal((await lines(startCount)).length, 1);
    assert.equal((await lines(requestCount)).length, 2);
    assert.equal(client.metrics.workerStartCount, 1);
    assert.ok(client.metrics.queueWaitMs >= 0);
  } finally {
    await client.dispose();
  }
});

test("F5 worker ready timeout terminates startup", async () => {
  const fixture = await fixtureOptions({ MOCK_F5_MODE: "no-ready" });
  const client = new F5WorkerClient({ ...fixture.options, readyTimeoutMs: 100, maxRestarts: 0 });
  await assert.rejects(client.start(), /ready timeout/i);
  await client.dispose();
});

test("F5 worker restarts once after a crash", async () => {
  const startCount = path.join(os.tmpdir(), `f5-restart-${Date.now()}.txt`);
  const crashState = path.join(os.tmpdir(), `f5-crash-${Date.now()}.txt`);
  const fixture = await fixtureOptions({
    MOCK_F5_MODE: "crash-first",
    MOCK_F5_START_COUNT_FILE: startCount,
    MOCK_F5_CRASH_STATE_FILE: crashState,
  });
  const client = new F5WorkerClient(fixture.options);
  try {
    const result = await client.synthesize(request(path.join(fixture.directory, "restart.wav")));
    assert.equal(result.status, "succeeded");
    assert.equal((await lines(startCount)).length, 2);
    assert.equal(client.metrics.workerStartCount, 2);
  } finally {
    await client.dispose();
  }
});

test("F5 worker request honors AbortSignal", async () => {
  const fixture = await fixtureOptions({ MOCK_F5_DELAY_MS: "2000" });
  const client = new F5WorkerClient(fixture.options);
  const controller = new AbortController();
  const pending = client.synthesize(request(path.join(fixture.directory, "aborted.wav"), 0, controller.signal));
  setTimeout(() => controller.abort(new Error("test cancellation")), 100);
  await assert.rejects(pending, /test cancellation/);
  await client.dispose();
});

test("F5 worker startup honors AbortSignal", async () => {
  const fixture = await fixtureOptions({ MOCK_F5_MODE: "delayed-ready", MOCK_F5_DELAY_MS: "2000" });
  const client = new F5WorkerClient(fixture.options);
  const controller = new AbortController();
  const pending = client.synthesize(request(path.join(fixture.directory, "startup-aborted.wav"), 0, controller.signal));
  setTimeout(() => controller.abort(new Error("startup cancellation")), 100);
  await assert.rejects(pending, /startup cancellation/);
  await client.dispose();
});

test("F5 worker devices enforce one worker per configured GPU", () => {
  assert.deepEqual(resolveF5WorkerDevices({ F5_TTS_DEVICE: "cuda:0", F5_TTS_CONCURRENCY: "4" }), ["cuda:0"]);
  assert.deepEqual(resolveF5WorkerDevices({ F5_TTS_DEVICES: "cuda:0,cuda:1", F5_TTS_CONCURRENCY: "2" }), ["cuda:0", "cuda:1"]);
  assert.deepEqual(resolveF5WorkerDevices({ F5_TTS_DEVICES: "cuda:0,cuda:1", F5_TTS_CONCURRENCY: "1" }), ["cuda:0"]);
});

test("F5 narration cache skips the worker until the lexicon hash changes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scene-gen-f5-cache-"));
  const generatedDir = path.join(directory, "generated");
  const refAudio = path.join(directory, "reference.wav");
  const requestCount = path.join(directory, "requests.txt");
  const startCount = path.join(directory, "starts.txt");
  const originalLexicon = JSON.parse(await readFile(fromRoot("config", "tts", "zh-CN.json"), "utf8"));
  const firstLexicon = path.join(directory, "lexicon-v1.json");
  const secondLexicon = path.join(directory, "lexicon-v2.json");
  await Promise.all([
    writeFile(refAudio, "fixture"),
    writeFile(firstLexicon, JSON.stringify(originalLexicon), "utf8"),
    writeFile(secondLexicon, JSON.stringify({ ...originalLexicon, version: originalLexicon.version + 1 }), "utf8"),
  ]);
  const project = createFixtureProject({
    meta: { ...createFixtureProject().meta, title: "Cache test" },
    narration: "Cache test",
    narrationSegments: [{ sceneIndex: 0, text: "Cache test", audioStartSeconds: 0, durationSeconds: 1 }],
    scenes: [{ ...createFixtureProject().scenes[0], headline: "Cache test", duration: 1 }],
  });
  const names = [
    "F5_TTS_PYTHON", "F5_TTS_WORKER_SCRIPT", "F5_TTS_REF_AUDIO", "F5_TTS_REF_TEXT",
    "F5_TTS_WORKER_MODE", "F5_TTS_DEVICE", "F5_TTS_CONCURRENCY", "TTS_PRONUNCIATION_LEXICON",
    "MOCK_F5_REQUEST_COUNT_FILE", "MOCK_F5_START_COUNT_FILE", "TTS_DURATION_POLICY", "SCENE_GEN_CACHE_DIR",
  ] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    F5_TTS_PYTHON: resolvePythonCommand(),
    F5_TTS_WORKER_SCRIPT: fromRoot("tests", "fixtures", "mock-f5-worker.py"),
    F5_TTS_REF_AUDIO: refAudio,
    F5_TTS_REF_TEXT: "reference",
    F5_TTS_WORKER_MODE: "worker",
    F5_TTS_DEVICE: "cuda:0",
    F5_TTS_CONCURRENCY: "1",
    TTS_PRONUNCIATION_LEXICON: firstLexicon,
    MOCK_F5_REQUEST_COUNT_FILE: requestCount,
    MOCK_F5_START_COUNT_FILE: startCount,
    TTS_DURATION_POLICY: "natural",
    SCENE_GEN_CACHE_DIR: path.join(directory, "cache"),
  });
  try {
    const first = await attachNarrationAudio(project, "cache-test", { generatedDir, provider: "f5" });
    const second = await attachNarrationAudio(project, "cache-test", { generatedDir, provider: "f5" });
    assert.equal(first.audio?.metrics?.generatedSceneCount, 1);
    assert.equal(second.audio?.metrics?.reusedSceneCount, 1);
    assert.equal(second.audio?.metrics?.workerStartCount, 0);
    assert.equal((await lines(requestCount)).length, 1);
    process.env.TTS_PRONUNCIATION_LEXICON = secondLexicon;
    const third = await attachNarrationAudio(project, "cache-test", { generatedDir, provider: "f5" });
    assert.equal(third.audio?.metrics?.generatedSceneCount, 1);
    assert.equal((await lines(requestCount)).length, 2);
    assert.equal((await lines(startCount)).length, 2);
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
