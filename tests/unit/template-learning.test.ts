import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rankTemplatesForScene } from "../../src/templates/template-registry";
import {
  buildTemplateLearningFeatures,
  readTemplateOutcomes,
  recordTemplateOutcomes,
  shouldExploreTemplate,
  templateHistoryStats,
} from "../../src/templates/template-learning";
import { createFixtureProject } from "../fixtures/project";

test("template reranking learns from outcomes and preserves a deterministic fallback", { concurrency: false }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scene-gen-template-learning-"));
  const outcomePath = path.join(directory, "outcomes.jsonl");
  const originalOutcome = process.env.TEMPLATE_OUTCOME_FILE;
  const originalDisabled = process.env.TEMPLATE_LEARNING_DISABLED;
  const originalExploration = process.env.TEMPLATE_EXPLORATION_RATE;
  process.env.TEMPLATE_OUTCOME_FILE = outcomePath;
  process.env.TEMPLATE_EXPLORATION_RATE = "0";
  try {
    const project = createFixtureProject();
    const scene = project.scenes[0];
    const baseline = rankTemplatesForScene(scene, project, { sceneIndex: 0 });
    assert.equal(baseline[0].template.id, "general-editorial");
    assert.equal(baseline.every((selection) => selection.explored === false), true);
    const general = baseline.find((selection) => selection.template.id === "general-editorial")!;
    const kinetic = baseline.find((selection) => selection.template.id === "kinetic-title")!;
    const records = Array.from({ length: 20 }, (_, index) => [
      {
        version: 1, createdAt: `2026-07-15T00:00:${String(index).padStart(2, "0")}.000Z`, templateId: general.template.id,
        variantId: general.variantId, sceneIndex: 0, features: general.features, passed: false, qualityScore: 20,
        blank: true, overflow: true, static: true, renderMs: 28_000, cacheHit: false, feedbackScore: -2,
      },
      {
        version: 1, createdAt: `2026-07-15T00:01:${String(index).padStart(2, "0")}.000Z`, templateId: kinetic.template.id,
        variantId: kinetic.variantId, sceneIndex: 0, features: kinetic.features, passed: true, qualityScore: 96,
        blank: false, overflow: false, static: false, renderMs: 8_000, cacheHit: true, feedbackScore: 1,
      },
    ]).flat();
    await writeFile(outcomePath, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
    const learned = rankTemplatesForScene(scene, project, { sceneIndex: 0 });
    assert.equal(learned[0].template.id, "kinetic-title");
    assert.ok(learned[0].learnedAdjustment > 0);
    assert.ok(learned.find((selection) => selection.template.id === "general-editorial")!.learnedAdjustment < -40);
    assert.equal(learned[0].history.scope, "exact");
    assert.equal(learned[0].history.samples, 20);

    process.env.TEMPLATE_LEARNING_DISABLED = "1";
    const fallback = rankTemplatesForScene(scene, project, { sceneIndex: 0 });
    assert.equal(fallback[0].template.id, "general-editorial");
    assert.equal(fallback[0].score, fallback[0].ruleScore);
    assert.equal(fallback[0].learnedAdjustment, 0);
  } finally {
    if (originalOutcome === undefined) delete process.env.TEMPLATE_OUTCOME_FILE; else process.env.TEMPLATE_OUTCOME_FILE = originalOutcome;
    if (originalDisabled === undefined) delete process.env.TEMPLATE_LEARNING_DISABLED; else process.env.TEMPLATE_LEARNING_DISABLED = originalDisabled;
    if (originalExploration === undefined) delete process.env.TEMPLATE_EXPLORATION_RATE; else process.env.TEMPLATE_EXPLORATION_RATE = originalExploration;
    await rm(directory, { recursive: true, force: true });
  }
});

test("template features and controlled exploration are bounded", { concurrency: false }, () => {
  const originalRate = process.env.TEMPLATE_EXPLORATION_RATE;
  try {
    const project = createFixtureProject();
    const features = buildTemplateLearningFeatures(project.scenes[0], project, "hook");
    assert.equal(features.sceneType, "title");
    assert.equal(features.intent, "hook");
    assert.ok(features.textLength > 0);
    process.env.TEMPLATE_EXPLORATION_RATE = "0";
    assert.equal(shouldExploreTemplate(project, 0), false);
    process.env.TEMPLATE_EXPLORATION_RATE = "0.25";
    const explored = Array.from({ length: 100 }, (_, index) => shouldExploreTemplate({ ...project, meta: { ...project.meta, title: `project-${index}` } }, 0)).filter(Boolean).length;
    assert.ok(explored >= 10 && explored <= 40, `unexpected exploration count ${explored}`);
  } finally {
    if (originalRate === undefined) delete process.env.TEMPLATE_EXPLORATION_RATE; else process.env.TEMPLATE_EXPLORATION_RATE = originalRate;
  }
});

test("publish outcome recording persists scene-level quality, cost and cache evidence", { concurrency: false }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scene-gen-template-outcome-"));
  const outcomePath = path.join(directory, "outcomes.jsonl");
  const originalOutcome = process.env.TEMPLATE_OUTCOME_FILE;
  process.env.TEMPLATE_OUTCOME_FILE = outcomePath;
  try {
    const project = createFixtureProject();
    const selection = rankTemplatesForScene(project.scenes[0], project, { sceneIndex: 0 })[0];
    const result = await recordTemplateOutcomes({
      runId: "test-run",
      project,
      nodes: [{ sceneIndex: 0, templateId: selection.template.id, variantId: selection.variantId, intent: selection.intent }],
      visualAudit: {
        version: 1,
        createdAt: "2026-07-15T00:00:00.000Z",
        scenes: [{ sceneIndex: 0, width: 1080, height: 1920, durationSec: 10, checkedAt: "2026-07-15T00:00:00.000Z", elementCount: 5, keyTextCount: 2, maximumAnimationEndMs: 500, issues: [{ code: "content_clipped", severity: "error", message: "clipped", evidence: {} }] }],
      },
      videoIssues: [],
      renderMetrics: { cacheHitScenes: "[0]", perSceneRecordMs: "{\"0\":1200}", perSceneEncodeMs: "{\"0\":800}" },
      feedback: [],
    });
    assert.equal(result.recorded, 1);
    assert.match(await readFile(outcomePath, "utf8"), /content_clipped|"overflow":true/);
    const outcomes = readTemplateOutcomes();
    assert.equal(outcomes[0].renderMs, 2000);
    assert.equal(outcomes[0].cacheHit, true);
    assert.equal(outcomes[0].passed, false);
    assert.equal(templateHistoryStats(selection.template.id, selection.variantId, selection.features, outcomes).samples, 1);
  } finally {
    if (originalOutcome === undefined) delete process.env.TEMPLATE_OUTCOME_FILE; else process.env.TEMPLATE_OUTCOME_FILE = originalOutcome;
    await rm(directory, { recursive: true, force: true });
  }
});
