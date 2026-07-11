import type { HtmlTemplateDefinition } from "../template.schema";
import { commonHtml, escapeHtml, sceneHeadline } from "../html-utils";

export const nytDataChartTemplate: HtmlTemplateDefinition = {
  id: "nyt-data-chart",
  version: "1.1.0",
  name: "NYT Data Chart",
  description: "Editorial chart scene inspired by newspaper data storytelling.",
  engine: "html-video",
  category: "data-visualization",
  subcategory: "bar-comparison",
  tags: ["chart", "data", "editorial", "benchmark"],
  bestFor: ["benchmark comparison", "ranking changes", "cost/speed explainer"],
  notFor: ["long-form documentary", "photo montage"],
  supportedIntents: ["comparison"],
  supportedScenes: ["signal_chart"],
  dataDensity: ["high"],
  motionFamily: "measured",
  visualFamily: "scene-gen-editorial-v2",
  output: {
    formats: ["mp4", "webm"],
    defaultFormat: "mp4",
    supportedAspects: ["9:16"],
    fps: [30],
    duration: { type: "variable", minSec: 8, maxSec: 22, defaultSec: 12 },
    audio: false,
  },
  inputs: { schema: { type: "object" }, examples: [] },
  license: {
    spdx: "MIT",
    attributionRequired: false,
    redistributionAllowed: true,
    commercialUse: true,
  },
  provenance: { kind: "original", note: "Scene Gen original template." },
  performance: { tier: "light", expectedRenderRatio: 0.35 },
  renderHtml: ({ scene, width, height }) => {
    const bars = scene.type === "signal_chart" ? scene.bars : [];
    const body = `<main class="hv-main">
      <div class="hv-kicker">Data Signal</div>
      <h1>${escapeHtml(sceneHeadline(scene))}</h1>
      <section style="position:absolute;left:0;right:0;top:250px;bottom:48px;display:flex;flex-direction:column;justify-content:space-evenly;gap:24px;">
        ${bars
          .map(
            (bar, index) => `<div style="min-height:220px;display:flex;flex-direction:column;justify-content:center;animation:hv-rise .55s ${index * 0.12}s both;">
              <div style="display:flex;justify-content:space-between;align-items:end;margin-bottom:10px;">
                <strong style="font-size:38px;color:#153f59;">${escapeHtml(bar.label)}</strong>
                <span style="font-size:42px;color:#06416f;font-weight:900;">${escapeHtml(bar.value)}%</span>
              </div>
              <div class="hv-card" style="height:42px;overflow:hidden;background:rgba(255,255,255,.36);">
                <div style="height:100%;width:${bar.value}%;transform-origin:left center;animation:hv-width 1s ${index * 0.18}s both;background:${escapeHtml(bar.color)};"></div>
              </div>
              <p style="margin-top:12px;font-size:26px;color:#25516b;">${escapeHtml(bar.detail)}</p>
            </div>`,
          )
          .join("")}
      </section>
    </main>`;
    return commonHtml({ title: sceneHeadline(scene), body, width, height, theme: "paper" });
  },
};
