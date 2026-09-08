import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { buildHtmlVideoContentGraph } from "../../src/html-video/content-graph";
import { createFixtureProject } from "../fixtures/project";
import { commonHtml } from "../../src/templates/html-utils";
import { FRAME_DESIGN_VERSION, frameTokens } from "../../src/templates/frame-design";

test("shared frame design is visible and readable from the first frame", { timeout: 120_000 }, async () => {
  const html = commonHtml({
    title: "Frame design fixture",
    body: `<main class="hv-main"><div class="hv-kicker">TEST / FRAME</div><h1 data-sg-key="Headline">统一视觉系统</h1><div class="hv-card" style="margin-top:32px;padding:24px;"><p>浅色画布和清晰层级。</p></div></main>`,
    width: 1080,
    height: 1920,
    theme: "paper",
    palette: "ocean",
    durationSec: 10,
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    await page.setContent(html, { waitUntil: "load" });
    const state = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>(".sg-frame-header");
      const footer = document.querySelector<HTMLElement>(".sg-frame-footer");
      const card = document.querySelector<HTMLElement>(".hv-card");
      const title = document.querySelector<HTMLElement>("h1");
      const bodyStyle = getComputedStyle(document.body);
      const cardStyle = card ? getComputedStyle(card) : null;
      return {
        design: document.body.dataset.sgDesign,
        headerOpacity: header ? getComputedStyle(header).opacity : "",
        footerOpacity: footer ? getComputedStyle(footer).opacity : "",
        bodyBackground: bodyStyle.backgroundColor,
        cardRadius: cardStyle?.borderRadius ?? "",
        cardShadow: cardStyle?.boxShadow ?? "",
        titleWeight: title ? getComputedStyle(title).fontWeight : "",
      };
    });
    assert.equal(state.design, FRAME_DESIGN_VERSION);
    assert.equal(state.headerOpacity, "1");
    assert.equal(state.footerOpacity, "1");
    assert.match(state.bodyBackground, /rgb\(/);
    assert.equal(state.cardRadius, "12px");
    assert.match(state.cardShadow, /8px/);
    assert.ok(Number(state.titleWeight) >= 800, state.titleWeight);
  } finally {
    await browser.close();
  }
});

test("frame palettes keep high-contrast ink and accent tokens", () => {
  for (const palette of ["ocean", "violet", "sunset", "mint", "coral"] as const) {
    const tokens = frameTokens(palette);
    assert.notEqual(tokens.canvas, tokens.ink);
    assert.notEqual(tokens.surface, tokens.accent);
    assert.match(tokens.accent, /^#[0-9a-f]{6}$/i);
  }
});

test("content graph records the active frame design family", () => {
  const graph = buildHtmlVideoContentGraph(createFixtureProject());
  assert.equal(graph.visualSystem.family, FRAME_DESIGN_VERSION);
});
