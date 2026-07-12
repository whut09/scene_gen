import type { HtmlTemplateDefinition } from "../template.schema";
import { commonHtml, escapeHtml, pacedDelay, sceneHeadline } from "../html-utils";

export const nytDataChartTemplate: HtmlTemplateDefinition = {
  id: "nyt-data-chart",
  version: "1.3.0",
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
  variants: [
    { id: "horizontal-bars", name: "Horizontal Bars", tags: ["速度", "价格", "性能", "benchmark"], bestFor: ["benchmark comparison"] },
    { id: "ranked-cards", name: "Ranked Cards", tags: ["数学", "研究", "论文", "得分", "猜想"], bestFor: ["research scorecard"] },
    { id: "category-cards", name: "Category Cards", tags: ["技能", "分类", "原则", "模块", "workflow", "framework", "testing", "debugging"], bestFor: ["qualitative capability groups"] },
    { id: "delta-lanes", name: "Delta Lanes", tags: ["提升", "增长", "前后", "变化"], bestFor: ["before after change"] },
  ],
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
  renderHtml: ({ scene, width, height, variantId }) => {
    const bars = scene.type === "signal_chart" ? scene.bars : [];
    const mixedMetrics = bars.some((bar) => typeof bar.value !== "number" || bar.value > 100);
    const metrics = bars.map((bar, index) =>
      '<article class="nyt-metric" style="animation-delay:' + pacedDelay(index, bars.length, scene.duration) + 's"><b>0' + (index + 1) + '</b><span>' + escapeHtml(bar.label) + '</span><strong>' + escapeHtml(bar.value) + '</strong><p>' + escapeHtml(bar.detail) + '</p><i style="background:' + escapeHtml(bar.color) + '"></i></article>'
    ).join('');
    const horizontal = bars.map((bar, index) =>
      '<article class="nyt-bar" style="animation-delay:' + pacedDelay(index, bars.length, scene.duration) + 's"><div class="nyt-bar-head"><strong>' + escapeHtml(bar.label) + '</strong><span>' + escapeHtml(bar.value) + '%</span></div>' +
      '<div class="nyt-track"><i style="width:' + bar.value + '%;background:' + escapeHtml(bar.color) + '"></i></div><p>' + escapeHtml(bar.detail) + '</p></article>'
    ).join('');
    const ranked = bars.map((bar, index) => {
      const metric = variantId === "category-cards"
        ? `<strong>${escapeHtml(bar.value)}${/路径/.test(bar.label) ? " 条" : " 个"}</strong>`
        : `<strong>关键 ${String(index + 1).padStart(2, "0")}</strong>`;
      return '<article class="nyt-rank" style="animation-delay:' + pacedDelay(index, bars.length, scene.duration) + 's"><b>0' + (index + 1) + '</b><div><span>' + escapeHtml(bar.label) + '</span>' + metric + '<p>' + escapeHtml(bar.detail) + '</p></div><i style="background:' + escapeHtml(bar.color) + '"></i></article>';
    }).join('');
    const deltas = bars.map((bar, index) =>
      '<article class="nyt-delta" style="animation-delay:' + pacedDelay(index, bars.length, scene.duration) + 's"><span>' + escapeHtml(bar.label) + '</span><strong>' + escapeHtml(bar.value) + '%</strong><p>' + escapeHtml(bar.detail) + '</p><i style="width:' + bar.value + '%;background:' + escapeHtml(bar.color) + '"></i></article>'
    ).join('');
    const content = mixedMetrics ? metrics : variantId === "ranked-cards" || variantId === "category-cards" ? ranked : variantId === "delta-lanes" ? deltas : horizontal;
    const body = '<main class="hv-main nyt-main nyt-' + variantId + '"><div class="hv-kicker">DATA / EVIDENCE</div><h1>' + escapeHtml(sceneHeadline(scene)) + '</h1><section class="nyt-content">' + content + '</section></main>';
    const css =
      '.nyt-main{inset:112px 58px 60px}.nyt-main h1{font-size:72px}.nyt-content{position:absolute;left:0;right:0;top:250px;bottom:20px}' +
      '.nyt-horizontal-bars .nyt-content{display:flex;flex-direction:column;justify-content:space-evenly;gap:22px}.nyt-bar{animation:hv-rise .55s both}.nyt-bar-head{display:flex;justify-content:space-between;align-items:end;margin-bottom:12px}.nyt-bar-head strong{font-size:38px;color:#153f59}.nyt-bar-head span{font-size:44px;color:#06416f;font-weight:950}.nyt-track{height:42px;background:rgba(255,255,255,.68);overflow:hidden}.nyt-track i{display:block;height:100%;transform-origin:left;animation:hv-width 1s both}.nyt-bar p{font-size:26px;margin-top:12px}' +
      '.nyt-ranked-cards .nyt-content,.nyt-category-cards .nyt-content{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:18px}.nyt-ranked-cards .nyt-rank,.nyt-category-cards .nyt-rank{position:relative;padding:30px;background:rgba(255,255,255,.82);display:grid;grid-template-columns:72px 1fr;gap:18px;align-items:start;overflow:hidden;animation:hv-rise .55s both}.nyt-rank>b{font-size:25px;color:#ff5f5f}.nyt-rank span{display:block;font-size:30px;font-weight:900;color:#153f59}.nyt-rank strong{display:block;font-size:72px;color:#062f50;margin:20px 0}.nyt-rank p{font-size:24px;line-height:1.42}.nyt-rank>i{position:absolute;left:0;right:0;bottom:0;height:12px}' +
      '.nyt-content:has(.nyt-metric){display:grid;grid-template-columns:1fr 1fr;grid-template-rows:repeat(3,1fr);gap:16px}.nyt-metric{position:relative;padding:24px 26px;background:rgba(255,255,255,.82);display:grid;grid-template-columns:52px 1fr;grid-template-rows:auto auto 1fr;column-gap:14px;overflow:hidden;animation:hv-rise .55s both}.nyt-metric>b{grid-row:1/3;font-size:22px;color:#ff5f5f}.nyt-metric span{font-size:25px;font-weight:900;color:#153f59}.nyt-metric strong{font-size:40px;line-height:1.1;color:#062f50;margin-top:10px}.nyt-metric p{grid-column:2;font-size:21px;line-height:1.35;margin-top:10px}.nyt-metric>i{position:absolute;left:0;right:0;bottom:0;height:10px}' +
      '.nyt-delta-lanes .nyt-content{display:grid;grid-template-rows:repeat(4,1fr);gap:16px}.nyt-delta{position:relative;padding:26px 30px;background:rgba(255,255,255,.76);display:grid;grid-template-columns:1fr auto;align-content:center;overflow:hidden;animation:hv-rise .55s both}.nyt-delta span{font-size:34px;font-weight:900;color:#153f59}.nyt-delta strong{font-size:54px;color:#062f50}.nyt-delta p{grid-column:1/-1;font-size:25px;margin-top:12px}.nyt-delta i{position:absolute;left:0;bottom:0;height:10px}';
    return commonHtml({ title: sceneHeadline(scene), body, width, height, durationSec: scene.duration, theme: "paper", extraCss: css });
  },
};
