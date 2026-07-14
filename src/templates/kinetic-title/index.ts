import type { HtmlTemplateDefinition } from "../template.schema";
import { commonHtml, escapeHtml, headlineFontSize, projectHeroAsset, projectPublicationDate, projectSourceUrl, sceneHeadline } from "../html-utils";

export const kineticTitleTemplate: HtmlTemplateDefinition = {
  id: "kinetic-title",
  version: "1.3.0",
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
  variants: [
    { id: "research-stack", name: "Research Stack", tags: ["数学", "猜想", "证明", "研究", "论文", "math", "proof"], bestFor: ["research breakthrough"] },
    { id: "agent-split", name: "Agent Split", tags: ["agent", "智能体", "prompt", "子agent"], bestFor: ["multi-agent system"] },
    { id: "launch-impact", name: "Launch Impact", tags: ["发布", "模型", "价格", "release"], bestFor: ["model launch"] },
    { id: "final-signal", name: "Final Signal", tags: ["outro", "summary", "结论", "判断", "限制"], bestFor: ["final conclusion"] },
  ],
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
  renderHtml: ({ project, scene, width, height, variantId }) => {
    const isTitle = scene.type === "title";
    const headline = isTitle ? scene.headline : scene.type === "outro" ? scene.headline : sceneHeadline(scene);
    const supporting = isTitle ? scene.subhead : scene.type === "outro" ? scene.bullets.slice(0, 3).join(" / ") : "";
    const kicker = isTitle ? scene.kicker : "最终结论";
    const titleSize = headlineFontSize(headline, 88, 60);
    const repoUrl = projectSourceUrl(project);
    const publicationDate = projectPublicationDate(project);
    const heroAsset = projectHeroAsset(project);
    const body =
      '<main class="hv-main kt-main kt-' + variantId + (isTitle && publicationDate ? ' kt-news' : '') + '" style="--kt-title-size:' + titleSize + 'px">' +
      (heroAsset ? '<figure class="kt-asset"><img src="' + escapeHtml(heroAsset) + '" /></figure>' : '') +
      '<div class="kt-index">' + (isTitle ? "01" : "05") + '</div>' +
      (isTitle && repoUrl ? '<section class="kt-github"><strong>GitHub 开源项目推荐</strong><span>' + escapeHtml(repoUrl) + '</span></section>' : '') +
      (isTitle && publicationDate ? '<section class="kt-date"><small>新闻日期</small><strong>' + escapeHtml(publicationDate) + '</strong></section>' : '') +
      '<div class="kt-kicker">' + escapeHtml(kicker) + '</div>' +
      '<h1 class="kt-title">' + escapeHtml(headline).replace(/\n/g, "<br />") + '</h1>' +
      '<div class="kt-rule"><i></i><i></i><i></i></div>' +
      '<p class="kt-support">' + escapeHtml(supporting) + '</p>' +
      '<div class="kt-stamp">' + (repoUrl ? escapeHtml(repoUrl) : 'NEWS / SIGNAL') + '</div>' +
      '</main>';
    const css =
      '.kt-main{inset:112px 58px 72px;display:flex;flex-direction:column;justify-content:center;}' +
      '.kt-asset{position:absolute;right:-20px;top:90px;width:520px;height:610px;margin:0;overflow:hidden;border:2px solid rgba(255,255,255,.38);background:rgba(3,21,52,.38);box-shadow:0 36px 100px rgba(0,20,70,.3);animation:kt-asset-in .9s .18s both}.kt-asset img{width:100%;height:100%;object-fit:contain;background:rgba(255,255,255,.96)}' +
      '.kt-index{position:absolute;right:0;top:0;font-size:260px;line-height:.8;font-weight:950;color:rgba(255,255,255,.09);}' +
      '.kt-kicker{font-size:30px;font-weight:900;color:#fff36a;margin-bottom:26px;animation:hv-rise .45s both;}' +
      '.kt-date{display:grid;gap:8px;align-self:flex-start;margin-bottom:32px;padding:18px 24px;background:#fff36a;color:#083f99;box-shadow:0 18px 52px rgba(0,20,70,.18);animation:hv-rise .5s .08s both}.kt-date small{font-size:22px;font-weight:850;letter-spacing:.08em}.kt-date strong{font-size:46px;line-height:1;font-weight:950}' +
      '.kt-github{display:grid;gap:12px;margin:0 0 34px;padding:24px 28px;border-left:10px solid #fff36a;background:rgba(4,35,93,.34);box-shadow:0 22px 70px rgba(0,20,70,.18);animation:hv-rise .5s .08s both}.kt-github strong{font-size:54px;line-height:1.05;color:#fff36a}.kt-github span{font-size:42px;line-height:1.16;font-weight:900;color:#fff;overflow-wrap:anywhere}' +
      '.kt-title{font-size:var(--kt-title-size);line-height:1.08;max-width:950px;letter-spacing:0;animation:kt-slam .72s cubic-bezier(.16,.86,.22,1) both;}' +
      '.kt-rule{display:grid;grid-template-columns:1.7fr .7fr .35fr;gap:12px;width:72%;margin:42px 0 34px;}' +
      '.kt-rule i{height:12px;background:#fff36a;transform-origin:left;animation:hv-width .8s .3s both;}' +
      '.kt-rule i:nth-child(2){background:#72f0ff;animation-delay:.45s}.kt-rule i:nth-child(3){background:#ff8bd7;animation-delay:.6s}' +
      '.kt-support{font-size:34px;max-width:850px;animation:hv-rise .55s .5s both;}' +
      '.kt-stamp{position:absolute;left:0;right:0;bottom:4px;font-size:30px;line-height:1.2;font-weight:900;letter-spacing:.04em;color:rgba(255,255,255,.82);overflow-wrap:anywhere;}' +
      '.kt-research-stack{justify-content:flex-start;padding-top:220px}.kt-research-stack .kt-title{font-size:min(var(--kt-title-size),82px);max-width:900px}.kt-research-stack .kt-support{margin-top:28px;padding:30px;border-left:10px solid #fff36a;background:rgba(255,255,255,.12)}' +
      '.kt-agent-split{justify-content:flex-start;padding-top:700px}.kt-agent-split .kt-asset{top:64px;left:0;right:0;width:100%;height:560px}.kt-agent-split .kt-github{margin-bottom:24px}.kt-agent-split .kt-kicker{margin-bottom:18px}.kt-agent-split .kt-title{font-size:min(var(--kt-title-size),76px);max-width:880px}.kt-agent-split .kt-index{top:500px;right:-28px;font-size:330px}.kt-agent-split .kt-rule{width:48%;margin:30px 0 24px}.kt-agent-split .kt-support{margin-left:110px;max-width:790px;padding-left:28px;border-left:8px solid #72f0ff}' +
      '.kt-news{justify-content:center}.kt-news.kt-agent-split{justify-content:center;padding-top:0}.kt-news .kt-title{max-width:920px}.kt-news .kt-support{margin-left:0;max-width:850px;padding-left:0;border-left:0}' +
      '.kt-launch-impact .kt-title{font-size:var(--kt-title-size)}.kt-launch-impact .kt-rule{width:84%}' +
      '.kt-final-signal{justify-content:center;text-align:center;align-items:center}.kt-final-signal .kt-index{left:50%;right:auto;top:110px;transform:translateX(-50%)}.kt-final-signal .kt-title{font-size:var(--kt-title-size)}.kt-final-signal .kt-support{max-width:900px}.kt-final-signal .kt-stamp{left:50%;transform:translateX(-50%)}' +
      '@keyframes kt-asset-in{from{opacity:0;transform:translateY(38px) scale(.96)}to{opacity:1;transform:none}}@keyframes kt-slam{from{opacity:0;transform:translateY(64px) scale(.92)}to{opacity:1;transform:none}}';
    return commonHtml({ title: headline, body, width, height, durationSec: scene.duration, theme: "blue", extraCss: css });
  },
};
