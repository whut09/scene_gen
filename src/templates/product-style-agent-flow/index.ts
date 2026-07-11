import type { HtmlTemplateDefinition } from "../template.schema";
import { commonHtml, escapeHtml, pacedDelay, sceneHeadline } from "../html-utils";

export const productStyleAgentFlowTemplate: HtmlTemplateDefinition = {
  id: "product-style-agent-flow",
  version: "1.1.0",
  name: "Product Style Agent Flow",
  description: "Clean product-demo style flow for agent, repo and workflow scenes.",
  engine: "html-video",
  category: "workflow",
  subcategory: "step-workflow",
  tags: ["agent", "flow", "github", "product"],
  bestFor: ["agent workflow", "GitHub repo pulse", "product capability chain"],
  notFor: ["long-form documentary", "photo montage"],
  supportedIntents: ["workflow", "repository", "timeline"],
  supportedScenes: ["flow", "github_pulse", "timeline"],
  dataDensity: ["medium", "high"],
  motionFamily: "diagram",
  visualFamily: "scene-gen-editorial-v2",
  variants: [
    { id: "agent-lanes", name: "Agent Lanes", tags: ["agent", "智能体", "子agent", "prompt", "工具"], bestFor: ["multi-agent orchestration"] },
    { id: "step-stack", name: "Step Stack", tags: ["流程", "步骤", "工作流"], bestFor: ["linear workflow"] },
    { id: "capability-grid", name: "Capability Grid", tags: ["能力", "功能", "模型"], bestFor: ["product capabilities"] },
  ],
  output: {
    formats: ["mp4", "webm"],
    defaultFormat: "mp4",
    supportedAspects: ["9:16"],
    fps: [30],
    duration: { type: "variable", minSec: 8, maxSec: 24, defaultSec: 14 },
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
    const items = scene.type === "flow"
      ? scene.steps.map((step) => ({ title: step.label, detail: step.detail }))
      : scene.type === "github_pulse"
        ? scene.repos.map((repo) => ({ title: repo.repo, detail: repo.summary }))
        : scene.type === "timeline"
          ? scene.events.map((event) => ({ title: event.title, detail: event.date + " / " + event.source }))
          : [];
    const cards = items.slice(0, 4).map((item, index) =>
      '<article class="pf-card" style="animation-delay:' + pacedDelay(index, items.length, scene.duration) + 's"><span>' + String(index + 1).padStart(2, "0") + '</span><div><h2>' + escapeHtml(item.title) + '</h2><p>' + escapeHtml(item.detail) + '</p></div></article>'
    ).join('');
    const center = variantId === "agent-lanes" ? '<div class="pf-core"><b>PROMPT</b><span>ORCHESTRATE</span></div>' : '';
    const body = '<main class="hv-main pf-main pf-' + variantId + '"><div class="hv-kicker">SYSTEM / FLOW</div><h1>' + escapeHtml(sceneHeadline(scene)) + '</h1><section class="pf-content">' + cards + center + '</section></main>';
    const css =
      '.pf-main{inset:108px 54px 60px}.pf-main h1{font-size:72px}.pf-content{position:absolute;left:0;right:0;top:250px;bottom:20px}.pf-card{padding:28px;background:rgba(255,255,255,.14);border:2px solid rgba(255,255,255,.27);display:grid;grid-template-columns:68px 1fr;gap:18px;align-items:center;animation:hv-rise .55s both}.pf-card>span{width:54px;height:54px;display:grid;place-items:center;background:#fff36a;color:#0847a6;font-weight:950}.pf-card h2{font-size:36px;line-height:1.15}.pf-card p{font-size:25px;margin-top:10px}' +
      '.pf-step-stack .pf-content{display:grid;grid-template-rows:repeat(4,1fr);gap:18px}' +
      '.pf-capability-grid .pf-content{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:18px}.pf-capability-grid .pf-card{display:flex;flex-direction:column;align-items:flex-start;justify-content:center}.pf-capability-grid .pf-card:nth-child(2){background:rgba(255,243,106,.18)}.pf-capability-grid .pf-card:nth-child(3){background:rgba(255,139,215,.16)}' +
      '.pf-agent-lanes .pf-content{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:92px 120px;padding:36px 0}.pf-agent-lanes .pf-card{position:relative}.pf-agent-lanes .pf-card:nth-child(odd)::after{content:"";position:absolute;right:-62px;top:50%;width:60px;height:4px;background:#72f0ff}.pf-agent-lanes .pf-card:nth-child(even)::after{content:"";position:absolute;left:-62px;top:50%;width:60px;height:4px;background:#72f0ff}.pf-core{position:absolute;left:50%;top:50%;width:190px;height:190px;transform:translate(-50%,-50%) rotate(45deg);background:#fff36a;color:#083b78;display:grid;place-items:center;align-content:center;z-index:4;box-shadow:0 0 50px rgba(255,243,106,.3)}.pf-core>*{transform:rotate(-45deg)}.pf-core b{font-size:29px}.pf-core span{font-size:15px;font-weight:900;margin-top:8px}';
    return commonHtml({ title: sceneHeadline(scene), body, width, height, durationSec: scene.duration, theme: "dark", extraCss: css });
  },
};
