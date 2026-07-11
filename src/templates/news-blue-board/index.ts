import type { HtmlTemplateDefinition } from "../template.schema";
import { commonHtml, escapeHtml, pacedDelay, sceneHeadline } from "../html-utils";

export const newsBlueBoardTemplate: HtmlTemplateDefinition = {
  id: "news-blue-board",
  version: "1.1.0",
  name: "News Blue Board",
  description: "Vertical blue teaching-board layout for AI news briefings.",
  engine: "html-video",
  category: "news-explainer",
  subcategory: "fact-board",
  tags: ["news", "briefing", "blue-board", "vertical"],
  bestFor: ["AI news summary", "briefing points", "source-light explainer"],
  notFor: ["long-form documentary", "photo montage"],
  supportedIntents: ["briefing", "evidence"],
  supportedScenes: ["briefing_points", "news_stack", "web_screenshot_zoom"],
  dataDensity: ["medium", "high"],
  motionFamily: "editorial",
  visualFamily: "scene-gen-editorial-v2",
  variants: [
    { id: "evidence-board", name: "Evidence Board", tags: ["数学", "猜想", "证明", "研究", "论文", "benchmark"], bestFor: ["research evidence"] },
    { id: "metric-stack", name: "Metric Stack", tags: ["价格", "性能", "速度", "成本", "score"], bestFor: ["metric briefing"] },
    { id: "concept-map", name: "Concept Map", tags: ["agent", "架构", "prompt", "流程"], bestFor: ["concept explanation"] },
  ],
  output: {
    formats: ["mp4", "webm"],
    defaultFormat: "mp4",
    supportedAspects: ["9:16"],
    fps: [30],
    duration: { type: "variable", minSec: 6, maxSec: 24, defaultSec: 14 },
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
    let body = "";
    if (scene.type === "briefing_points") {
      body = `<main class="hv-main" style="display:flex;flex-direction:column;">
        <div class="hv-kicker">${escapeHtml(scene.source)}</div>
        <h1>${escapeHtml(scene.headline)}</h1>
        <section class="hv-card" style="margin-top:44px;padding:34px;">
          <h2 style="font-size:44px;line-height:1.18;margin-bottom:18px;">${escapeHtml(scene.title)}</h2>
          <p>${escapeHtml(scene.summary)}</p>
        </section>
        <section style="display:grid;grid-template-columns:repeat(${Math.max(1, scene.metrics.length)},1fr);gap:14px;margin-top:20px;">
          ${scene.metrics
            .map(
              (metric) => `<div class="hv-card" style="padding:22px;min-height:104px;">
                <div style="font-size:22px;color:rgba(255,255,255,.7);">${escapeHtml(metric.label)}</div>
                <strong style="display:block;margin-top:8px;font-size:38px;color:#fff36a;">${escapeHtml(metric.value)}</strong>
              </div>`,
            )
            .join("")}
        </section>
        <section style="display:grid;grid-template-rows:repeat(${Math.max(1, scene.points.length)},1fr);gap:18px;margin-top:24px;flex:1;min-height:640px;">
          ${scene.points
            .map(
              (point, index) => `<div class="hv-card" style="display:grid;grid-template-columns:72px 1fr;align-items:center;gap:20px;padding:24px;min-height:138px;animation:hv-rise .55s ${pacedDelay(index, scene.points.length, scene.duration)}s both;">
                <span style="width:54px;height:54px;border-radius:50%;display:grid;place-items:center;background:#fff36a;color:#0847a6;font-size:28px;font-weight:900;">${index + 1}</span>
                <p style="font-size:30px;line-height:1.42;">${escapeHtml(point)}</p>
              </div>`,
            )
            .join("")}
        </section>
      </main>`;
    } else if (scene.type === "news_stack") {
      body = `<main class="hv-main"><h1>${escapeHtml(scene.headline)}</h1>
        <section style="display:grid;gap:22px;margin-top:48px;">
          ${scene.items
            .map(
              (item, index) => `<article class="hv-card" style="display:grid;grid-template-columns:74px 1fr;gap:24px;padding:30px;animation:hv-rise .55s ${pacedDelay(index, scene.items.length, scene.duration)}s both;">
                <span style="width:58px;height:58px;border-radius:50%;display:grid;place-items:center;background:#fff36a;color:#0847a6;font-size:28px;font-weight:900;">${index + 1}</span>
                <div><div style="font-size:22px;color:rgba(255,255,255,.7);">${escapeHtml(item.source)}</div>
                <h2 style="font-size:42px;line-height:1.18;margin:8px 0 12px;">${escapeHtml(item.title)}</h2>
                <p style="font-size:28px;">${escapeHtml(item.summary)}</p></div>
              </article>`,
            )
            .join("")}
        </section></main>`;
    } else if (scene.type === "web_screenshot_zoom") {
      const shot = scene.shots[0];
      body = `<main class="hv-main"><h1>${escapeHtml(scene.headline)}</h1>
        <section class="hv-card" style="margin-top:44px;padding:18px;">
          ${
            shot
              ? `<img src="${escapeHtml(shot.src)}" style="width:100%;height:980px;object-fit:cover;filter:saturate(.9) brightness(1.08);opacity:.9;" />`
              : ""
          }
        </section>
        <p style="margin-top:26px;">${escapeHtml(shot?.title ?? sceneHeadline(scene))}</p></main>`;
    } else {
      body = `<main class="hv-main"><h1>${escapeHtml(sceneHeadline(scene))}</h1></main>`;
    }
    return commonHtml({ title: sceneHeadline(scene), body, width, height, durationSec: scene.duration, theme: "blue" });
  },
};
