import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { appendFeedback, readFeedback, recordFeedbackOutcome, selectFeedback } from "./feedback-store";

test("feedback store deduplicates, scopes and tracks successful use", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "scene-gen-feedback-"));
  const previous = process.env.VIDEO_FEEDBACK_FILE;
  process.env.VIDEO_FEEDBACK_FILE = path.join(directory, "feedback.jsonl");
  try {
    const input = { createdAt: new Date().toISOString(), category: "title", severity: "high" as const, issue: "avoid vague title", appliesTo: ["url:https://example.com/a"] };
    const first = await appendFeedback(input);
    const duplicate = await appendFeedback(input);
    assert.equal(duplicate.deduplicated, true);
    const entries = await readFeedback();
    assert.equal(selectFeedback(entries, { url: "https://example.com/a", stage: "draft" }).length, 1);
    assert.equal(selectFeedback(entries, { url: "https://example.com/b", stage: "draft" }).length, 0);
    await recordFeedbackOutcome([first.entry.fingerprint], true);
    const persisted = (await readFile(process.env.VIDEO_FEEDBACK_FILE, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(persisted[0].successCount, 1);
  } finally {
    if (previous === undefined) delete process.env.VIDEO_FEEDBACK_FILE;
    else process.env.VIDEO_FEEDBACK_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
