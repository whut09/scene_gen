import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { createFixtureProject } from "../fixtures/project";
import { selectTemplateForScene } from "../../src/templates/template-registry";
import { inspectSceneDom } from "../../src/html-video/visual-audit";
import { getTemplateById } from "../../src/templates/template-registry";
import type { VideoScene } from "../../src/pipeline/types";

test("selected title template screenshot stays visible, bounded, and non-blank", { timeout: 120_000 }, async () => {
  const project = createFixtureProject();
  const scene = project.scenes[0];
  const selection = selectTemplateForScene(scene, project, { sceneIndex: 0 });
  const html = selection.template.renderHtml({
    project,
    scene,
    sceneIndex: 0,
    width: project.meta.width,
    height: project.meta.height,
    variantId: selection.variantId,
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: project.meta.width, height: project.meta.height }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    const visualAudit = await inspectSceneDom(page, { sceneIndex: 0, width: project.meta.width, height: project.meta.height, durationSec: scene.duration, headline: scene.headline });
    const outputDir = path.resolve("test-results", "golden");
    await mkdir(outputDir, { recursive: true });
    const screenshot = await page.screenshot({ path: path.join(outputDir, `${selection.template.id}-${selection.variantId}.png`), animations: "disabled" });
    const layout = await page.evaluate((expectedTitle) => {
      const title = document.querySelector("h1");
      const titleRect = title?.getBoundingClientRect();
      const style = title ? getComputedStyle(title) : null;
      return {
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        titleText: title?.textContent ?? "",
        titleVisible: Boolean(titleRect && titleRect.width > 0 && titleRect.height > 0 && style?.visibility !== "hidden" && style?.display !== "none"),
        titleBounds: titleRect ? { left: titleRect.left, top: titleRect.top, right: titleRect.right, bottom: titleRect.bottom } : null,
        expectedTitle,
      };
    }, project.meta.title);
    const dataUrl = `data:image/png;base64,${screenshot.toString("base64")}`;
    const pixels = await page.evaluate(async (url) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2D context unavailable.");
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, image.width, image.height).data;
      const colors = new Set<string>();
      let minimum = 255;
      let maximum = 0;
      for (let y = 0; y < image.height; y += 24) {
        for (let x = 0; x < image.width; x += 24) {
          const offset = (y * image.width + x) * 4;
          const red = data[offset];
          const green = data[offset + 1];
          const blue = data[offset + 2];
          minimum = Math.min(minimum, red, green, blue);
          maximum = Math.max(maximum, red, green, blue);
          colors.add(`${red >> 4}:${green >> 4}:${blue >> 4}`);
        }
      }
      return { colorRange: maximum - minimum, uniqueColors: colors.size };
    }, dataUrl);

    assert.equal(layout.scrollWidth <= project.meta.width + 1, true, JSON.stringify(layout));
    assert.equal(layout.scrollHeight <= project.meta.height + 1, true, JSON.stringify(layout));
    assert.equal(layout.titleVisible, true);
    assert.match(layout.titleText.replace(/\s+/g, ""), /开源视频生成工具发布新版本/);
    assert.ok(layout.titleBounds);
    assert.equal(layout.titleBounds.left >= 40 && layout.titleBounds.right <= project.meta.width - 40, true, JSON.stringify(layout.titleBounds));
    assert.equal(layout.titleBounds.top >= 40 && layout.titleBounds.bottom <= project.meta.height - 40, true, JSON.stringify(layout.titleBounds));
    assert.equal(screenshot.length > 25_000, true, `Screenshot is suspiciously small: ${screenshot.length}`);
    assert.equal(pixels.colorRange > 80 && pixels.uniqueColors > 12, true, JSON.stringify(pixels));
    assert.deepEqual(visualAudit.issues.filter((issue) => issue.severity === "error"), [], JSON.stringify(visualAudit.issues));
  } finally {
    await browser.close();
  }
});

