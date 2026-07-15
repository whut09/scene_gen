import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { runExternalProcess } from "../../src/pipeline/external-operation";
import { analyzeFrameVisual } from "../../src/harness/frame-visual-analysis";
import { inspectSceneDom } from "../../src/html-video/visual-audit";
import { readVisualAuditFile } from "../../src/html-video/visual-audit";
import { renderHtmlVideoProject } from "../../src/html-video/render-html-video";
import { resolveHtmlRenderBudget } from "../../src/html-video/render-budget";
import { createFixtureProject } from "../fixtures/project";

test("frame analysis distinguishes flat blank frames from visual content", { timeout: 30_000 }, async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "scene-gen-frame-visual-"));
  try {
    const blankPath = path.join(workDir, "blank.jpg");
    const contentPath = path.join(workDir, "content.jpg");
    await runExternalProcess("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=white:s=1080x1920", "-frames:v", "1", blankPath]);
    await runExternalProcess("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc2=s=1080x1920", "-frames:v", "1", contentPath]);
    const blank = await analyzeFrameVisual(blankPath);
    const content = await analyzeFrameVisual(contentPath);
    assert.equal(blank.blank, true, JSON.stringify(blank));
    assert.equal(content.blank, false, JSON.stringify(content));
    assert.ok(content.lumaRange > blank.lumaRange);
    assert.ok(content.edgeDensity > blank.edgeDensity);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("DOM audit detects readability, clipping and timing problems", { timeout: 30_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 640 } });
    await page.setContent(`<!doctype html><style>
      body{margin:0;background:#fff;color:#f7f7f7;overflow:hidden}
      h1{position:absolute;left:-12px;top:4px;width:220px;height:28px;overflow:hidden;font-size:18px;line-height:28px;animation:late .8s 1.2s both}
      p{position:absolute;left:20px;top:120px;width:90px;height:20px;overflow:hidden;font-size:14px;white-space:nowrap}
      @keyframes late{from{opacity:0}to{opacity:1}}
    </style><h1>关键结论已经出现</h1><p>这是一段会被明显裁切和溢出的正文内容</p>`);
    const audit = await inspectSceneDom(page, {
      sceneIndex: 0,
      width: 360,
      height: 640,
      durationSec: 2.4,
      headline: "关键结论已经出现",
      syncCues: [{ text: "关键结论", startRatio: 0.1, endRatio: 0.4, emphasis: "primary" }],
    });
    const codes = new Set(audit.issues.map((issue) => issue.code));
    assert.ok(codes.has("dom_element_out_of_bounds"));
    assert.ok(codes.has("text_unsafe_zone"));
    assert.ok(codes.has("text_too_small"));
    assert.ok(codes.has("content_clipped"));
    assert.ok(codes.has("text_contrast_low"));
    assert.ok(codes.has("sync_cue_visual_late"));
    assert.ok(codes.has("conclusion_hold_too_short"));
  } finally {
    await browser.close();
  }
});

test("HTML renderer persists scene visual audit before recording", { timeout: 60_000 }, async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "scene-gen-render-visual-audit-"));
  try {
    const fixture = createFixtureProject();
    const project = createFixtureProject({
      meta: { ...fixture.meta, durationSeconds: 0.8 },
      narrationSegments: [{ ...fixture.narrationSegments![0], durationSeconds: 0.8 }],
      scenes: [{ ...fixture.scenes[0], duration: 0.8 }],
      audio: undefined,
    });
    const outputPath = path.join(workDir, "published.mp4");
    const budget = resolveHtmlRenderBudget(1);
    const result = await renderHtmlVideoProject(project, outputPath, {
      workDir,
      forceSceneIndexes: [0],
      renderBudget: { ...budget, renderConcurrency: 1, ffmpegThreadsPerJob: 1, encodingPreset: "ultrafast" },
      concatRenderer: async (frames, targetPath) => copyFile(frames[0].videoPath, targetPath).then(() => undefined),
      audioMuxer: async (_project, videoPath, targetPath) => copyFile(videoPath, targetPath).then(() => undefined),
    });
    const audit = await readVisualAuditFile(result.visualAuditPath);
    assert.equal(audit.scenes.length, 1);
    assert.equal(audit.scenes[0].elementCount > 0, true);
    assert.deepEqual(audit.scenes[0].issues.filter((issue) => issue.severity === "error"), []);
    assert.equal(result.frames[0].visualAudit.sceneIndex, 0);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
