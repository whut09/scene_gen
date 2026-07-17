import type { HtmlTemplateDefinition } from "../template.schema";
import { commonHtml, escapeHtml, headlineFontSize, projectPublicationDate, sceneHeadline } from "../html-utils";

export const boldSignalTemplate: HtmlTemplateDefinition = {
  id: "bold-signal",
  version: "1.4.0",
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
  renderHtml: ({ project, scene, width, height }) => {
    const isTitle = scene.type === "title";
    const headline = isTitle ? scene.headline : scene.type === "outro" ? scene.headline : sceneHeadline(scene);
    const titleSize = headlineFontSize(headline, 88, 60);
    const publicationDate = projectPublicationDate(project);
    const sub = isTitle ? scene.subhead : scene.type === "outro" ? scene.bullets.join(" / ") : "";
    const body = `<div class="bs-motion" aria-hidden="true"><i></i><i></i><i></i></div>
    <main class="hv-main bs-main" style="display:grid;align-content:center;inset:120px 58px 120px;">
      ${isTitle && publicationDate ? `<section style="display:grid;gap:8px;justify-self:start;margin-bottom:34px;padding:18px 24px;background:#fff36a;color:#083f99;">
        <small style="font-size:22px;font-weight:850;letter-spacing:.08em;">新闻日期</small>
        <strong style="font-size:46px;line-height:1;font-weight:950;">${escapeHtml(publicationDate)}</strong>
      </section>` : ""}
      <div class="hv-kicker">${escapeHtml(isTitle ? scene.kicker : "Final Signal")}</div>
      <h1 style="font-size:${titleSize}px;max-width:940px;">${escapeHtml(headline)}</h1>
      <p style="margin-top:34px;max-width:860px;font-size:36px;">${escapeHtml(sub)}</p>
      <div style="margin-top:52px;width:360px;height:10px;background:#fff36a;transform-origin:left center;animation:hv-width 1s .25s both;"></div>
    </main>`;
    const css = `.bs-motion{position:absolute;z-index:1;inset:0;overflow:hidden;pointer-events:none}.bs-motion i{position:absolute;display:block;border-radius:999px;will-change:transform,opacity}.bs-motion i:nth-child(1){width:760px;height:760px;left:-390px;top:180px;border:44px solid rgba(114,240,255,.16);animation:bs-orbit-a 8s ease-in-out infinite alternate}.bs-motion i:nth-child(2){width:520px;height:140px;right:-220px;top:420px;background:linear-gradient(90deg,rgba(255,243,106,0),rgba(255,243,106,.28),rgba(255,243,106,0));transform:rotate(-18deg);animation:bs-signal 5.5s ease-in-out infinite}.bs-motion i:nth-child(3){width:360px;height:360px;right:-120px;bottom:120px;border:28px solid rgba(255,139,215,.14);animation:bs-orbit-b 7s ease-in-out infinite alternate}.bs-main{animation:hv-enter .72s cubic-bezier(.2,.8,.2,1) both,bs-breathe 6s 1.2s ease-in-out infinite alternate}@keyframes bs-orbit-a{from{transform:translate(-70px,-40px) scale(.94);opacity:.55}to{transform:translate(180px,150px) scale(1.12);opacity:1}}@keyframes bs-orbit-b{from{transform:translate(40px,80px) scale(.9);opacity:.5}to{transform:translate(-180px,-170px) scale(1.16);opacity:1}}@keyframes bs-signal{0%,100%{transform:translateX(180px) rotate(-18deg);opacity:.25}50%{transform:translateX(-520px) rotate(-18deg);opacity:1}}@keyframes bs-breathe{from{transform:translateY(0) scale(1)}to{transform:translateY(-10px) scale(1.008)}}`;
    return commonHtml({ title: headline, body, width, height, durationSec: scene.duration, theme: "blue", extraCss: css });
  },
};
