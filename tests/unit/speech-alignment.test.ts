import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { createHtmlVideoCacheKey, createSyncCueAnimationPlan, installSyncCueAnimations } from "../../src/html-video/render-html-video";
import { storedNarrationSceneTranscripts } from "../../src/harness/scene-audio-verification";
import { alignNarrationSegment, applySpeechAlignment } from "../../src/pipeline/speech-alignment";
import type { NarrationSegment, VideoScene } from "../../src/pipeline/types";
import { buildProductionReport } from "../../src/production/production-report";
import { buildSyncCues } from "../../src/production/visual-planner";
import { createFixtureProject } from "../fixtures/project";

const scene: VideoScene = {
  type: "title",
  duration: 4,
  kicker: "Runtime",
  headline: "持久化 Worker",
  subhead: "Cache reuse",
  sources: ["fixture"],
};

const segment: NarrationSegment = {
  sceneIndex: 0,
  text: "持久化 Worker enables Cache reuse",
  audioStartSeconds: 1,
  durationSeconds: 4,
};

const transcript = {
  sceneIndex: 0,
  text: "持久化 Worker enables Cache reuse",
  confidence: 0.91,
  words: [
    { text: "持久化", startSeconds: 0.3, endSeconds: 0.8, confidence: 0.92 },
    { text: "Worker", startSeconds: 0.82, endSeconds: 1.3, confidence: 0.9 },
    { text: "enables", startSeconds: 1.35, endSeconds: 1.7, confidence: 0.89 },
    { text: "Cache", startSeconds: 1.75, endSeconds: 2.1, confidence: 0.93 },
    { text: "reuse", startSeconds: 2.12, endSeconds: 2.5, confidence: 0.9 },
  ],
};

test("speech alignment maps phrases across word chunks to absolute narration timestamps", () => {
  const aligned = alignNarrationSegment(segment, scene, transcript, "2026-07-15T00:00:00.000Z");
  assert.equal(aligned.speechAlignment?.status, "forced");
  assert.deepEqual(aligned.speechAlignment?.phrases.map((phrase) => [phrase.phrase, phrase.audioStartMs, phrase.audioEndMs]), [
    ["持久化Worker", 1300, 2300],
    ["Cachereuse", 2750, 3500],
  ]);
  const cues = buildSyncCues(scene, aligned);
  assert.equal(cues[0].timingSource, "forced-alignment");
  assert.equal(cues[0].startRatio, 0.075);
  assert.equal(cues[0].endRatio, 0.325);
});

test("low-confidence alignment falls back to estimated ratio cues", () => {
  const original = process.env.SPEECH_ALIGNMENT_CONFIDENCE_MIN;
  process.env.SPEECH_ALIGNMENT_CONFIDENCE_MIN = "0.95";
  try {
    const aligned = alignNarrationSegment(segment, scene, transcript);
    assert.equal(aligned.speechAlignment?.status, "failed");
    assert.equal(buildSyncCues(scene, aligned).every((cue) => cue.timingSource === "estimated-ratio"), true);
  } finally {
    if (original === undefined) delete process.env.SPEECH_ALIGNMENT_CONFIDENCE_MIN;
    else process.env.SPEECH_ALIGNMENT_CONFIDENCE_MIN = original;
  }
});

test("stored alignment transcripts can be reused by the audio gate", () => {
  const fixture = createFixtureProject({ scenes: [scene], narrationSegments: [segment] });
  const aligned = applySpeechAlignment(fixture, [transcript], "2026-07-15T00:00:00.000Z");
  const stored = storedNarrationSceneTranscripts(aligned);
  assert.equal(stored?.[0].text, transcript.text);
  assert.equal(stored?.[0].words?.length, transcript.words.length);
});

test("production reports forced alignment only after a cue was actually aligned", () => {
  const fixture = createFixtureProject({ scenes: [scene], narrationSegments: [segment] });
  assert.equal(buildProductionReport(fixture).summary.wordAlignment, "estimated-keyword-cues");
  const aligned = applySpeechAlignment(fixture, [transcript], "2026-07-15T00:00:00.000Z");
  const report = buildProductionReport(aligned);
  assert.equal(report.summary.wordAlignment, "forced-alignment");
  assert.equal(report.summary.alignedCueCount, 2);
  assert.equal(report.summary.alignmentCoverage, 1);
});

test("sync animation plans preserve real timing metadata", () => {
  const cue = buildSyncCues(scene, alignNarrationSegment(segment, scene, transcript))[0];
  const plan = createSyncCueAnimationPlan([cue], 4);
  assert.deepEqual(plan[0], {
    text: "持久化Worker",
    startMs: 300,
    endMs: 1300,
    audioStartMs: 1300,
    audioEndMs: 2300,
    confidence: 0.91,
    timingSource: "forced-alignment",
    emphasis: "primary",
  });
});

test("HTML sync animations bind timestamps and remain paused before recording starts", { timeout: 30_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent("<main><h1>持久化 Worker</h1></main>");
    const cue = buildSyncCues(scene, alignNarrationSegment(segment, scene, transcript))[0];
    await installSyncCueAnimations(page, [cue], 4);
    const before = await page.locator("h1").evaluate((element) => ({
      start: (element as HTMLElement).dataset.sgSyncStartMs,
      audioStart: (element as HTMLElement).dataset.sgSyncAudioStartMs,
      source: (element as HTMLElement).dataset.sgSyncSource,
      states: document.getAnimations().map((animation) => animation.playState),
    }));
    assert.equal(before.start, "300");
    assert.equal(before.audioStart, "1300");
    assert.equal(before.source, "forced-alignment");
    assert.equal(before.states.every((state) => state === "paused"), true);
    await page.evaluate(() => (window as unknown as { __sgUnfreeze?: () => void }).__sgUnfreeze?.());
    assert.equal((await page.evaluate(() => document.getAnimations().map((animation) => animation.playState))).every((state) => state === "running"), true);
  } finally {
    await browser.close();
  }
});

test("timestamp changes invalidate the affected video scene cache key", () => {
  const base = { scene, templateId: "kinetic-title", templateVersion: "1", variantId: "default", width: 1080, height: 1920, fps: 30 };
  const first = createHtmlVideoCacheKey({ ...base, syncCues: [{ text: "Worker", startRatio: 0.2, endRatio: 0.4, timingSource: "forced-alignment", emphasis: "primary" }] });
  const second = createHtmlVideoCacheKey({ ...base, syncCues: [{ text: "Worker", startRatio: 0.3, endRatio: 0.5, timingSource: "forced-alignment", emphasis: "primary" }] });
  assert.notEqual(first, second);
  const jittered = createHtmlVideoCacheKey({ ...base, syncCues: [{ text: "Worker", startRatio: 0.202, endRatio: 0.402, timingSource: "forced-alignment", emphasis: "primary" }] });
  assert.equal(first, jittered);
});
