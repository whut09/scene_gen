import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runExternalProcess } from "./external-operation";

test("process retries only transient failures", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "scene-gen-external-"));
  const deterministicCounter = path.join(workDir, "deterministic.txt");
  const transientCounter = path.join(workDir, "transient.txt");
  const script = [
    "const fs=require('fs');",
    "const file=process.argv[1];",
    "const mode=process.argv[2];",
    "const count=fs.existsSync(file)?Number(fs.readFileSync(file,'utf8')):0;",
    "fs.writeFileSync(file,String(count+1));",
    "console.error(mode==='transient'?'ECONNRESET':'schema validation failed');",
    "process.exit(1);",
  ].join("");
  try {
    await assert.rejects(() => runExternalProcess(process.execPath, ["-e", script, deterministicCounter, "deterministic"], { retries: 1, retryOnExit: true }));
    await assert.rejects(() => runExternalProcess(process.execPath, ["-e", script, transientCounter, "transient"], { retries: 1, retryOnExit: true }));
    assert.equal(await readFile(deterministicCounter, "utf8"), "1");
    assert.equal(await readFile(transientCounter, "utf8"), "2");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
