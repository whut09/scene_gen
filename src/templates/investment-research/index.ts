import type { HtmlTemplateDefinition } from "../template.schema";
import { commonHtml, escapeHtml, headlineFontSize, pacedDelay, projectSourceUrl, sceneHeadline } from "../html-utils";

function sceneItems(scene: Parameters<HtmlTemplateDefinition["renderHtml"]>[0]["scene"]) {
  if (scene.type === "briefing_points") return scene.points.map((detail, index) => ({ label: scene.metrics[index]?.label ?? `研究 ${index + 1}`, detail }));
  if (scene.type === "signal_chart") return scene.bars.map((bar) => ({ label: bar.label, detail: bar.detail, value: bar.value }));
  if (scene.type === "flow") return scene.steps.map((step) => ({ label: step.label, detail: step.detail }));
  if (scene.type === "github_pulse") return scene.repos.map((repo) => ({ label: repo.repo, detail: repo.summary, value: repo.score }));
  if (scene.type === "outro") return scene.bullets.map((detail, index) => ({ label: `结论 ${index + 1}`, detail }));
  return [];
}

export const investmentResearchTemplate: HtmlTemplateDefinition = {
  id: "investment-research",
  version: "1.1.0",
  name: "Investment Research Desk",
  description: "Shareholder-letter typography, market tape and animated thesis cards for finance and research projects.",
  engine: "html-video",
  category: "editorial",
  subcategory: "investment-desk",
  tags: ["investment", "finance", "research", "value", "valuation", "buffett", "投资", "投研", "估值", "巴菲特", "芒格", "公司"],
  bestFor: ["investment framework", "research workflow", "financial evidence", "multi-viewpoint thesis"],
  notFor: ["photo showcase", "raw screenshot", "casual entertainment"],
  supportedIntents: ["hook", "briefing", "comparison", "workflow", "repository", "summary"],
  supportedScenes: ["title", "briefing_points", "signal_chart", "flow", "github_pulse", "outro"],
  dataDensity: ["medium", "high"],
  motionFamily: "editorial",
  visualFamily: "scene-gen-investment-v1",
  variants: [
    { id: "shareholder-letter", name: "Shareholder Letter", tags: ["价值", "巴菲特", "框架", "方法论"], bestFor: ["research principles"] },
    { id: "market-tape", name: "Market Tape", tags: ["收益", "指数", "数据", "对比", "规模"], bestFor: ["numeric comparison"] },
    { id: "thesis-war-room", name: "Thesis War Room", tags: ["流程", "团队", "agent", "视角", "研究"], bestFor: ["multi-agent workflow"] },
    { id: "verdict-ledger", name: "Verdict Ledger", tags: ["结论", "纪律", "风险", "清单"], bestFor: ["decision summary"] },
  ],
  output: {
    formats: ["mp4", "webm"], defaultFormat: "mp4", supportedAspects: ["9:16", "16:9"], fps: [30],
    duration: { type: "variable", minSec: 8, maxSec: 30, defaultSec: 18 }, audio: false,
  },
  inputs: { schema: { type: "object" }, examples: [] },
  license: { spdx: "MIT", attributionRequired: false, redistributionAllowed: true, commercialUse: true },
  provenance: { kind: "original", note: "Original Scene Gen investment editorial composition." },
  performance: { tier: "standard", expectedRenderRatio: 0.42 },
  renderHtml: ({ project, scene, width, height, variantId }) => {
    const items = sceneItems(scene).slice(0, 5);
    const title = sceneHeadline(scene);
    const repoUrl = projectSourceUrl(project);
    const visibleRepoUrl = scene.type === "title" ? "" : repoUrl;
    const cards = items.map((item, index) => {
      const delay = pacedDelay(index, items.length, scene.duration, 1.1);
      const showMetric = scene.type === "github_pulse" && "value" in item && typeof item.value === "number";
      const value = showMetric ? `<em>${escapeHtml(item.value)}</em>` : `<em>0${index + 1}</em>`;
      return `<article class="ir-card" style="--i:${index};animation-delay:${delay}s">${value}<div><b>${escapeHtml(item.label)}</b><p>${escapeHtml(item.detail)}</p></div><i></i></article>`;
    }).join("");
    const variantClass = `ir-${variantId}`;
    const titleScene = scene.type === "title";
    const cover = titleScene ? `<section class="ir-cover"><div class="ir-seal ir-s1">巴菲特</div><div class="ir-seal ir-s2">芒格</div><div class="ir-seal ir-s3">段永平</div><div class="ir-seal ir-s4">李录</div><p>${escapeHtml(scene.subhead)}</p><blockquote>PRICE IS WHAT YOU PAY<br/>VALUE IS WHAT YOU GET</blockquote></section>` : `<section class="ir-board">${cards}</section>`;
    const body = `<main class="hv-main ir-main ${variantClass} ${titleScene ? "ir-title-cover" : ""}">
      <header class="ir-header ${visibleRepoUrl ? "ir-repo-header" : ""}"><span>${visibleRepoUrl ? escapeHtml(visibleRepoUrl) : "RESEARCH / PROJECT MEMO"}</span><time>VALUE × AI</time></header>
      <h1 style="font-size:${headlineFontSize(title, 78, 58)}px">${escapeHtml(title)}</h1>
      <div class="ir-rule"><i></i></div>
      ${cover}
      <footer class="ir-tape"><div>BUSINESS QUALITY　MOAT　MANAGEMENT　VALUATION　MARGIN OF SAFETY　INVERSION　DISCIPLINE　BUSINESS QUALITY　MOAT　MANAGEMENT　VALUATION　</div></footer>
    </main>`;
    const css = `
      .hv-root{background:linear-gradient(150deg,#f6f0df 0%,#eef3e8 54%,#dfe9df 100%);color:#173b2d}
      .hv-root::before{opacity:.1;background-image:linear-gradient(rgba(23,59,45,.12) 1px,transparent 1px),linear-gradient(90deg,rgba(23,59,45,.09) 1px,transparent 1px)}
      .hv-root::after{background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent)}
      .ir-main{position:absolute;top:var(--safe-top);bottom:var(--safe-bottom)}
      .ir-header{display:flex;justify-content:space-between;border-top:5px solid #173b2d;border-bottom:1px solid rgba(23,59,45,.35);padding:17px 0 14px;font:900 21px/1.1 Georgia,"Microsoft YaHei",serif;letter-spacing:.09em;color:#b33b34}
      .ir-header time{color:#173b2d}.ir-repo-header span{font-size:26px;line-height:1.2;letter-spacing:.02em;overflow-wrap:anywhere;max-width:680px}.ir-main h1{font-family:Georgia,"Songti SC","SimSun",serif;line-height:1.09;letter-spacing:0;color:#173b2d;margin:38px 0 22px;max-width:820px;text-shadow:none}
      .ir-rule{height:7px;background:rgba(23,59,45,.13);overflow:hidden}.ir-rule i{display:block;height:100%;width:38%;background:#b33b34;animation:ir-rule calc(var(--scene-duration)*.78) ease-in-out both}
      .ir-board{position:absolute;left:0;right:0;top:300px;bottom:92px;display:grid;grid-template-columns:1fr 1fr;grid-auto-rows:1fr;gap:18px}
      .ir-title-cover h1{font-size:68px!important;line-height:1.04;max-width:800px;margin-top:72px}.ir-title-cover .ir-rule{margin-top:18px}.ir-cover{position:absolute;inset:430px 0 80px}.ir-cover p{font:900 34px/1.4 "Microsoft YaHei",sans-serif;color:#b33b34;max-width:650px}.ir-cover blockquote{position:absolute;left:0;bottom:170px;margin:0;padding:28px 0 28px 30px;border-left:8px solid #b33b34;font:italic 800 34px/1.35 Georgia,serif;color:#173b2d;letter-spacing:.04em}.ir-seal{position:absolute;width:142px;height:142px;display:grid;place-items:center;border:4px double #b33b34;border-radius:50%;color:#b33b34;font:900 24px/1 "Songti SC",serif;background:rgba(246,240,223,.78);box-shadow:0 16px 40px rgba(84,45,35,.12);opacity:0;animation:ir-seal-in .8s cubic-bezier(.2,.8,.2,1) both}.ir-s1{right:20px;top:20px;animation-delay:1.1s}.ir-s2{right:185px;top:150px;animation-delay:2.7s}.ir-s3{right:20px;top:285px;animation-delay:4.3s}.ir-s4{right:185px;top:420px;animation-delay:5.9s}
      .ir-card{position:relative;display:grid;grid-template-columns:70px 1fr;gap:18px;padding:28px 24px;background:rgba(255,255,255,.64);border-top:3px solid #173b2d;border-bottom:1px solid rgba(23,59,45,.2);box-shadow:0 18px 50px rgba(44,68,49,.1);overflow:hidden;opacity:0;animation:ir-in .7s cubic-bezier(.2,.75,.25,1) both}
      .ir-card:nth-child(3n){grid-column:1/-1}.ir-card em{font:italic 800 29px/1 Georgia,serif;color:#b33b34}.ir-card b{display:block;font:900 31px/1.16 "Microsoft YaHei",sans-serif;color:#173b2d}.ir-card p{font-size:24px;line-height:1.42;color:#415c50;margin:12px 0 0}.ir-card i{position:absolute;left:0;bottom:0;height:5px;width:100%;background:linear-gradient(90deg,#b33b34,#d7a63b,#2d7560);transform:scaleX(0);transform-origin:left;animation:ir-progress 3.6s calc(1.5s + var(--i)*1.1s) ease-out forwards}
      .ir-tape{position:absolute;left:0;right:0;bottom:0;height:54px;overflow:hidden;border-top:2px solid #173b2d;border-bottom:2px solid #173b2d;color:#f6f0df;background:#173b2d;font:900 19px/54px ui-monospace,monospace;letter-spacing:.08em;white-space:nowrap}.ir-tape div{width:max-content;animation:ir-ticker calc(var(--scene-duration)*1.2) linear infinite}
      .ir-market-tape .ir-card{border-top-color:#b33b34}.ir-market-tape .ir-card em{font-size:42px}.ir-thesis-war-room .ir-board{grid-template-columns:1fr}.ir-thesis-war-room .ir-card{grid-template-columns:82px 1fr;min-height:130px}.ir-thesis-war-room .ir-card:nth-child(3n){grid-column:auto}.ir-verdict-ledger .ir-card{background:#173b2d}.ir-verdict-ledger .ir-card b,.ir-verdict-ledger .ir-card p{color:#f6f0df}.ir-verdict-ledger .ir-card em{color:#f1c862}
      @keyframes ir-seal-in{from{opacity:0;transform:scale(1.5) rotate(-18deg)}to{opacity:1;transform:scale(1) rotate(0)}}
      @keyframes ir-in{from{opacity:0;transform:translateY(36px) rotate(.8deg)}to{opacity:1;transform:none}}
      @keyframes ir-rule{from{transform:translateX(-105%)}to{transform:translateX(265%)}}
      @keyframes ir-progress{to{transform:scaleX(1)}}
      @keyframes ir-ticker{from{transform:translateX(0)}to{transform:translateX(-50%)}}
    `;
    return commonHtml({ title, body, width, height, durationSec: scene.duration, theme: "paper", extraCss: css });
  },
};