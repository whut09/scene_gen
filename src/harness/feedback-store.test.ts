import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendFeedback,
  buildFeedbackGuidance,
  feedbackBayesianSuccessRate,
  compactFeedback,
  inspectFeedbackStore,
  readFeedback,
  recordFeedbackOutcome,
  resolveFeedback,
  setFeedbackEnabled,
  selectFeedback,
  type FeedbackEntry,
} from "./feedback-store";

async function withFeedbackFile(run: (filePath: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "scene-gen-feedback-"));
  const previous = process.env.VIDEO_FEEDBACK_FILE;
  const filePath = path.join(directory, "feedback.jsonl");
  process.env.VIDEO_FEEDBACK_FILE = filePath;
  try {
    await run(filePath);
  } finally {
    if (previous === undefined) delete process.env.VIDEO_FEEDBACK_FILE;
    else process.env.VIDEO_FEEDBACK_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

function feedback(overrides: Partial<FeedbackEntry> & Pick<FeedbackEntry, "fingerprint" | "issue">): FeedbackEntry {
  return {
    createdAt: "2026-07-01T00:00:00.000Z",
    category: "general",
    severity: "medium",
    appliesTo: ["global"],
    enabled: true,
    trialCount: 0,
    successCount: 0,
    failureCount: 0,
    conflictsWith: [],
    contentDomains: [],
    templateIds: [],
    providerIds: [],
    minimumConfidence: 0,
    ...overrides,
  };
}

test("legacy feedback receives effect tracking defaults", async () => {
  await withFeedbackFile(async (filePath) => {
    await writeFile(filePath, `${JSON.stringify({
      createdAt: "2026-01-01T00:00:00.000Z",
      category: "title",
      severity: "high",
      issue: "avoid vague title",
      appliesTo: ["global"],
      fingerprint: "legacy",
      enabled: true,
      successCount: 2,
    })}\n`, "utf8");
    const [entry] = await readFeedback();
    assert.equal(entry.trialCount, 2);
    assert.equal(entry.failureCount, 0);
    assert.deepEqual(entry.conflictsWith, []);
    assert.equal(entry.minimumConfidence, 0);
  });
});

test("feedback outcomes track trials, failures and score changes", async () => {
  await withFeedbackFile(async (filePath) => {
    const first = await appendFeedback({
      createdAt: "2026-07-01T00:00:00.000Z",
      category: "title",
      severity: "high",
      issue: "avoid vague title",
      appliesTo: ["url:https://example.com/a"],
    });
    const duplicate = await appendFeedback({
      createdAt: "2026-07-04T00:00:00.000Z",
      category: "title",
      severity: "high",
      issue: "avoid vague title",
      appliesTo: ["url:https://example.com/a"],
    });
    assert.equal(duplicate.deduplicated, true);
    assert.equal(duplicate.entry.createdAt, "2026-07-01T00:00:00.000Z");
    await recordFeedbackOutcome([first.entry.fingerprint], {
      succeeded: true,
      scoreBefore: 70,
      scoreAfter: 84,
      appliedAt: "2026-07-02T00:00:00.000Z",
    });
    await recordFeedbackOutcome([first.entry.fingerprint], {
      succeeded: false,
      scoreBefore: 84,
      scoreAfter: 80,
      appliedAt: "2026-07-03T00:00:00.000Z",
    });
    const [persisted] = (await readFile(filePath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(persisted.trialCount, 2);
    assert.equal(persisted.successCount, 1);
    assert.equal(persisted.failureCount, 1);
    assert.equal(persisted.lastAppliedAt, "2026-07-03T00:00:00.000Z");
    assert.equal(persisted.lastSucceededAt, "2026-07-02T00:00:00.000Z");
    assert.equal(persisted.effectScoreBefore, 84);
    assert.equal(persisted.effectScoreAfter, 80);
  });
});

test("Bayesian effectiveness ranks proven feedback above failed feedback", () => {
  const proven = feedback({ fingerprint: "proven", issue: "proven", trialCount: 10, successCount: 8, failureCount: 2 });
  const failed = feedback({ fingerprint: "failed", issue: "failed", trialCount: 10, successCount: 1, failureCount: 9 });
  assert.ok(feedbackBayesianSuccessRate(proven) > feedbackBayesianSuccessRate(failed));
  const selected = selectFeedback([failed, proven], { url: "https://example.com", now: new Date("2026-07-16T00:00:00.000Z") });
  assert.deepEqual(selected.map((entry) => entry.fingerprint), ["proven", "failed"]);
  assert.match(buildFeedbackGuidance(selected), /proven/);
});

test("selection applies freshness, expiry and contextual confidence", () => {
  const fresh = feedback({ fingerprint: "fresh", issue: "fresh", createdAt: "2026-07-15T00:00:00.000Z" });
  const stale = feedback({ fingerprint: "stale", issue: "stale", createdAt: "2024-01-01T00:00:00.000Z" });
  const expired = feedback({ fingerprint: "expired", issue: "expired", expiresAt: "2026-07-15T00:00:00.000Z" });
  const uncertain = feedback({ fingerprint: "uncertain", issue: "uncertain", minimumConfidence: 0.9 });
  const selected = selectFeedback([stale, expired, uncertain, fresh], {
    url: "https://example.com",
    confidence: 0.8,
    now: new Date("2026-07-16T00:00:00.000Z"),
  });
  assert.deepEqual(selected.map((entry) => entry.fingerprint), ["fresh", "stale"]);
});

test("selection filters domains, templates and providers", () => {
  const targeted = feedback({
    fingerprint: "targeted",
    issue: "targeted",
    contentDomains: ["software"],
    templateIds: ["data-cards"],
    providerIds: ["f5"],
  });
  assert.equal(selectFeedback([targeted], {
    url: "https://example.com",
    contentDomain: "software",
    templateId: "data-cards",
    providerId: "f5",
  }).length, 1);
  assert.equal(selectFeedback([targeted], {
    url: "https://example.com",
    contentDomain: "finance",
    templateId: "data-cards",
    providerId: "f5",
  }).length, 0);
});

test("conflicting feedback keeps the higher-effect deterministic winner", () => {
  const winner = feedback({
    fingerprint: "winner",
    issue: "use concise titles",
    severity: "high",
    trialCount: 8,
    successCount: 7,
    failureCount: 1,
    conflictsWith: ["loser"],
  });
  const loser = feedback({
    fingerprint: "loser",
    issue: "use detailed titles",
    trialCount: 8,
    successCount: 1,
    failureCount: 7,
  });
  const selected = selectFeedback([loser, winner], { url: "https://example.com", now: new Date("2026-07-16T00:00:00.000Z") });
  assert.deepEqual(selected.map((entry) => entry.fingerprint), ["winner"]);
});

test("concurrent mutations are locked, atomic and audited", async () => {
  await withFeedbackFile(async (filePath) => {
    const inputs = Array.from({ length: 20 }, (_, index) => ({ createdAt: new Date(2026, 6, 16, 0, 0, index).toISOString(), category: "concurrency", severity: "medium" as const, issue: `issue-${index}`, appliesTo: ["global"] }));
    await Promise.all(inputs.map((entry) => appendFeedback(entry, { actor: "test", runId: "run-concurrent", reason: "concurrency-test" })));
    assert.equal((await readFeedback(30)).length, 20);
    const audit = await readFile(`${filePath}.audit.jsonl`, "utf8");
    assert.equal(audit.trim().split(/\r?\n/).length, 20);
    assert.match(audit, /run-concurrent/);
  });
});

test("invalid lines are quarantined and management operations are transactional", async () => {
  await withFeedbackFile(async (filePath) => {
    const created = await appendFeedback({ createdAt: "2026-07-16T00:00:00.000Z", category: "quality", severity: "high", issue: "bad frame", appliesTo: ["global"] });
    await writeFile(filePath, `${await readFile(filePath, "utf8")}{broken-json}\n`, "utf8");
    await readFeedback();
    const inspected = await inspectFeedbackStore();
    assert.equal(inspected.invalidLines, 0);
    assert.equal(inspected.quarantineCount, 1);
    assert.match(await readFile(inspected.quarantinePath, "utf8"), /broken-json/);
    await setFeedbackEnabled(created.entry.fingerprint, false, { actor: "tester", reason: "disable-test" });
    assert.equal((await inspectFeedbackStore()).enabled, 0);
    await resolveFeedback(created.entry.fingerprint, { actor: "tester", reason: "resolved" });
    assert.equal((await inspectFeedbackStore()).resolved, 1);
    assert.deepEqual(await compactFeedback({ actor: "tester", reason: "compact" }), { before: 1, after: 1 });
  });
});
