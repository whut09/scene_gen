import type { HtmlTemplateDefinition } from "../template.schema";
import { commonHtml, escapeHtml, pacedDelay, sceneHeadline } from "../html-utils";

export const editorialStatGridTemplate: HtmlTemplateDefinition = {
  id: "editorial-stat-grid",
  version: "1.2.2",
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
  variants: [
    { id: "stat-grid", name: "Stat Grid", tags: ["价格", "性能", "速度", "成本", "分数"], bestFor: ["dense metrics"] },
    { id: "research-dossier", name: "Research Dossier", tags: ["数学", "猜想", "证明", "研究", "论文"], bestFor: ["research facts"] },
    { id: "manifesto", name: "Manifesto", tags: ["结论", "限制", "判断", "意义"], bestFor: ["editorial conclusion"] },
  ],
  output: {
    formats: ["mp4", "webm"], defaultFormat: "mp4", supportedAspects: ["9:16", "16:9"], fps: [30],
    duration: { type: "variable", minSec: 7, maxSec: 26, defaultSec: 15 }, audio: false,
  },
  inputs: { schema: { type: "object" }, examples: [] },
  license: { spdx: "MIT", attributionRequired: false, redistributionAllowed: true, commercialUse: true },
  provenance: { kind: "original", note: "Original Scene Gen editorial composition." },
  performance: { tier: "light", expectedRenderRatio: 0.35 },
  renderHtml: ({ scene, width, height, variantId }) => {
    let body = '';
    if (scene.type === "briefing_points") {
      const metrics = scene.metrics.slice(0, 3).map((metric, index) => {
        const length = [...metric.value].length;
        const density = length >= 14 ? ' es-metric-xlong' : length >= 9 ? ' es-metric-long' : '';
        return '<article class="es-metric es-metric-' + index + density + '"><span>' + escapeHtml(metric.label) + '</span><strong>' + escapeHtml(metric.value) + '</strong></article>';
      }).join('');
      const points = scene.points.slice(0, 4).map((point, index) =>
        '<li style="animation-delay:' + pacedDelay(index, scene.points.length, scene.duration) + 's"><b>' + String(index + 1).padStart(2, "0") + '</b><span>' + escapeHtml(point) + '</span></li>'
      ).join('');
      body = '<main class="hv-main es-main es-' + variantId + '"><div class="es-kicker">核心事实 / BRIEF</div><h1>' + escapeHtml(scene.headline) + '</h1>' +
        '<section class="es-lead"><h2>' + escapeHtml(scene.title) + '</h2><p>' + escapeHtml(scene.summary) + '</p></section>' +
        '<section class="es-metrics">' + metrics + '</section><ol class="es-points">' + points + '</ol></main>';
    } else if (scene.type === "news_stack") {
      const cards = scene.items.slice(0, 4).map((item, index) =>
        '<article class="es-news" style="animation-delay:' + pacedDelay(index, scene.items.length, scene.duration) + 's"><b>' + String(index + 1).padStart(2, "0") + '</b><div><h2>' + escapeHtml(item.title) + '</h2><p>' + escapeHtml(item.summary) + '</p></div></article>'
      ).join('');
      body = '<main class="hv-main es-main es-' + variantId + '"><div class="es-kicker">NEWS / FACTS</div><h1>' + escapeHtml(scene.headline) + '</h1><section class="es-news-grid">' + cards + '</section></main>';
    } else if (scene.type === "outro") {
      const points = scene.bullets.slice(0, 4).map((point, index) =>
        '<li style="animation-delay:' + pacedDelay(index, scene.bullets.length, scene.duration) + 's"><b>' + String(index + 1).padStart(2, "0") + '</b><span>' + escapeHtml(point) + '</span></li>'
      ).join('');
      body = '<main class="hv-main es-main es-' + variantId + ' es-outro"><div class="es-kicker">TAKEAWAY</div><h1>' + escapeHtml(scene.headline) + '</h1><ol class="es-points">' + points + '</ol></main>';
    } else {
      body = '<main class="hv-main es-main es-' + variantId + '"><h1>' + escapeHtml(sceneHeadline(scene)) + '</h1></main>';
    }
    const css =
      '.es-main{inset:112px 54px 64px}.es-kicker{font-size:24px;font-weight:950;letter-spacing:.12em;color:#075078;margin-bottom:18px}' +
      '.es-main h1{color:#062f50;text-shadow:none;font-size:74px;max-width:930px}' +
      '.es-lead{margin-top:34px;padding:30px 32px;border-left:12px solid #ff5f5f;background:rgba(255,255,255,.72);animation:hv-rise .55s both}' +
      '.es-lead h2{font-size:40px;line-height:1.18;color:#062f50}.es-lead p{font-size:28px;color:#31546c;margin-top:14px}' +
      '.es-metrics{display:grid;grid-template-columns:1.15fr .85fr;grid-template-rows:repeat(2,150px);gap:14px;margin-top:18px}' +
      '.es-metric{padding:24px;background:#0b5bd3;color:white;display:flex;flex-direction:column;justify-content:space-between;animation:hv-rise .55s .16s both}' +
      '.es-metric-0{grid-row:span 2;background:#082f75}.es-metric-1{background:#c83f3a}.es-metric-2{background:#087a67}' +
      '.es-metric span{font-size:23px;font-weight:800}.es-metric strong{font-size:48px;line-height:1.06;font-weight:950;overflow-wrap:anywhere}.es-metric:not(.es-metric-0){padding:18px 20px}.es-metric:not(.es-metric-0) strong{font-size:34px;line-height:1.08}.es-metric-long strong{font-size:32px}.es-metric-xlong strong{font-size:27px;line-height:1.12}' +
      '.es-points{list-style:none;padding:0;margin:20px 0 0;display:grid;gap:12px}' +
      '.es-points li{display:grid;grid-template-columns:72px 1fr;gap:18px;align-items:center;padding:20px 24px;background:rgba(255,255,255,.72);color:#153f59;animation:hv-rise .5s both}' +
      '.es-points b{font-size:22px;color:#ff5f5f}.es-points span{font-size:27px;line-height:1.38;font-weight:750}' +
      '.es-news-grid{margin-top:34px;display:grid;gap:14px}.es-news{display:grid;grid-template-columns:72px 1fr;gap:20px;padding:28px;background:rgba(255,255,255,.76);color:#123b56;animation:hv-rise .55s both}' +
      '.es-news>b{font-size:28px;color:#ff5f5f}.es-news h2{font-size:38px;line-height:1.18}.es-news p{font-size:26px;color:#36586d;margin-top:10px}.es-outro{display:flex;flex-direction:column;justify-content:center}' +
      '.es-research-dossier .es-lead{margin-left:110px;border-left:0;border-top:12px solid #ff5f5f}.es-research-dossier .es-metrics{grid-template-columns:repeat(3,1fr);grid-template-rows:210px}.es-research-dossier .es-metric-0{grid-row:auto}.es-research-dossier .es-points{grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr}.es-research-dossier .es-points li{grid-template-columns:54px 1fr;min-height:150px}' +
      '.es-manifesto{text-align:center;align-items:center}.es-manifesto .es-points{width:92%;margin-top:50px}.es-manifesto .es-points li{min-height:150px;text-align:left}.es-manifesto h1{font-size:88px}' +
      '.es-stat-grid .es-metrics{transform:rotate(-1deg)}' +
      '.es-metric,.es-points li{position:relative;overflow:hidden}.es-metric::after,.es-points li::after{content:"";position:absolute;inset:0;background:linear-gradient(105deg,transparent 0 42%,rgba(255,255,255,.28) 50%,transparent 58%);transform:translateX(-130%);animation:es-focus 6.4s infinite}.es-metric:nth-child(2)::after,.es-points li:nth-child(2)::after{animation-delay:1.4s}.es-metric:nth-child(3)::after,.es-points li:nth-child(3)::after{animation-delay:2.8s}.es-points li:nth-child(4)::after{animation-delay:4.2s}@keyframes es-focus{0%,48%{transform:translateX(-130%)}66%,100%{transform:translateX(130%)}}.es-metric,.es-points li{animation:hv-rise .5s both,es-breathe 3.2s ease-in-out infinite alternate}.es-metric-1,.es-points li:nth-child(2){animation-delay:.16s,-1.1s}.es-metric-2,.es-points li:nth-child(3){animation-delay:.16s,-2.2s}.es-points li:nth-child(4){animation-delay:.16s,-.55s}@keyframes es-breathe{from{filter:brightness(.98);box-shadow:0 0 0 rgba(8,47,117,0)}to{filter:brightness(1.045);box-shadow:0 14px 40px rgba(8,47,117,.12)}}';
    return commonHtml({ title: sceneHeadline(scene), body, width, height, durationSec: scene.duration, theme: "paper", extraCss: css });
  },
};
