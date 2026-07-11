import type { HtmlTemplateDefinition } from "../template.schema";
import { commonHtml, escapeHtml, sceneHeadline } from "../html-utils";

export const boldSignalTemplate: HtmlTemplateDefinition = {
  id: "bold-signal",
  version: "1.1.0",
  name: "Bold Signal",
  description: "High-impact title and outro frame for short-form news videos.",
  engine: "html-video",
  category: "title-card",
  subcategory: "social-hook",
  tags: ["title", "outro", "bold", "signal"],
  bestFor: ["opening hook", "final takeaway", "viral short title"],
  notFor: ["long-form documentary", "photo montage"],
  supportedIntents: ["hook", "summary"],
  supportedScenes: ["title", "outro"],
  dataDensity: ["low", "medium"],
  motionFamily: "kinetic",
  visualFamily: "scene-gen-editorial-v2",
  variants: [
    { id: "impact-center", name: "Impact Center", tags: ["发布", "价格", "性能", "release", "price"], bestFor: ["product launch", "headline impact"] },
    { id: "quote-split", name: "Quote Split", tags: ["结论", "安全", "限制", "判断"], bestFor: ["final takeaway", "contrast statement"] },
    { id: "minimal-pulse", name: "Minimal Pulse", tags: ["新闻", "模型"], bestFor: ["short clean hook"] },
  ],
  output: {
    formats: ["mp4", "webm"],
    defaultFormat: "mp4",
    supportedAspects: ["9:16"],
    fps: [30],
    duration: { type: "variable", minSec: 4, maxSec: 14, defaultSec: 7 },
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
    const isTitle = scene.type === "title";
    const headline = isTitle ? scene.headline : scene.type === "outro" ? scene.headline : sceneHeadline(scene);
    const sub = isTitle ? scene.subhead : scene.type === "outro" ? scene.bullets.join(" / ") : "";
    const body = `<main class="hv-main" style="display:grid;align-content:center;inset:120px 58px 120px;">
      <div class="hv-kicker">${escapeHtml(isTitle ? scene.kicker : "Final Signal")}</div>
      <h1 style="font-size:92px;max-width:940px;">${escapeHtml(headline)}</h1>
      <p style="margin-top:34px;max-width:860px;font-size:36px;">${escapeHtml(sub)}</p>
      <div style="margin-top:52px;width:360px;height:10px;background:#fff36a;transform-origin:left center;animation:hv-width 1s .25s both;"></div>
    </main>`;
    return commonHtml({ title: headline, body, width, height, theme: "blue" });
  },
};
