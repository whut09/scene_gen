import type { HtmlTemplateDefinition } from "../template.schema";
import { commonHtml, escapeHtml, sceneHeadline } from "../html-utils";

export const decisionFlowTemplate: HtmlTemplateDefinition = {
  id: "decision-flow",
  version: "1.0.0",
  name: "Decision Flow",
  description: "A vertical cause-and-effect spine with alternating evidence nodes.",
  engine: "html-video",
  category: "workflow",
  subcategory: "decision-spine",
  tags: ["flow", "timeline", "cause", "effect", "decision", "steps"],
  bestFor: ["impact chain", "release timeline", "agent workflow", "technical dependency"],
  notFor: ["single statistic", "title hook", "photo showcase"],
  supportedIntents: ["workflow", "timeline", "repository"],
  supportedScenes: ["flow", "timeline", "github_pulse"],
  dataDensity: ["medium", "high"],
  motionFamily: "diagram",
  visualFamily: "scene-gen-editorial-v2",
  output: {
    formats: ["mp4", "webm"], defaultFormat: "mp4", supportedAspects: ["9:16", "16:9"], fps: [30],
    duration: { type: "variable", minSec: 7, maxSec: 28, defaultSec: 16 }, audio: false,
  },
  inputs: { schema: { type: "object" }, examples: [] },
  license: { spdx: "MIT", attributionRequired: false, redistributionAllowed: true, commercialUse: true },
  provenance: { kind: "original", note: "Original Scene Gen cause-and-effect composition." },
  performance: { tier: "light", expectedRenderRatio: 0.35 },
  renderHtml: ({ scene, width, height }) => {
    const items = scene.type === "flow"
      ? scene.steps.map((step) => ({ label: step.label, detail: step.detail }))
      : scene.type === "timeline"
        ? scene.events.map((event) => ({ label: event.date, detail: event.title }))
        : scene.type === "github_pulse"
          ? scene.repos.map((repo) => ({ label: repo.repo, detail: repo.summary }))
          : [];
    const nodes = items.slice(0, 5).map((item, index) =>
      '<article class="df-node df-' + (index % 2 ? 'right' : 'left') + '" style="animation-delay:' + (index * 0.16) + 's">' +
      '<span class="df-dot">' + (index + 1) + '</span><div><b>' + escapeHtml(item.label) + '</b><p>' + escapeHtml(item.detail) + '</p></div></article>'
    ).join('');
    const body = '<main class="hv-main df-main"><div class="df-kicker">LOGIC / PATH</div><h1>' + escapeHtml(sceneHeadline(scene)) + '</h1>' +
      '<section class="df-flow"><i class="df-spine"></i>' + nodes + '</section></main>';
    const css =
      '.df-main{inset:106px 54px 64px}.df-kicker{font-size:24px;font-weight:950;letter-spacing:.14em;color:#fff36a;margin-bottom:18px}' +
      '.df-main h1{font-size:72px;max-width:940px}.df-flow{position:absolute;left:0;right:0;top:245px;bottom:10px;display:grid;grid-template-rows:repeat(5,1fr);align-items:center}' +
      '.df-spine{position:absolute;top:18px;bottom:18px;left:50%;width:6px;transform:translateX(-50%);background:linear-gradient(#fff36a,#72f0ff,#ff8bd7);animation:df-grow 1.2s both;transform-origin:top}' +
      '.df-node{position:relative;width:48%;min-height:164px;padding:24px 26px;display:grid;grid-template-columns:58px 1fr;gap:18px;align-items:center;background:rgba(255,255,255,.15);border:2px solid rgba(255,255,255,.28);box-shadow:0 20px 54px rgba(0,30,86,.18);animation:df-in .55s both}' +
      '.df-left{justify-self:start}.df-right{justify-self:end}.df-dot{width:50px;height:50px;display:grid;place-items:center;background:#fff36a;color:#0847a6;font-weight:950;font-size:22px}' +
      '.df-node b{display:block;font-size:31px;line-height:1.12}.df-node p{font-size:24px;line-height:1.38;margin-top:8px}' +
      '@keyframes df-grow{from{transform:translateX(-50%) scaleY(0)}to{transform:translateX(-50%) scaleY(1)}}' +
      '@keyframes df-in{from{opacity:0;transform:translateY(24px) scale(.96)}to{opacity:1;transform:none}}';
    return commonHtml({ title: sceneHeadline(scene), body, width, height, theme: "blue", extraCss: css });
  },
};
