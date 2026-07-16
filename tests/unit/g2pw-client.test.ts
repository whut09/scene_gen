import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { G2pwWorkerClient } from "../../src/pipeline/pronunciation/g2pw-client";

test("G2PW worker stays persistent across predictions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scene-gen-g2pw-"));
  const counter = path.join(directory, "starts.txt");
  const previous = process.env.MOCK_G2PW_START_FILE;
  process.env.MOCK_G2PW_START_FILE = counter;
  const client = new G2pwWorkerClient({ python: process.platform === "win32" ? "python" : "python3", script: path.resolve("tests/fixtures/mock-g2pw-worker.py") });
  try {
    assert.equal((await client.predict("重构"))[0].pinyin[0], "chong2");
    assert.equal((await client.predict("重复"))[0].pinyin[0], "chong2");
    assert.equal(await readFile(counter, "utf8"), "1");
  } finally {
    await client.dispose();
    if (previous === undefined) delete process.env.MOCK_G2PW_START_FILE;
    else process.env.MOCK_G2PW_START_FILE = previous;
  }
});

test("G2PW request supports timeout and AbortSignal", async () => {
  const client = new G2pwWorkerClient({ python: process.platform === "win32" ? "python" : "python3", script: path.resolve("tests/fixtures/mock-g2pw-worker.py"), requestTimeoutMs: 30 });
  await assert.rejects(() => client.predict("hang"), /timeout/i);
  await client.dispose();
  const aborting = new G2pwWorkerClient({ python: process.platform === "win32" ? "python" : "python3", script: path.resolve("tests/fixtures/mock-g2pw-worker.py") });
  const controller = new AbortController();
  const pending = aborting.predict("hang", { signal: controller.signal });
  setTimeout(() => controller.abort(new Error("cancelled")), 20);
  await assert.rejects(() => pending, /cancelled/i);
  await aborting.dispose();
});

test("pypinyin worker tolerates malformed surrounding Unicode", async () => {
  const client = new G2pwWorkerClient({ python: process.platform === "win32" ? "python" : "python3", script: path.resolve("scripts/g2pw-worker.py"), pypinyinOnly: true });
  try {
    const predictions = await client.pypinyin(`重复${String.fromCharCode(0xdc00)}文本`);
    assert.ok(Array.isArray(predictions));
  } finally {
    await client.dispose();
  }
});
