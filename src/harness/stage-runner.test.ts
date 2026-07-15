import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { RunJournalStore } from "./run-journal";
import { runStage } from "./stage-runner";

test("stage runner records input hashes and cancels timed out work", async () => {
  const runDir = await mkdtemp(path.join(tmpdir(), "scene-gen-stage-"));
  try {
    const journal = await RunJournalStore.create(runDir, {
      runId: "stage-test",
      url: "https://example.com",
      config: { targetSeconds: 10, maxIterations: 1, engine: "html-video", outputDir: runDir, screenshotLimit: 0 },
    });
    await assert.rejects(() => runStage({
      journal,
      name: "draft",
      attempt: 1,
      inputs: { url: "https://example.com" },
      timeoutMs: 20,
      task: (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    }));
    const stage = journal.snapshot().stages.at(-1);
    assert.equal(stage?.status, "failed");
    assert.equal(stage?.inputHash.length, 64);
    assert.equal(stage?.suggestedAction, "retry-stage");
    assert.equal(stage?.issues[0].issueClass, "environment");
    assert.equal(stage?.issues[0].retryable, true);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});