test("decision flow keeps long headlines clear of the first card", { timeout: 120_000 }, async () => {
  const project = createFixtureProject();
  const scene: VideoScene = {
    type: "flow",
    duration: 18,
    headline: "\u5434\u5029\u6307\u51fa\uff0cAI\u6b63\u4ee5\u524d\u6240\u672a\u6709\u7684\u901f\u5ea6\u5f71\u54cd\u5f71\u89c6\u884c\u4e1a\uff0c\u4ece\u7075\u611f\u843d\u5730\u3001\u89c6\u89c9\u5448\u73b0\u5230\u5206\u955c\u8bbe\u8ba1\u3001\u540e\u671f\u5236\u4f5c",
    steps: [
      { label: "\u6d3b\u52a8\u80cc\u666f", detail: "\u4eba\u5de5\u667a\u80fd\u6b63\u5728\u91cd\u5851\u5f71\u89c6\u521b\u4f5c\u6d41\u7a0b\u3002" },
      { label: "\u89c2\u70b9\u8868\u8fbe", detail: "\u6280\u672f\u8fdb\u6b65\u4e0d\u4ee3\u8868\u53d6\u4ee3\u4eba\u7684\u5224\u65ad\u3002" },
      { label: "\u884c\u4e1a\u5b9e\u8df5", detail: "\u5de5\u5177\u9700\u8981\u670d\u52a1\u4e8e\u53ef\u63a7\u7684\u5236\u4f5c\u6d41\u7a0b\u3002" },
    ],
  };
  const template = getTemplateById("decision-flow");
  assert.ok(template);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: project.meta.width, height: project.meta.height } });
    await page.setContent(template.renderHtml({ project, scene, sceneIndex: 0, width: project.meta.width, height: project.meta.height, variantId: "agent-branch" }), { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    const bounds = await page.evaluate(() => {
      const title = document.querySelector(".df-main h1")?.getBoundingClientRect();
      const firstCard = document.querySelector(".df-node")?.getBoundingClientRect();
      return { titleBottom: title?.bottom ?? 0, firstCardTop: firstCard?.top ?? 0 };
    });
    const audit = await inspectSceneDom(page, { sceneIndex: 0, width: project.meta.width, height: project.meta.height, durationSec: scene.duration, headline: scene.headline });
    assert.equal(bounds.firstCardTop > bounds.titleBottom + 12, true, JSON.stringify(bounds));
    assert.deepEqual(audit.issues.filter((issue) => issue.code === "element_overlap" && issue.severity === "error"), [], JSON.stringify(audit.issues));
  } finally {
    await browser.close();
  }
});

test("editorial stat grid keeps long metric values inside their cards", { timeout: 120_000 }, async () => {
  const project = createFixtureProject();
  const scene: VideoScene = {
    type: "briefing_points",
    duration: 18,
    headline: "长时间自动运行会放大风险",
    source: "工程边界",
    title: "速度越快，越需要约束和证据",
    summary: "错误、权限、成本和审查压力会随循环持续累积。",
    points: ["早期错误可能污染后续判断", "权限过大会扩大失败影响范围", "生成速度可能超过人工审查速度"],
    metrics: [{ label: "成本", value: "令牌与工具调用持续累积" }, { label: "瓶颈", value: "人工审查能力有限" }],
  };
  const template = getTemplateById("editorial-stat-grid");
  assert.ok(template);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: project.meta.width, height: project.meta.height } });
    await page.setContent(template.renderHtml({ project, scene, sceneIndex: 0, width: project.meta.width, height: project.meta.height, variantId: "stat-grid" }), { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    const audit = await inspectSceneDom(page, { sceneIndex: 0, width: project.meta.width, height: project.meta.height, durationSec: scene.duration, headline: scene.headline });
    assert.deepEqual(audit.issues.filter((issue) => issue.code === "content_clipped"), [], JSON.stringify(audit.issues));
  } finally {
    await browser.close();
  }
});
