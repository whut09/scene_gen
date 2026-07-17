import type { HtmlTemplateDefinition } from "../template.schema";
import { commonHtml, escapeHtml, headlineFontSize, pacedDelay, sceneHeadline } from "../html-utils";

export const decisionFlowTemplate: HtmlTemplateDefinition = {
  id: "decision-flow",
  version: "1.2.0",
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
  variants: [
    { id: "causal-spine", name: "Causal Spine", tags: ["影响", "路径", "因果", "流程"], bestFor: ["cause and effect"] },
    { id: "agent-branch", name: "Agent Branch", tags: ["agent", "智能体", "子agent", "协作", "编排"], bestFor: ["multi-agent branching"] },
    { id: "timeline-ladder", name: "Timeline Ladder", tags: ["时间", "历史", "发布", "演进"], bestFor: ["chronological story"] },
  ],
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
      '<article class="df-node df-' + (index % 2 ? 'right' : 'left') + '" style="animation-delay:' + pacedDelay(index, items.length, scene.duration) + 's">' +
      '<span class="df-dot">' + (index + 1) + '</span><div><b>' + escapeHtml(item.label) + '</b><p>' + escapeHtml(item.detail) + '</p></div></article>'
    ).join('');
    const rowCount = Math.max(1, Math.min(items.length, 5));
    const titleSize = headlineFontSize(sceneHeadline(scene), 72, 50);
    const body = '<main class="hv-main df-main"><div class="df-kicker">LOGIC / PATH</div><h1>' + escapeHtml(sceneHeadline(scene)) + '</h1>' +
      '<section class="df-flow"><i class="df-spine"></i>' + nodes + '</section></main>';
    const css =
      '.df-main{inset:106px 54px 64px;display:flex;flex-direction:column;min-height:0}.df-kicker{font-size:24px;font-weight:950;letter-spacing:.14em;color:#fff36a;margin-bottom:18px;flex:0 0 auto}' +
      '.df-main h1{font-size:' + titleSize + 'px;max-width:940px;flex:0 0 auto}.df-flow{position:relative;left:auto;right:auto;top:auto;bottom:auto;display:grid;grid-template-rows:repeat(' + rowCount + ',minmax(0,1fr));align-items:center;gap:14px;flex:1;min-height:0;margin-top:28px}' +
      '.df-spine{position:absolute;top:18px;bottom:18px;left:50%;width:6px;transform:translateX(-50%);background:linear-gradient(#fff36a,#72f0ff,#ff8bd7);animation:df-grow 1.2s both;transform-origin:top}' +
      '.df-node{position:relative;width:48%;height:100%;min-height:0;max-height:220px;padding:20px 24px;display:grid;grid-template-columns:54px minmax(0,1fr);gap:16px;align-items:center;background:rgba(255,255,255,.15);border:2px solid rgba(255,255,255,.28);box-shadow:0 20px 54px rgba(0,30,86,.18);animation:df-in .55s both;overflow:hidden}' +
      '.df-left{justify-self:start}.df-right{justify-self:end}.df-dot{width:50px;height:50px;display:grid;place-items:center;background:#fff36a;color:#0847a6;font-weight:950;font-size:22px}' +
      '.df-node b{display:block;font-size:29px;line-height:1.12}.df-node p{font-size:22px;line-height:1.34;margin-top:7px}' +
      '.df-node{animation:df-in .55s both,df-signal 6.8s infinite}.df-node:nth-of-type(3){animation-delay:0s,1.7s}.df-node:nth-of-type(4){animation-delay:0s,3.4s}.df-node:nth-of-type(5){animation-delay:0s,5.1s}.df-dot{animation:df-dot-pulse 3.4s infinite alternate}@keyframes df-signal{0%,60%,100%{border-color:rgba(255,255,255,.28);box-shadow:0 20px 54px rgba(0,30,86,.18)}72%,84%{border-color:rgba(255,243,106,.9);box-shadow:0 22px 70px rgba(255,243,106,.2)}}@keyframes df-dot-pulse{from{filter:brightness(1)}to{filter:brightness(1.18);box-shadow:0 0 24px rgba(255,243,106,.38)}}' +
      '@keyframes df-grow{from{transform:translateX(-50%) scaleY(0)}to{transform:translateX(-50%) scaleY(1)}}' +
      '@keyframes df-in{from{opacity:0;transform:translateY(24px) scale(.96)}to{opacity:1;transform:none}}';
    return commonHtml({ title: sceneHeadline(scene), body, width, height, durationSec: scene.duration, theme: "blue", extraCss: css });
  },
};
