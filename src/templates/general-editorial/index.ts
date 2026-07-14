import type { HtmlTemplateDefinition } from "../template.schema";
import { commonHtml, escapeHtml, headlineFontSize, pacedDelay, projectPublicationDate, sceneHeadline } from "../html-utils";

export const generalEditorialTemplate: HtmlTemplateDefinition = {
  id: "general-editorial",
  version: "1.1.0",
  name: "General Editorial",
  description: "Magazine-style vertical storytelling for business, society, policy, people, consumer and general-interest articles.",
  engine: "html-video",
  category: "general-story",
  subcategory: "magazine-narrative",
  tags: ["general", "article", "business", "society", "policy", "people", "consumer", "culture", "通用", "商业", "社会", "政策", "人物"],
  bestFor: ["general-interest article", "business story", "policy explainer", "people and society", "consumer news"],
  notFor: ["AI benchmark", "code architecture", "repository demo"],
  supportedIntents: ["hook", "briefing", "workflow", "summary"],
  supportedScenes: ["title", "briefing_points", "flow", "outro"],
  dataDensity: ["low", "medium", "high"],
  motionFamily: "editorial",
  visualFamily: "scene-gen-magazine-v1",
  variants: [
    { id: "magazine-cover", name: "Magazine Cover", tags: ["title", "人物", "社会", "消费"], bestFor: ["human-interest hook"] },
    { id: "fact-column", name: "Fact Column", tags: ["briefing_points", "事实", "商业", "政策"], bestFor: ["structured article facts"] },
    { id: "chapter-path", name: "Chapter Path", tags: ["flow", "经过", "原因", "过程"], bestFor: ["narrative sequence"] },
    { id: "closing-note", name: "Closing Note", tags: ["outro", "结论", "影响"], bestFor: ["editorial conclusion"] },
  ],
  output: {
    formats: ["mp4", "webm"],
    defaultFormat: "mp4",
    supportedAspects: ["9:16"],
    fps: [30],
    duration: { type: "variable", minSec: 6, maxSec: 28, defaultSec: 16 },
    audio: false,
  },
  inputs: { schema: { type: "object" }, examples: [] },
  license: { spdx: "MIT", attributionRequired: false, redistributionAllowed: true, commercialUse: true },
  provenance: { kind: "original", note: "Scene Gen original general-interest editorial template." },
  performance: { tier: "light", expectedRenderRatio: 0.4 },
  renderHtml: ({ project, scene, width, height, variantId }) => {
    const headline = sceneHeadline(scene);
    const publicationDate = projectPublicationDate(project);
    let body = "";
    if (scene.type === "title") {
      const size = headlineFontSize(scene.headline, 92, 62);
      body = `<main class="hv-main ge-main ge-cover">
        <div class="ge-section">今日焦点 · 深度解读</div>
        <div class="ge-issue">NO. 01</div>
        ${publicationDate ? `<div class="ge-date"><small>新闻日期</small><strong>${escapeHtml(publicationDate)}</strong></div>` : ""}
        <h1 style="font-size:${size}px">${escapeHtml(scene.headline).replace(/\n/g, "<br />")}</h1>
        <div class="ge-rule"></div>
        <p class="ge-deck">${escapeHtml(scene.subhead)}</p>
        <div class="ge-keywords">${scene.sources.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>
      </main>`;
    } else if (scene.type === "briefing_points") {
      body = `<main class="hv-main ge-main">
        <div class="ge-section">事实梳理</div><h1>${escapeHtml(scene.headline)}</h1>
        <section class="ge-lead"><strong>${escapeHtml(scene.title)}</strong><p>${escapeHtml(scene.summary)}</p></section>
        <div class="ge-metrics">${scene.metrics.map((item, index) => `<article style="animation-delay:${pacedDelay(index, scene.metrics.length, scene.duration)}s"><small>${escapeHtml(item.label)}</small><b>${escapeHtml(item.value)}</b></article>`).join("")}</div>
        <div class="ge-points">${scene.points.map((item, index) => `<article style="animation-delay:${pacedDelay(index, scene.points.length, scene.duration, 1.2)}s"><em>${String(index + 1).padStart(2, "0")}</em><p>${escapeHtml(item)}</p></article>`).join("")}</div>
      </main>`;
    } else if (scene.type === "flow") {
      body = `<main class="hv-main ge-main"><div class="ge-section">事件脉络</div><h1>${escapeHtml(scene.headline)}</h1>
        <div class="ge-flow">${scene.steps.map((item, index) => `<article style="animation-delay:${pacedDelay(index, scene.steps.length, scene.duration)}s"><em>${String(index + 1).padStart(2, "0")}</em><div><strong>${escapeHtml(item.label)}</strong><p>${escapeHtml(item.detail)}</p></div></article>`).join("")}</div>
      </main>`;
    } else if (scene.type === "outro") {
      body = `<main class="hv-main ge-main ge-outro"><div class="ge-section">结语</div><h1>${escapeHtml(scene.headline)}</h1>
        <div class="ge-closing">${scene.bullets.map((item, index) => `<article style="animation-delay:${pacedDelay(index, scene.bullets.length, scene.duration)}s"><span></span><p>${escapeHtml(item)}</p></article>`).join("")}</div>
      </main>`;
    } else {
      body = `<main class="hv-main ge-main"><h1>${escapeHtml(headline)}</h1></main>`;
    }
    const css = `
      body{color:#173148}.hv-root::before{background-size:54px 54px;opacity:.08}.hv-root::after{display:none}
      .ge-main{inset:112px 68px 94px}.ge-cover{display:flex;flex-direction:column;justify-content:center}.ge-cover .ge-section{margin-bottom:24px}.ge-cover::after{content:"";position:absolute;z-index:-1;top:80px;bottom:120px;left:-90px;width:22px;background:#d4483b;opacity:.16;animation:ge-accent-drift 7s ease-in-out infinite alternate}.ge-section{font-size:28px;font-weight:900;color:#d4483b;letter-spacing:.08em;margin-bottom:28px}.ge-main h1{max-width:900px;color:#102f49;text-shadow:none;line-height:1.08}.ge-date{display:grid;gap:8px;align-self:flex-start;margin-bottom:30px;padding:18px 24px;background:#d4483b;color:#fff;box-shadow:0 18px 50px rgba(212,72,59,.2)}.ge-date small{font-size:22px;font-weight:800;letter-spacing:.08em}.ge-date strong{font-size:46px;line-height:1;font-weight:950}.ge-issue{position:absolute;right:0;top:0;font-size:28px;font-weight:900;color:#d4483b;border-top:5px solid #d4483b;padding-top:12px}.ge-rule{width:220px;height:12px;background:#d4483b;margin:42px 0 34px;animation:hv-width .8s .25s both}.ge-deck{max-width:850px;color:#3f5c70;font-size:36px;line-height:1.5}.ge-keywords{display:flex;flex-wrap:wrap;gap:14px;margin-top:42px}.ge-keywords span{padding:14px 20px;border:2px solid #173148;font-size:25px;font-weight:800}.ge-lead{margin-top:34px;padding:34px 0;border-top:5px solid #173148;border-bottom:2px solid rgba(23,49,72,.25)}.ge-lead strong{font-size:46px;line-height:1.2}.ge-lead p{margin-top:18px;color:#486579;font-size:30px;line-height:1.45}.ge-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:24px}.ge-metrics article{padding:24px;background:#173148;color:#fff;animation:hv-rise .5s both}.ge-metrics small{display:block;font-size:20px;color:#f3d9b8}.ge-metrics b{display:block;margin-top:8px;font-size:34px}.ge-points{display:grid;gap:14px;margin-top:24px}.ge-points article,.ge-flow article{display:grid;grid-template-columns:74px 1fr;gap:20px;align-items:start;padding:24px 0;border-bottom:2px solid rgba(23,49,72,.18);animation:hv-rise .55s both}.ge-points em,.ge-flow em{font-size:34px;font-style:normal;font-weight:950;color:#d4483b}.ge-points p,.ge-flow p{color:#294b63;font-size:29px;line-height:1.42}.ge-flow{display:grid;gap:10px;margin-top:54px}.ge-flow strong{display:block;font-size:40px;color:#173148;margin-bottom:10px}.ge-outro{display:flex;flex-direction:column;justify-content:center}.ge-closing{display:grid;gap:24px;margin-top:54px}.ge-closing article{display:grid;grid-template-columns:18px 1fr;gap:22px;padding:28px 0;border-top:2px solid rgba(23,49,72,.2);animation:hv-rise .55s both}.ge-closing span{width:14px;height:100%;min-height:72px;background:#d4483b}.ge-closing p{color:#294b63;font-size:34px;line-height:1.45}
    `;
    return commonHtml({ title: headline, body, width, height, durationSec: scene.duration, theme: "paper", extraCss: css });
  },
};
