import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { createFixtureProject } from "../fixtures/project";
import { selectTemplateForScene } from "../../src/templates/template-registry";
import { inspectSceneDom } from "../../src/html-video/visual-audit";

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
