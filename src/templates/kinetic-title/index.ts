import type { HtmlTemplateDefinition } from "../template.schema";
import { commonHtml, escapeHtml, sceneHeadline } from "../html-utils";

export const kineticTitleTemplate: HtmlTemplateDefinition = {
  id: "kinetic-title",
  version: "1.0.0",
  name: "Kinetic Title",
  description: "Oversized editorial typography with paced signal strips for hooks and conclusions.",
  engine: "html-video",
  category: "title-card",
  subcategory: "kinetic-editorial",
  tags: ["title", "outro", "kinetic", "editorial", "hook"],
  bestFor: ["breaking-news hook", "model launch", "strong final conclusion"],
  notFor: ["dense data", "screenshot evidence", "long lists"],
  supportedIntents: ["hook", "summary"],
  supportedScenes: ["title", "outro"],
  dataDensity: ["low", "medium"],
  motionFamily: "kinetic",
  visualFamily: "scene-gen-editorial-v2",
  output: {
    formats: ["mp4", "webm"],
    defaultFormat: "mp4",
    supportedAspects: ["9:16", "16:9"],
    fps: [30],
    duration: { type: "variable", minSec: 4, maxSec: 18, defaultSec: 8 },
    audio: false,
  },
  inputs: { schema: { type: "object" }, examples: [] },
  license: { spdx: "MIT", attributionRequired: false, redistributionAllowed: true, commercialUse: true },
  provenance: { kind: "original", note: "Original Scene Gen implementation inspired by metadata-driven HTML video systems." },
  performance: { tier: "light", expectedRenderRatio: 0.3 },
  renderHtml: ({ scene, width, height }) => {
    const isTitle = scene.type === "title";
    const headline = isTitle ? scene.headline : scene.type === "outro" ? scene.headline : sceneHeadline(scene);
    const supporting = isTitle ? scene.subhead : scene.type === "outro" ? scene.bullets.slice(0, 3).join(" / ") : "";
    const kicker = isTitle ? scene.kicker : "最终结论";
    const body =
      '<main class="hv-main kt-main">' +
      '<div class="kt-index">01</div>' +
      '<div class="kt-kicker">' + escapeHtml(kicker) + '</div>' +
      '<h1 class="kt-title">' + escapeHtml(headline).replace(/\n/g, "<br />") + '</h1>' +
      '<div class="kt-rule"><i></i><i></i><i></i></div>' +
      '<p class="kt-support">' + escapeHtml(supporting) + '</p>' +
      '<div class="kt-stamp">NEWS / SIGNAL</div>' +
      '</main>';
    const css =
      '.kt-main{inset:112px 58px 72px;display:flex;flex-direction:column;justify-content:center;}' +
      '.kt-index{position:absolute;right:0;top:0;font-size:260px;line-height:.8;font-weight:950;color:rgba(255,255,255,.09);}' +
      '.kt-kicker{font-size:30px;font-weight:900;color:#fff36a;margin-bottom:26px;animation:hv-rise .45s both;}' +
      '.kt-title{font-size:94px;line-height:1.08;max-width:950px;letter-spacing:0;animation:kt-slam .72s cubic-bezier(.16,.86,.22,1) both;}' +
      '.kt-rule{display:grid;grid-template-columns:1.7fr .7fr .35fr;gap:12px;width:72%;margin:42px 0 34px;}' +
      '.kt-rule i{height:12px;background:#fff36a;transform-origin:left;animation:hv-width .8s .3s both;}' +
      '.kt-rule i:nth-child(2){background:#72f0ff;animation-delay:.45s}.kt-rule i:nth-child(3){background:#ff8bd7;animation-delay:.6s}' +
      '.kt-support{font-size:34px;max-width:850px;animation:hv-rise .55s .5s both;}' +
      '.kt-stamp{position:absolute;left:0;bottom:4px;font-size:20px;font-weight:900;letter-spacing:.18em;color:rgba(255,255,255,.58);}' +
      '@keyframes kt-slam{from{opacity:0;transform:translateY(64px) scale(.92)}to{opacity:1;transform:none}}';
    return commonHtml({ title: headline, body, width, height, theme: "blue", extraCss: css });
  },
};
