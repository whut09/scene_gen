import type { HtmlTemplateDefinition } from "../template.schema";
import { commonHtml, escapeHtml, sceneHeadline } from "../html-utils";

export const editorialStatGridTemplate: HtmlTemplateDefinition = {
  id: "editorial-stat-grid",
  version: "1.0.0",
  name: "Editorial Stat Grid",
  description: "Asymmetric magazine layout that turns facts, metrics and points into a strong vertical composition.",
  engine: "html-video",
  category: "news-explainer",
  subcategory: "editorial-grid",
  tags: ["news", "briefing", "metrics", "editorial", "facts"],
  bestFor: ["product launch facts", "pricing and performance", "dense briefing"],
  notFor: ["raw screenshots", "single short quote", "step-by-step workflow"],
  supportedIntents: ["briefing", "summary"],
  supportedScenes: ["briefing_points", "news_stack", "outro"],
  dataDensity: ["medium", "high"],
  motionFamily: "editorial",
  visualFamily: "scene-gen-editorial-v2",
  output: {
    formats: ["mp4", "webm"], defaultFormat: "mp4", supportedAspects: ["9:16", "16:9"], fps: [30],
    duration: { type: "variable", minSec: 7, maxSec: 26, defaultSec: 15 }, audio: false,
  },
  inputs: { schema: { type: "object" }, examples: [] },
  license: { spdx: "MIT", attributionRequired: false, redistributionAllowed: true, commercialUse: true },
  provenance: { kind: "original", note: "Original Scene Gen editorial composition." },
  performance: { tier: "light", expectedRenderRatio: 0.35 },
  renderHtml: ({ scene, width, height }) => {
    let body = '';
    if (scene.type === "briefing_points") {
      const metrics = scene.metrics.slice(0, 3).map((metric, index) =>
        '<article class="es-metric es-metric-' + index + '"><span>' + escapeHtml(metric.label) + '</span><strong>' + escapeHtml(metric.value) + '</strong></article>'
      ).join('');
      const points = scene.points.slice(0, 4).map((point, index) =>
        '<li style="animation-delay:' + (0.28 + index * 0.12) + 's"><b>' + String(index + 1).padStart(2, "0") + '</b><span>' + escapeHtml(point) + '</span></li>'
      ).join('');
      body = '<main class="hv-main es-main"><div class="es-kicker">核心事实 / BRIEF</div><h1>' + escapeHtml(scene.headline) + '</h1>' +
        '<section class="es-lead"><h2>' + escapeHtml(scene.title) + '</h2><p>' + escapeHtml(scene.summary) + '</p></section>' +
        '<section class="es-metrics">' + metrics + '</section><ol class="es-points">' + points + '</ol></main>';
    } else if (scene.type === "news_stack") {
      const cards = scene.items.slice(0, 4).map((item, index) =>
        '<article class="es-news" style="animation-delay:' + (index * 0.12) + 's"><b>' + String(index + 1).padStart(2, "0") + '</b><div><h2>' + escapeHtml(item.title) + '</h2><p>' + escapeHtml(item.summary) + '</p></div></article>'
      ).join('');
      body = '<main class="hv-main es-main"><div class="es-kicker">NEWS / FACTS</div><h1>' + escapeHtml(scene.headline) + '</h1><section class="es-news-grid">' + cards + '</section></main>';
    } else if (scene.type === "outro") {
      const points = scene.bullets.slice(0, 4).map((point, index) =>
        '<li style="animation-delay:' + (index * 0.14) + 's"><b>' + String(index + 1).padStart(2, "0") + '</b><span>' + escapeHtml(point) + '</span></li>'
      ).join('');
      body = '<main class="hv-main es-main es-outro"><div class="es-kicker">TAKEAWAY</div><h1>' + escapeHtml(scene.headline) + '</h1><ol class="es-points">' + points + '</ol></main>';
    } else {
      body = '<main class="hv-main es-main"><h1>' + escapeHtml(sceneHeadline(scene)) + '</h1></main>';
    }
    const css =
      '.es-main{inset:112px 54px 64px}.es-kicker{font-size:24px;font-weight:950;letter-spacing:.12em;color:#075078;margin-bottom:18px}' +
      '.es-main h1{color:#062f50;text-shadow:none;font-size:74px;max-width:930px}' +
      '.es-lead{margin-top:34px;padding:30px 32px;border-left:12px solid #ff5f5f;background:rgba(255,255,255,.72);animation:hv-rise .55s both}' +
      '.es-lead h2{font-size:40px;line-height:1.18;color:#062f50}.es-lead p{font-size:28px;color:#31546c;margin-top:14px}' +
      '.es-metrics{display:grid;grid-template-columns:1.15fr .85fr;grid-template-rows:repeat(2,150px);gap:14px;margin-top:18px}' +
      '.es-metric{padding:24px;background:#0b5bd3;color:white;display:flex;flex-direction:column;justify-content:space-between;animation:hv-rise .55s .16s both}' +
      '.es-metric-0{grid-row:span 2;background:#082f75}.es-metric-1{background:#ff6961}.es-metric-2{background:#17a98b}' +
      '.es-metric span{font-size:23px;font-weight:800}.es-metric strong{font-size:54px;line-height:1;font-weight:950}' +
      '.es-points{list-style:none;padding:0;margin:20px 0 0;display:grid;gap:12px}' +
      '.es-points li{display:grid;grid-template-columns:72px 1fr;gap:18px;align-items:center;padding:20px 24px;background:rgba(255,255,255,.72);color:#153f59;animation:hv-rise .5s both}' +
      '.es-points b{font-size:22px;color:#ff5f5f}.es-points span{font-size:27px;line-height:1.38;font-weight:750}' +
      '.es-news-grid{margin-top:34px;display:grid;gap:14px}.es-news{display:grid;grid-template-columns:72px 1fr;gap:20px;padding:28px;background:rgba(255,255,255,.76);color:#123b56;animation:hv-rise .55s both}' +
      '.es-news>b{font-size:28px;color:#ff5f5f}.es-news h2{font-size:38px;line-height:1.18}.es-news p{font-size:26px;color:#36586d;margin-top:10px}.es-outro{display:flex;flex-direction:column;justify-content:center}';
    return commonHtml({ title: sceneHeadline(scene), body, width, height, theme: "paper", extraCss: css });
  },
};
